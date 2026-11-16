import { describe, expect, it } from "bun:test";
import { Degroshi } from "../../src/client";
import { ConflictError, NotFoundError, RateLimitError } from "../../src/errors";

type Handler = (request: Request) => Response | Promise<Response>;

function client(handler: Handler, options: { spaceId?: string } = {}) {
  const seen: Request[] = [];
  const degroshi = new Degroshi({
    apiKey: "dg_pat_test",
    spaceId: options.spaceId,
    baseUrl: "https://api.test",
    maxRetries: 0,
    fetch: async (input: RequestInfo | URL) => {
      const request = input as Request;
      seen.push(request.clone());
      return handler(request);
    },
  });
  return { degroshi, seen };
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("Degroshi", () => {
  it("sends the key, the space and the SDK version, and unwraps the envelope", async () => {
    // Arrange
    const { degroshi, seen } = client(
      () => json({ success: true, data: [{ id: "a1", name: "Картка" }] }),
      { spaceId: "s1" },
    );

    // Act
    const actual = await degroshi.accounts.list();

    // Assert
    expect(actual).toEqual([{ id: "a1", name: "Картка" }] as never);
    expect(seen[0]!.headers.get("X-API-Key")).toBe("dg_pat_test");
    expect(seen[0]!.headers.get("X-Space-ID")).toBe("s1");
    expect(seen[0]!.headers.get("X-Degroshi-SDK")).toMatch(/^js\//);
  });

  it("throws a typed error with the API's code and correlation id", async () => {
    // Arrange
    const { degroshi } = client(() =>
      json(
        {
          success: false,
          error: {
            code: "TXN_001",
            message: "not found",
            correlation_id: "c-1",
          },
        },
        404,
      ),
    );

    // Act
    const actual = await degroshi.transactions
      .get("missing")
      .catch((error: unknown) => error);

    // Assert
    expect(actual).toBeInstanceOf(NotFoundError);
    expect((actual as NotFoundError).code).toBe("TXN_001");
    expect((actual as NotFoundError).correlationId).toBe("c-1");
  });

  it("reads Retry-After on a 429", async () => {
    // Arrange
    const { degroshi } = client(() =>
      json(
        { success: false, error: { code: "RATE_001", message: "slow down" } },
        429,
        { "Retry-After": "7" },
      ),
    );

    // Act
    const actual = await degroshi.accounts
      .list()
      .catch((error: unknown) => error);

    // Assert
    expect(actual).toBeInstanceOf(RateLimitError);
    expect((actual as RateLimitError).retryAfterSeconds).toBe(7);
  });

  it("sends an Idempotency-Key on creates and If-Match on edits", async () => {
    // Arrange
    const { degroshi, seen } = client((request) =>
      request.method === "PATCH"
        ? json(
            {
              success: false,
              error: { code: "SYNC_PRECONDITION_FAILED", message: "changed" },
            },
            412,
          )
        : json({ success: true, data: { id: "t1", amount: "10.00" } }, 201),
    );

    // Act
    await degroshi.transactions.create({
      account_id: "a1",
      amount: "10.00",
      type: "expense",
    } as never);
    await degroshi.transactions.create(
      { account_id: "a1", amount: "10.00", type: "expense" } as never,
      { idempotencyKey: "mine" },
    );
    const actual = await degroshi.transactions
      .update("t1", { note: "кава" } as never, { ifMatch: 3 })
      .catch((error: unknown) => error);

    // Assert
    expect(seen[0]!.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]!.headers.get("Idempotency-Key")).toBe("mine");
    expect(seen[2]!.headers.get("If-Match")).toBe("3");
    expect(actual).toBeInstanceOf(ConflictError);
  });

  it("sends no If-Match for a row without a version", async () => {
    // Arrange: a response row may carry `version: null`.
    const { degroshi, seen } = client(() =>
      json({ success: true, data: { deleted: true } }),
    );

    // Act
    await degroshi.transactions.delete("t1", { ifMatch: null });
    await degroshi.transactions.delete("t1", {});

    // Assert
    expect(seen[0]!.headers.get("If-Match")).toBeNull();
    expect(seen[1]!.headers.get("If-Match")).toBeNull();
  });

  it("iterates transactions page by page until has_next is false", async () => {
    // Arrange
    const { degroshi, seen } = client((request) => {
      const page = Number(new URL(request.url).searchParams.get("page"));
      return json({
        success: true,
        data: [{ id: `t${page}` }],
        meta: {
          page,
          per_page: 1,
          total: 2,
          total_pages: 2,
          has_next: page < 2,
          has_prev: page > 1,
        },
      });
    });

    // Act
    const actual: string[] = [];
    for await (const transaction of degroshi.transactions.iterate({
      per_page: 1,
    }))
      actual.push(transaction.id);

    // Assert
    expect(actual).toEqual(["t1", "t2"]);
    expect(seen).toHaveLength(2);
  });

  it("iterates events with starting_after while has_more is true", async () => {
    // Arrange
    const { degroshi } = client((request) => {
      const after = new URL(request.url).searchParams.get("starting_after");
      return after
        ? json({
            success: true,
            data: [{ id: "e1", type: "transaction.created" }],
            meta: { has_more: false },
          })
        : json({
            success: true,
            data: [{ id: "e2", type: "transaction.updated" }],
            meta: { has_more: true },
          });
    });

    // Act
    const actual: string[] = [];
    for await (const event of degroshi.events.iterate()) actual.push(event.id);

    // Assert
    expect(actual).toEqual(["e2", "e1"]);
  });

  it("reads the change feed page after page and keeps where to start next time", async () => {
    // Arrange
    const { degroshi, seen } = client((request) => {
      const cursor = new URL(request.url).searchParams.get("cursor");
      return cursor === "c1"
        ? json({
            success: true,
            data: {
              items: [{ type: "transaction", id: "t2", op: "delete" }],
              next_cursor: "c2",
              has_more: false,
            },
          })
        : json({
            success: true,
            data: {
              items: [
                {
                  type: "transaction",
                  id: "t1",
                  op: "upsert",
                  data: { id: "t1" },
                },
              ],
              next_cursor: "c1",
              has_more: true,
            },
          });
    });

    // Act
    const feed = degroshi.changes.iterate({ types: ["transaction"] });
    const actual: string[] = [];
    for await (const change of feed) actual.push(`${change.op}:${change.id}`);

    // Assert
    expect(actual).toEqual(["upsert:t1", "delete:t2"]);
    expect(feed.cursor).toBe("c2");
    expect(new URL(seen[0]!.url).searchParams.get("cursor")).toBeNull();
    expect(new URL(seen[1]!.url).searchParams.get("types")).toBe("transaction");
  });

  it("stays at the start of an unfinished page when the loop stops early", async () => {
    // Arrange
    const { degroshi } = client(() =>
      json({
        success: true,
        data: {
          items: [
            { type: "account", id: "a1", op: "upsert", data: {} },
            { type: "account", id: "a2", op: "upsert", data: {} },
          ],
          next_cursor: "c9",
          has_more: false,
        },
      }),
    );

    // Act
    const feed = degroshi.changes.iterate({ cursor: "c8" });
    for await (const change of feed) if (change.id === "a1") break;

    // Assert: reading again from c8 repeats a1 and a2 at most, never skips a2.
    expect(feed.cursor).toBe("c8");
  });

  it("treats a retried delete that finds nothing as done", async () => {
    // Arrange
    const answers = [
      json({ success: false }, 503, { "Retry-After": "0" }),
      json({ success: false, error: { code: "TXN_001" } }, 404),
    ];
    const seen: Request[] = [];
    const degroshi = new Degroshi({
      apiKey: "dg_pat_test",
      baseUrl: "https://api.test",
      maxRetries: 1,
      fetch: async (input: RequestInfo | URL) => {
        seen.push(input as Request);
        return answers.shift() ?? json({}, 500);
      },
    });

    // Act
    const actual = await degroshi.transactions.delete("t1");

    // Assert
    expect(actual).toBeUndefined();
    expect(seen.map((request) => request.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("creates a webhook without an Idempotency-Key and pages its deliveries by next_cursor", async () => {
    // Arrange
    const { degroshi, seen } = client((request) => {
      const url = new URL(request.url);
      if (request.method === "POST") {
        return json(
          {
            success: true,
            data: { endpoint: { id: "w1" }, secret: "dg_whsec_x" },
          },
          201,
        );
      }
      return url.searchParams.get("cursor")
        ? json({
            success: true,
            data: [{ id: "d1" }],
            meta: { has_more: false },
          })
        : json({
            success: true,
            data: [{ id: "d2" }],
            meta: { has_more: true, next_cursor: "c2" },
          });
    });

    // Act
    const created = await degroshi.webhooks.create({
      url: "https://hooks.example.com/degroshi",
      events: ["account.balance.updated"],
    });
    const actual: string[] = [];
    for await (const delivery of degroshi.webhooks.iterateDeliveries("w1"))
      actual.push(delivery.id);

    // Assert
    expect(created.secret).toBe("dg_whsec_x");
    expect(seen[0]!.headers.get("Idempotency-Key")).toBeNull();
    expect(new URL(seen[0]!.url).pathname).toBe("/v1/webhooks");
    expect(actual).toEqual(["d2", "d1"]);
    expect(new URL(seen[2]!.url).searchParams.get("cursor")).toBe("c2");
  });

  it("needs a key", () => {
    expect(() => new Degroshi({ apiKey: "" })).toThrow(/apiKey/);
  });
});

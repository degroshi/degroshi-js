import { describe, expect, it } from "bun:test"
import { Degroshi } from "../../src/client"
import { ConflictError, NotFoundError, RateLimitError } from "../../src/errors"

type Handler = (request: Request) => Response | Promise<Response>

function client(handler: Handler, options: { spaceId?: string } = {}) {
  const seen: Request[] = []
  const degroshi = new Degroshi({
    apiKey: "dg_pat_test",
    spaceId: options.spaceId,
    baseUrl: "https://api.test",
    maxRetries: 0,
    fetch: async (input: RequestInfo | URL) => {
      const request = input as Request
      seen.push(request.clone())
      return handler(request)
    },
  })
  return { degroshi, seen }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })

describe("Degroshi", () => {
  it("sends the key, the space and the SDK version, and unwraps the envelope", async () => {
    // Arrange
    const { degroshi, seen } = client(() => json({ success: true, data: [{ id: "a1", name: "Картка" }] }), { spaceId: "s1" })

    // Act
    const actual = await degroshi.accounts.list()

    // Assert
    expect(actual).toEqual([{ id: "a1", name: "Картка" }] as never)
    expect(seen[0]!.headers.get("X-API-Key")).toBe("dg_pat_test")
    expect(seen[0]!.headers.get("X-Space-ID")).toBe("s1")
    expect(seen[0]!.headers.get("X-Degroshi-SDK")).toMatch(/^js\//)
  })

  it("throws a typed error with the API's code and correlation id", async () => {
    // Arrange
    const { degroshi } = client(() =>
      json({ success: false, error: { code: "TXN_001", message: "not found", correlation_id: "c-1" } }, 404)
    )

    // Act
    const actual = await degroshi.transactions.get("missing").catch((error: unknown) => error)

    // Assert
    expect(actual).toBeInstanceOf(NotFoundError)
    expect((actual as NotFoundError).code).toBe("TXN_001")
    expect((actual as NotFoundError).correlationId).toBe("c-1")
  })

  it("reads Retry-After on a 429", async () => {
    // Arrange
    const { degroshi } = client(() =>
      json({ success: false, error: { code: "RATE_001", message: "slow down" } }, 429, { "Retry-After": "7" })
    )

    // Act
    const actual = await degroshi.accounts.list().catch((error: unknown) => error)

    // Assert
    expect(actual).toBeInstanceOf(RateLimitError)
    expect((actual as RateLimitError).retryAfterSeconds).toBe(7)
  })

  it("sends an Idempotency-Key on creates and If-Match on edits", async () => {
    // Arrange
    const { degroshi, seen } = client((request) =>
      request.method === "PATCH"
        ? json({ success: false, error: { code: "SYNC_PRECONDITION_FAILED", message: "changed" } }, 412)
        : json({ success: true, data: { id: "t1", amount: "10.00" } }, 201)
    )

    // Act
    await degroshi.transactions.create({ account_id: "a1", amount: "10.00", type: "expense" } as never)
    await degroshi.transactions.create({ account_id: "a1", amount: "10.00", type: "expense" } as never, { idempotencyKey: "mine" })
    const actual = await degroshi.transactions.update("t1", { note: "кава" } as never, { ifMatch: 3 }).catch((error: unknown) => error)

    // Assert
    expect(seen[0]!.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen[1]!.headers.get("Idempotency-Key")).toBe("mine")
    expect(seen[2]!.headers.get("If-Match")).toBe("3")
    expect(actual).toBeInstanceOf(ConflictError)
  })

  it("sends no If-Match for a row without a version", async () => {
    // Arrange: a response row may carry `version: null`.
    const { degroshi, seen } = client(() => json({ success: true, data: { deleted: true } }))

    // Act
    await degroshi.transactions.delete("t1", { ifMatch: null })
    await degroshi.transactions.delete("t1", {})

    // Assert
    expect(seen[0]!.headers.get("If-Match")).toBeNull()
    expect(seen[1]!.headers.get("If-Match")).toBeNull()
  })

  it("iterates transactions page by page until has_next is false", async () => {
    // Arrange
    const { degroshi, seen } = client((request) => {
      const page = Number(new URL(request.url).searchParams.get("page"))
      return json({
        success: true,
        data: [{ id: `t${page}` }],
        meta: { page, per_page: 1, total: 2, total_pages: 2, has_next: page < 2, has_prev: page > 1 },
      })
    })

    // Act
    const actual: string[] = []
    for await (const transaction of degroshi.transactions.iterate({ per_page: 1 })) actual.push(transaction.id)

    // Assert
    expect(actual).toEqual(["t1", "t2"])
    expect(seen).toHaveLength(2)
  })

  it("iterates events with starting_after while has_more is true", async () => {
    // Arrange
    const { degroshi } = client((request) => {
      const after = new URL(request.url).searchParams.get("starting_after")
      return after
        ? json({ success: true, data: [{ id: "e1", type: "transaction.created" }], meta: { has_more: false } })
        : json({ success: true, data: [{ id: "e2", type: "transaction.updated" }], meta: { has_more: true } })
    })

    // Act
    const actual: string[] = []
    for await (const event of degroshi.events.iterate()) actual.push(event.id)

    // Assert
    expect(actual).toEqual(["e2", "e1"])
  })

  it("needs a key", () => {
    expect(() => new Degroshi({ apiKey: "" })).toThrow(/apiKey/)
  })
})

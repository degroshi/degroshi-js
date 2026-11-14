import { describe, expect, it } from "bun:test"
import { ApiConnectionError } from "../../src/errors"
import { isRetrySafe, RETRIED_DELETE_HEADER, retryDelayMs, retryingFetch } from "../../src/retry"

const noSleep = async () => {}

function sequence(...answers: Array<Response | Error>) {
  const seen: Request[] = []
  const fake = async (input: RequestInfo | URL) => {
    seen.push(input as Request)
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next ?? new Response("{}", { status: 200 })
  }
  return { fake, seen }
}

describe("retryingFetch", () => {
  it("retries a read after a 503 and returns the answer", async () => {
    // Arrange
    const { fake, seen } = sequence(new Response("", { status: 503 }), new Response('{"ok":true}', { status: 200 }))
    const wrapped = retryingFetch(fake, { maxRetries: 2, timeoutMs: 1000, sleep: noSleep })

    // Act
    const actual = await wrapped(new Request("https://api.test/v1/accounts"))

    // Assert
    expect(actual.status).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it("never repeats a POST without an Idempotency-Key", async () => {
    // Arrange
    const { fake, seen } = sequence(new Response("", { status: 503 }))
    const wrapped = retryingFetch(fake, { maxRetries: 2, timeoutMs: 1000, sleep: noSleep })

    // Act
    const actual = await wrapped(new Request("https://api.test/v1/transactions", { method: "POST", body: "{}" }))

    // Assert
    expect(actual.status).toBe(503)
    expect(seen).toHaveLength(1)
  })

  it("repeats a keyed POST with the same body and key", async () => {
    // Arrange
    const { fake, seen } = sequence(new Error("socket hang up"), new Response("{}", { status: 201 }))
    const wrapped = retryingFetch(fake, { maxRetries: 2, timeoutMs: 1000, sleep: noSleep })
    const request = new Request("https://api.test/v1/transactions", {
      method: "POST",
      body: '{"amount":"10.00"}',
      headers: { "Idempotency-Key": "k-1" },
    })

    // Act
    const actual = await wrapped(request)

    // Assert
    expect(actual.status).toBe(201)
    expect(seen).toHaveLength(2)
    expect(await seen[1]!.text()).toBe('{"amount":"10.00"}')
    expect(seen[1]!.headers.get("Idempotency-Key")).toBe("k-1")
  })

  it("gives up after the retries with a connection error", async () => {
    // Arrange
    const { fake } = sequence(new Error("down"), new Error("down"), new Error("down"))
    const wrapped = retryingFetch(fake, { maxRetries: 2, timeoutMs: 1000, sleep: noSleep })

    // Act
    const actual = await wrapped(new Request("https://api.test/v1/accounts")).catch((error: unknown) => error)

    // Assert
    expect(actual).toBeInstanceOf(ApiConnectionError)
  })

  it("doesn't retry a 400", async () => {
    // Arrange
    const { fake, seen } = sequence(new Response("{}", { status: 400 }))
    const wrapped = retryingFetch(fake, { maxRetries: 2, timeoutMs: 1000, sleep: noSleep })

    // Act
    await wrapped(new Request("https://api.test/v1/accounts"))

    // Assert
    expect(seen).toHaveLength(1)
  })

  it.each([
    ["a 503", new Response("", { status: 503 })],
    ["a dropped connection", new TypeError("fetch failed")],
  ])("answers 204 for a DELETE retried after %s that finds nothing", async (_, inputFirst) => {
    // Arrange
    const { fake, seen } = sequence(inputFirst, new Response('{"success":false}', { status: 404 }))
    const wrapped = retryingFetch(fake, { maxRetries: 2, timeoutMs: 1000, sleep: noSleep })

    // Act
    const actual = await wrapped(new Request("https://api.test/v1/transactions/t1", { method: "DELETE" }))

    // Assert
    expect(actual.status).toBe(204)
    expect(actual.headers.get(RETRIED_DELETE_HEADER)).toBe("true")
    expect(await actual.text()).toBe("")
    expect(seen).toHaveLength(2)
  })

  it("keeps the 404 of a DELETE that finds nothing on its first try", async () => {
    // Arrange
    const { fake, seen } = sequence(new Response('{"success":false}', { status: 404 }))
    const wrapped = retryingFetch(fake, { maxRetries: 2, timeoutMs: 1000, sleep: noSleep })

    // Act
    const actual = await wrapped(new Request("https://api.test/v1/transactions/t1", { method: "DELETE" }))

    // Assert
    expect(actual.status).toBe(404)
    expect(seen).toHaveLength(1)
  })
})

describe("retryDelayMs", () => {
  it("honours Retry-After in seconds, capped at a minute", () => {
    expect(retryDelayMs(1, new Response("", { status: 429, headers: { "Retry-After": "3" } }))).toBe(3000)
    expect(retryDelayMs(1, new Response("", { status: 429, headers: { "Retry-After": "600" } }))).toBe(60_000)
  })

  it("backs off with jitter otherwise", () => {
    expect(retryDelayMs(1, undefined, () => 0.5)).toBe(500)
    expect(retryDelayMs(3, undefined, () => 0.5)).toBe(2000)
    expect(retryDelayMs(10, undefined, () => 0.5)).toBe(8000)
  })
})

describe("isRetrySafe", () => {
  it.each([
    ["GET", false, true],
    ["DELETE", false, true],
    ["POST", false, false],
    ["POST", true, true],
    ["PATCH", false, false],
  ])("%s with a key: %s → %s", (method, hasKey, expected) => {
    const headers: Record<string, string> = hasKey ? { "Idempotency-Key": "k" } : {}
    expect(isRetrySafe(new Request("https://api.test/x", { method: method as string, headers }))).toBe(expected as boolean)
  })
})

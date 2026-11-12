// Against a running API: DEGROSHI_SMOKE_API_URL, DEGROSHI_SMOKE_API_KEY (a full-access token) and
// DEGROSHI_SMOKE_SPACE_ID. Writes one transaction to a manual account and deletes it. `bun test test/smoke`.
import { describe, expect, it } from "bun:test"
import { Degroshi } from "../../src/index"

const url = process.env.DEGROSHI_SMOKE_API_URL
const apiKey = process.env.DEGROSHI_SMOKE_API_KEY
const spaceId = process.env.DEGROSHI_SMOKE_SPACE_ID

describe.skipIf(!url || !apiKey)("the SDK against the local API", () => {
  const degroshi = new Degroshi({ apiKey, baseUrl: url, spaceId })

  it("lists spaces and accounts", async () => {
    expect((await degroshi.spaces.list()).length).toBeGreaterThan(0)
    expect(Array.isArray(await degroshi.accounts.list())).toBe(true)
  })

  it("creates a transaction once for one key, edits it with If-Match and deletes it", async () => {
    // Arrange: a manual, open account.
    const accounts = await degroshi.accounts.list()
    const account = accounts.find((item) => !item.connection && !item.source && !item.is_closed)
    expect(account).toBeDefined()
    const body = {
      account_id: account!.id,
      amount: "1.23",
      type: "expense" as const,
      transaction_date: new Date().toISOString(),
      description: "SDK smoke",
    }

    // Act
    const first = await degroshi.transactions.create(body as never, { idempotencyKey: `smoke-js-${Date.now()}` })
    const again = await degroshi.transactions.create(body as never, { idempotencyKey: `smoke-js-again-${first.id}` })
    const edited = await degroshi.transactions.update(first.id, { note: "SDK smoke: edited" } as never, {
      ifMatch: first.version,
    })
    await degroshi.transactions.delete(edited.id, { ifMatch: edited.version })
    await degroshi.transactions.delete(again.id)

    // Assert
    expect(first.amount).toBe("1.23")
    expect(again.id).not.toBe(first.id)
    expect(edited.note).toBe("SDK smoke: edited")
  })

  it("replays a create sent twice with the same key", async () => {
    // Arrange
    const accounts = await degroshi.accounts.list()
    const account = accounts.find((item) => !item.connection && !item.source && !item.is_closed)!
    const body = { account_id: account.id, amount: "2.00", type: "expense", transaction_date: new Date().toISOString() }
    const key = `smoke-js-replay-${Date.now()}`

    // Act
    const first = await degroshi.transactions.create(body as never, { idempotencyKey: key })
    const second = await degroshi.transactions.create(body as never, { idempotencyKey: key })
    await degroshi.transactions.delete(first.id)

    // Assert
    expect(second.id).toBe(first.id)
  })

  it("pages through transactions and reads the events", async () => {
    let seen = 0
    for await (const transaction of degroshi.transactions.iterate({ per_page: 2 })) {
      expect(typeof transaction.amount).toBe("string")
      if (++seen >= 5) break
    }
    const events = await degroshi.events.list({ limit: 5 })
    expect(Array.isArray(events.data)).toBe(true)
  })
})

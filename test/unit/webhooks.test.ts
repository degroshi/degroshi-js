import { describe, expect, it } from "bun:test"
import vectors from "../fixtures/webhook-vectors.json"
import { verifyWebhook, WebhookVerificationError } from "../../src/webhooks"

// The vectors come from the API's own webhook signer, so the SDK and the API agree byte for byte.
describe("verifyWebhook against the API's vectors", () => {
  for (const vector of vectors) {
    it(vector.name, async () => {
      // Act
      const actual = verifyWebhook(vector.body, vector.header, vector.secret, { now: vector.now })

      // Assert
      if (vector.expected === "ok") {
        expect((await actual).id ?? null).toEqual(JSON.parse(vector.body).id ?? null)
        return
      }
      const error = await actual.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(WebhookVerificationError)
      expect((error as WebhookVerificationError).reason).toBe(vector.expected as WebhookVerificationError["reason"])
    })
  }

  it("takes the body as bytes too", async () => {
    // Arrange
    const vector = vectors[0]!

    // Act
    const actual = await verifyWebhook(new TextEncoder().encode(vector.body), vector.header, vector.secret, { now: vector.now })

    // Assert
    expect(actual.type).toBe("transaction.created")
  })
})

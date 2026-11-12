import type {
  AccountBalanceUpdatedEvent,
  BudgetThresholdReachedEvent,
  ConnectionStatusChangedEvent,
  ImportCompletedEvent,
  RecurringDueEvent,
  TransactionCreatedEvent,
  TransactionDeletedEvent,
  TransactionUpdatedEvent,
  TransactionsBulkUpdatedEvent,
} from "./generated/types.gen.js"

/** Any event a webhook endpoint receives, by its `type`. */
export type WebhookEvent =
  | TransactionCreatedEvent
  | TransactionUpdatedEvent
  | TransactionDeletedEvent
  | TransactionsBulkUpdatedEvent
  | AccountBalanceUpdatedEvent
  | ConnectionStatusChangedEvent
  | ImportCompletedEvent
  | BudgetThresholdReachedEvent
  | RecurringDueEvent

/** The header that carries the signatures: `t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=...]`. */
export const SIGNATURE_HEADER = "Degroshi-Signature"

/** Why a request failed the check. */
export type WebhookVerificationReason = "malformed" | "too_old" | "bad_signature"

/** The request isn't from Degroshi, or it's too old to trust. */
export class WebhookVerificationError extends Error {
  readonly reason: WebhookVerificationReason

  constructor(reason: WebhookVerificationReason, message: string) {
    super(message)
    this.name = "WebhookVerificationError"
    this.reason = reason
  }
}

export interface VerifyOptions {
  /** How old a signature may be, in seconds (default 300). */
  toleranceSeconds?: number
  /** For tests: the current time in unix seconds. */
  now?: number
}

const encoder = new TextEncoder()

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return undefined
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2))
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bodyText(rawBody: string | Uint8Array | ArrayBuffer): string {
  return typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody)
}

/**
 * Checks a webhook request and returns its event. Pass the body exactly as received, before any JSON parsing, the
 * Degroshi-Signature header and the endpoint's secret. During a secret change either secret's signature is accepted.
 * Uses Web Crypto, so it runs on Node 20+, Bun, Deno and edge runtimes. Throws WebhookVerificationError.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array | ArrayBuffer,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {}
): Promise<WebhookEvent> {
  const parts = (header ?? "").split(",").map((part): [string, string] => {
    const index = part.indexOf("=")
    return index < 0 ? [part.trim(), ""] : [part.slice(0, index).trim(), part.slice(index + 1).trim()]
  })
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1])
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value)
  if (!Number.isInteger(timestamp) || signatures.length === 0) {
    throw new WebhookVerificationError("malformed", `no ${SIGNATURE_HEADER} header, or it has no t and v1`)
  }
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) {
    throw new WebhookVerificationError("too_old", "the signature is too old or from the future")
  }
  const text = bodyText(rawBody)
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ])
  const signed = encoder.encode(`${timestamp}.${text}`)
  for (const signature of signatures) {
    const bytes = hexToBytes(signature)
    // crypto.subtle.verify compares in constant time.
    if (bytes && (await crypto.subtle.verify("HMAC", key, bytes, signed))) {
      return JSON.parse(text) as WebhookEvent
    }
  }
  throw new WebhookVerificationError("bad_signature", "no signature matches the secret")
}

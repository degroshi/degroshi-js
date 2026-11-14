import { ApiConnectionError, ApiTimeoutError, parseRetryAfter } from "./errors.js"

/** fetch's call signature (runtimes add extras like Bun's `preconnect` that a wrapper needn't have). */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface RetryOptions {
  /** Retries after the first try (default 2). */
  maxRetries: number
  /** Time for one try until the answer's headers arrive, in ms (default 60 000). */
  timeoutMs: number
  /** For tests: what waiting does. */
  sleep?: (ms: number) => Promise<void>
}

const RETRIED_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"])
const MAX_DELAY_MS = 8_000
const MAX_RETRY_AFTER_MS = 60_000

/**
 * A request may be sent again when sending it twice can't do anything twice: a read, a PUT or DELETE (the same
 * result each time), or a write carrying an Idempotency-Key (the API returns the first answer).
 */
export function isRetrySafe(request: Request): boolean {
  return SAFE_METHODS.has(request.method.toUpperCase()) || request.headers.has("idempotency-key")
}

/** The wait before retry `attempt` (1-based): Retry-After when the API sends one, else backoff with jitter. */
export function retryDelayMs(attempt: number, response: Response | undefined, random: () => number = Math.random): number {
  const retryAfter = parseRetryAfter(response?.headers.get("retry-after") ?? null)
  if (retryAfter !== undefined) return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
  const base = Math.min(500 * 2 ** (attempt - 1), MAX_DELAY_MS)
  return base * (0.75 + random() * 0.5)
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Set on the 204 that stands in for a retried DELETE's 404. */
export const RETRIED_DELETE_HEADER = "X-Degroshi-Retried-Delete"

/**
 * A DELETE sent again after a lost answer (a dropped connection, a timeout, a 5xx) finds nothing left to delete when
 * the first try already did it. That 404 is the success it stands for: an empty 204 marked with RETRIED_DELETE_HEADER.
 */
function isRetriedDeleteGone(request: Request, attempt: number, response: Response): boolean {
  return attempt > 0 && request.method.toUpperCase() === "DELETE" && response.status === 404
}

function deletedResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.delete("content-type")
  headers.delete("content-length")
  headers.set(RETRIED_DELETE_HEADER, "true")
  return new Response(null, { status: 204, headers })
}

/**
 * Wraps fetch with a timeout per try and retries: network failures, 408, 429 and 5xx, only for requests that are
 * safe to send again (isRetrySafe). Each try sends a fresh clone of the request, so bodies survive. A retried DELETE
 * that finds nothing (404) answers 204: the earlier try deleted it.
 */
export function retryingFetch(baseFetch: FetchFn, options: RetryOptions): FetchFn {
  const sleep = options.sleep ?? defaultSleep
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const original = input instanceof Request && init === undefined ? input : new Request(input, init)
    const retries = isRetrySafe(original) ? options.maxRetries : 0
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(options.timeoutMs)
      const request = new Request(original.clone(), { signal: AbortSignal.any([original.signal, timeout]) })
      let response: Response | undefined
      try {
        response = await baseFetch(request)
      } catch (error) {
        if (original.signal.aborted) throw error
        if (attempt >= retries) throw timeout.aborted ? new ApiTimeoutError(error) : new ApiConnectionError(error)
      }
      if (response && isRetriedDeleteGone(original, attempt, response)) {
        await response.body?.cancel()
        return deletedResponse(response)
      }
      if (response && (!RETRIED_STATUSES.has(response.status) || attempt >= retries)) return response
      await response?.body?.cancel()
      await sleep(retryDelayMs(attempt + 1, response))
    }
  }
}

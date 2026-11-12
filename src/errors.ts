/** What the API sends with an error: `{ success: false, error: { code, message, details, correlation_id } }`. */
export interface ApiErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
  correlation_id?: string
}

/** Any error the API answered with. `code` is the API's error code, e.g. `TXN_ACCOUNT_CONNECTED`. */
export class DegroshiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>
  /** Include it when you report a problem: it finds the request in our logs. */
  readonly correlationId: string | undefined
  readonly headers: Headers | undefined

  constructor(status: number, body: ApiErrorBody, headers?: Headers) {
    super(body.message || `HTTP ${status}`)
    this.name = new.target.name
    this.status = status
    this.code = body.code
    this.details = body.details ?? {}
    this.correlationId = body.correlation_id
    this.headers = headers
  }
}

/** 400 or 422: the request is malformed or breaks a rule. */
export class BadRequestError extends DegroshiError {}
/** 401: the key is missing, wrong, expired or revoked. */
export class AuthenticationError extends DegroshiError {}
/** 403: the key lacks the scope, the space or the role for this. */
export class PermissionDeniedError extends DegroshiError {}
/** 404: no such resource in the space. */
export class NotFoundError extends DegroshiError {}
/** 409 or 412: it changed meanwhile, or the version you sent is old. */
export class ConflictError extends DegroshiError {}
/** 422: understood but refused, e.g. a bank-kept account takes no rows. */
export class UnprocessableEntityError extends DegroshiError {}

/** 429: too many requests. `retryAfterSeconds` says when to try again. */
export class RateLimitError extends DegroshiError {
  get retryAfterSeconds(): number | undefined {
    return parseRetryAfter(this.headers?.get("retry-after") ?? null)
  }
}

/** 5xx: our side failed. Retried for you when it's safe; this is the last answer. */
export class InternalServerError extends DegroshiError {}

/** The request never got an answer: no connection, or the connection broke. */
export class ApiConnectionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "connection failed", { cause })
    this.name = "ApiConnectionError"
  }
}

/** No answer within the client's timeout. */
export class ApiTimeoutError extends ApiConnectionError {
  constructor(cause: unknown) {
    super(cause)
    this.name = "ApiTimeoutError"
  }
}

/** The error class for an HTTP status. */
export function errorFor(status: number, body: ApiErrorBody, headers?: Headers): DegroshiError {
  switch (true) {
    case status === 401:
      return new AuthenticationError(status, body, headers)
    case status === 403:
      return new PermissionDeniedError(status, body, headers)
    case status === 404:
      return new NotFoundError(status, body, headers)
    case status === 409 || status === 412:
      return new ConflictError(status, body, headers)
    case status === 422:
      return new UnprocessableEntityError(status, body, headers)
    case status === 429:
      return new RateLimitError(status, body, headers)
    case status >= 500:
      return new InternalServerError(status, body, headers)
    case status >= 400:
      return new BadRequestError(status, body, headers)
    default:
      return new DegroshiError(status, body, headers)
  }
}

/** Reads an error answer into its body; a non-JSON answer keeps its text as the message. */
export function errorBodyOf(status: number, parsed: unknown): ApiErrorBody {
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    const error = (parsed as { error: unknown }).error
    if (typeof error === "object" && error !== null && typeof (error as ApiErrorBody).code === "string") {
      return error as ApiErrorBody
    }
  }
  return { code: `HTTP_${status}`, message: typeof parsed === "string" && parsed ? parsed : `HTTP ${status}` }
}

/** Seconds from a Retry-After header: a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, (date - now) / 1000)
}

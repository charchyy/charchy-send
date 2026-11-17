/**
 * Every `error.code` the API can answer (openapi.yaml `ErrorCode`, checked
 * by test/contract.types.ts). Never renamed within v1.
 */
export type ApiErrorCode =
  | "invalid_json"
  | "invalid_idempotency_key"
  | "validation_error"
  | "missing_api_key"
  | "invalid_api_key"
  | "restricted_api_key"
  | "domain_not_verified"
  | "sender_not_allowed"
  | "not_approved"
  | "sending_paused"
  | "not_found"
  | "idempotency_conflict"
  | "idempotency_in_flight"
  | "payload_too_large"
  | "invalid_attachment"
  | "too_many_recipients"
  | "schedule_out_of_range"
  | "insufficient_balance"
  | "rate_limit_exceeded"
  | "daily_limit_reached"
  | "internal_error"
  | "sending_unavailable"

/**
 * Codes only the SDK produces:
 *
 * - `network_error`: the request failed or timed out before an answer came back.
 * - `invalid_response`: an answer came back that is not the API's JSON (a proxy page, a redirect, an empty body).
 * - `react_render_error`: `react` was given but `@react-email/render` is missing or the render threw.
 * - `wait_timeout`: `emails.waitFor` ran out of time before the email reached a wanted status.
 * - `wait_unexpected_status`: `emails.waitFor` saw the email end in a status it can't leave (canceled, expired, failed, unknown) that you didn't wait for.
 *
 * Local checks of your input (a bad duration string, an attachment with no
 * content type) use the API's own `validation_error`, with `field` set and
 * `statusCode: null`.
 */
export type SdkErrorCode = "network_error" | "invalid_response" | "react_render_error" | "wait_timeout" | "wait_unexpected_status"

const SDK_ERROR_CODES: ReadonlySet<string> = new Set<SdkErrorCode>([
  "network_error",
  "invalid_response",
  "react_render_error",
  "wait_timeout",
  "wait_unexpected_status",
])

export type CharchySendErrorCode = ApiErrorCode | SdkErrorCode

/** One invalid email of a refused batch (`422 validation_error`). */
export type BatchErrorItem = {
  /** The email's position in the array you sent, from 0. */
  index: number
  code: ApiErrorCode
  field?: string
  message: string
}

const ERRORS_DOCS = "https://charchy.krd/docs/errors"
const SDK_ERRORS_DOCS = "https://charchy.krd/docs/sdks/node#errors"

export function docsUrlFor(code: CharchySendErrorCode): string {
  return SDK_ERROR_CODES.has(code) ? SDK_ERRORS_DOCS : `${ERRORS_DOCS}#${code}`
}

/**
 * An error the API answered, or one the SDK hit before it got an answer.
 * Returned as `result.error`, never thrown by the API methods — `unwrap()`
 * throws it if you prefer exceptions. Match on `code`; `message` is for
 * people and may change.
 */
export class CharchySendError extends Error {
  override readonly name = "CharchySendError"
  readonly code: CharchySendErrorCode
  /** The request field at fault, when there is one. */
  readonly field: string | undefined
  /** The code's section of charchy.krd/docs/errors. */
  readonly docs: string
  /** The HTTP status, or null when no answer came back (network error, a local check). */
  readonly statusCode: number | null
  /** The `x-request-id` header. Quote it to support@charchy.krd. */
  readonly requestId: string | null
  /** Seconds the API asked to wait (`Retry-After`), when it said. */
  readonly retryAfterSeconds: number | undefined
  /** Every invalid email of a refused batch, by index. */
  readonly items: BatchErrorItem[] | undefined

  constructor(details: {
    code: CharchySendErrorCode
    message: string
    field?: string | undefined
    docs?: string | undefined
    statusCode: number | null
    requestId?: string | null | undefined
    retryAfterSeconds?: number | undefined
    items?: BatchErrorItem[] | undefined
    cause?: unknown
  }) {
    super(details.message, details.cause === undefined ? undefined : { cause: details.cause })
    this.code = details.code
    this.field = details.field
    this.docs = details.docs ?? docsUrlFor(details.code)
    this.statusCode = details.statusCode
    this.requestId = details.requestId ?? null
    this.retryAfterSeconds = details.retryAfterSeconds
    this.items = details.items
  }

  /** A plain object for logs (`JSON.stringify(error)` gives this too). */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.field !== undefined ? { field: this.field } : {}),
      docs: this.docs,
      statusCode: this.statusCode,
      requestId: this.requestId,
      ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      ...(this.items !== undefined ? { items: this.items } : {}),
    }
  }
}

/** A local check of your input failed; nothing was sent. */
export function localValidationError(field: string, message: string): CharchySendError {
  return new CharchySendError({ code: "validation_error", field, message, statusCode: null })
}

/** The response headers, lower-cased. */
export type ResponseHeaders = Record<string, string>

/** The response headers that matter, parsed. */
export type ResponseMeta = {
  /** `x-request-id` — quote it to support. */
  requestId: string | null
  /** `ratelimit-limit` / `-remaining` / `-reset`, when the request counted against your rate limit. */
  rateLimit: { limit: number; remaining: number; resetSeconds: number } | null
  /** `x-charchy-emails-remaining`: plan emails plus credits left (sends, cancels, usage). */
  emailsRemaining: number | null
}

/**
 * What every API method resolves to: `data` or `error`, never both, plus the
 * raw response `headers` and the parsed `meta`. Both are null when no answer
 * came back (a network error, or a local check that sent nothing).
 */
export type Result<T> =
  | { data: T; error: null; headers: ResponseHeaders; meta: ResponseMeta }
  | { data: null; error: CharchySendError; headers: ResponseHeaders | null; meta: ResponseMeta | null }

/** A failure that never reached the API. */
export function localFailure<T>(error: CharchySendError): Result<T> {
  return { data: null, error, headers: null, meta: null }
}

/**
 * The data of a result, or its error thrown — for code that prefers
 * exceptions:
 *
 *   const { id } = await send.emails.send({ … }).then(unwrap)
 */
export function unwrap<T>(result: Result<T>): T {
  if (result.error) throw result.error
  return result.data
}

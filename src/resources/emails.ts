import { camelizeKeys } from "../casing.js"
import { CharchySendError, localFailure, localValidationError, type Result } from "../errors.js"
import type { components } from "../generated/openapi.js"
import { INSPECT, randomUUID } from "../runtime.js"
import { toApiDateTime } from "../time.js"
import { callApi, sleep, type TransportConfig } from "../transport.js"
import type {
  AcceptedEmail,
  BatchEmailParams,
  BatchResult,
  DateInput,
  Email,
  EmailList,
  EmailStatus,
  EmailSummary,
  ListEmailsParams,
  RequestOptions,
  RescheduledEmail,
  SendEmailParams,
  SendOptions,
  WaitForOptions,
} from "../types.js"
import { toWireEmailFields, toWireSendEmail } from "../wire.js"

type Schemas = components["schemas"]

/** A typed view of a successful answer: camelCased, the error branch passed through. */
export function mapData<Wire, Data>(result: Result<unknown>, map: (wire: Wire) => Data): Result<Data> {
  if (result.error) return result
  return { data: map(result.data as Wire), error: null, headers: result.headers, meta: result.meta }
}

const EMAIL_ID = /^em_[A-Za-z0-9]+$/
/** The API's rule: 1–256 printable ASCII characters. */
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,256}$/

/** An `em_…` id, checked before it becomes a path segment (`..` must never reach another endpoint). */
function checkEmailId(id: unknown): CharchySendError | null {
  return typeof id === "string" && EMAIL_ID.test(id) ? null : localValidationError("id", 'id must be an email id like "em_8f2k1x9q4w7m3n5p6r0s2t4v".')
}

/** Statuses an email ends in — `waitFor`'s default. */
const SETTLED_STATUSES: readonly EmailStatus[] = ["delivered", "bounced", "complained", "suppressed", "canceled", "expired", "failed", "unknown"]
/** Statuses an email never leaves: waiting longer for another is pointless. */
const STUCK_STATUSES: ReadonlySet<EmailStatus> = new Set<EmailStatus>(["canceled", "expired", "failed", "unknown"])
const MAX_WAIT_MS = 600_000
const MIN_INTERVAL_MS = 250

export class Emails {
  readonly #config: TransportConfig

  constructor(config: TransportConfig) {
    this.#config = config
  }

  /** The key to send: yours, checked; or a random one so the SDK's own retries can't send twice. */
  async #idempotencyKeyFor(options: SendOptions | undefined): Promise<{ ok: true; key: string | undefined } | { ok: false; error: CharchySendError }> {
    const given = options?.idempotencyKey
    if (given !== undefined) {
      if (typeof given !== "string" || !IDEMPOTENCY_KEY.test(given)) {
        return { ok: false, error: localValidationError("idempotencyKey", "idempotencyKey must be 1–256 printable ASCII characters (no line breaks, tabs or non-Latin letters).") }
      }
      return { ok: true, key: given }
    }
    return { ok: true, key: this.#config.maxRetries > 0 ? await randomUUID() : undefined }
  }

  /** `POST /v1/emails` — accept one email; the answer comes back at once. */
  async send(params: SendEmailParams, options?: SendOptions): Promise<Result<AcceptedEmail>> {
    const key = await this.#idempotencyKeyFor(options)
    if (!key.ok) return localFailure(key.error)
    const body = await toWireSendEmail(params)
    if (!body.ok) return localFailure(body.error)
    const result = await callApi(this.#config, {
      method: "POST",
      path: "/emails",
      json: body.value,
      idempotencyKey: key.key,
      signal: options?.signal,
      retry: "repeatable",
    })
    return mapData(result, (wire: Schemas["AcceptedEmail"]) => camelizeKeys(wire))
  }

  /** `POST /v1/emails/batch` — up to 100 emails, no attachments; all accepted or none. */
  async batch(emails: BatchEmailParams[], options?: SendOptions): Promise<Result<BatchResult>> {
    const key = await this.#idempotencyKeyFor(options)
    if (!key.ok) return localFailure(key.error)
    const wireEmails: Schemas["EmailFields"][] = []
    for (const [index, email] of emails.entries()) {
      const mapped = await toWireEmailFields(email, `emails[${index}].`)
      if (!mapped.ok) return localFailure(mapped.error)
      wireEmails.push(mapped.value)
    }
    const result = await callApi(this.#config, {
      method: "POST",
      path: "/emails/batch",
      json: { emails: wireEmails } satisfies Schemas["BatchRequest"],
      idempotencyKey: key.key,
      signal: options?.signal,
      retry: "repeatable",
    })
    return mapData(result, (wire: Schemas["BatchResponse"]) => camelizeKeys(wire))
  }

  /** `GET /v1/emails/{id}` — status, recipients, tags and the event timeline (30 days). */
  async get(id: string, options?: RequestOptions): Promise<Result<Email>> {
    const invalid = checkEmailId(id)
    if (invalid) return localFailure(invalid)
    const result = await callApi(this.#config, { method: "GET", path: `/emails/${id}`, signal: options?.signal, retry: "repeatable" })
    return mapData(result, (wire: Schemas["Email"]) => camelizeKeys(wire))
  }

  /** `GET /v1/emails` — one page, newest first. `listAll()` follows the pages for you. */
  async list(params: ListEmailsParams = {}, options?: RequestOptions): Promise<Result<EmailList>> {
    const result = await callApi(this.#config, {
      method: "GET",
      path: "/emails",
      query: { limit: params.limit, after: params.after, status: params.status, tag: params.tag, to: params.to },
      signal: options?.signal,
      retry: "repeatable",
    })
    return mapData(result, (wire: Schemas["EmailList"]) => camelizeKeys(wire))
  }

  /**
   * Every email matching the filters, newest first, page by page (`limit` is
   * the page size, default 100):
   *
   *   for await (const email of send.emails.listAll({ status: "bounced" })) { … }
   *
   * An iterator has no result to return an error in: a failed page THROWS
   * its `CharchySendError`.
   */
  async *listAll(params: Omit<ListEmailsParams, "after"> = {}, options?: RequestOptions): AsyncGenerator<EmailSummary, void, undefined> {
    let after: string | undefined
    do {
      const page = await this.list({ ...params, limit: params.limit ?? 100, after }, options)
      if (page.error) throw page.error
      yield* page.data.data
      after = page.data.hasMore ? page.data.nextCursor : undefined
    } while (after !== undefined)
  }

  /**
   * Reads the email until it reaches one of `until` — for tests and CI:
   *
   *   const { data, error } = await send.emails.waitFor(id, { until: ["delivered"] })
   *
   * `error` is `wait_timeout` when time runs out, `wait_unexpected_status`
   * when the email ends in a status it can never leave (canceled, expired,
   * failed, unknown) that you didn't ask for, or the read's own error.
   */
  async waitFor(id: string, options: WaitForOptions = {}): Promise<Result<Email>> {
    const timeoutMs = options.timeoutMs ?? 60_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_WAIT_MS) {
      return localFailure(localValidationError("timeoutMs", `timeoutMs must be more than 0 and at most ${MAX_WAIT_MS}.`))
    }
    const intervalMs = Math.max(MIN_INTERVAL_MS, Number.isFinite(options.intervalMs) ? options.intervalMs! : 1_000)
    const until = new Set(options.until ?? SETTLED_STATUSES)
    const deadline = Date.now() + timeoutMs

    for (;;) {
      const result = await this.get(id, { signal: options.signal })
      if (result.error) return result
      const { status } = result.data
      if (until.has(status)) return result
      if (STUCK_STATUSES.has(status)) {
        return {
          data: null,
          error: new CharchySendError({
            code: "wait_unexpected_status",
            message: `${id} is ${status} and can't become ${[...until].join(" or ")}.`,
            statusCode: null,
            requestId: result.meta.requestId,
          }),
          headers: result.headers,
          meta: result.meta,
        }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return {
          data: null,
          error: new CharchySendError({
            code: "wait_timeout",
            message: `${id} was still ${status} after ${timeoutMs} ms (waiting for ${[...until].join(" or ")}).`,
            statusCode: null,
            requestId: result.meta.requestId,
          }),
          headers: result.headers,
          meta: result.meta,
        }
      }
      if (!(await sleep(Math.min(intervalMs, remaining), options.signal))) {
        return localFailure(new CharchySendError({ code: "network_error", message: "The request was aborted.", statusCode: null }))
      }
    }
  }

  /** `PATCH /v1/emails/{id}` — a new `scheduledAt` while the email is still `scheduled`. */
  async update(id: string, params: { scheduledAt: DateInput }, options?: RequestOptions): Promise<Result<RescheduledEmail>> {
    const invalid = checkEmailId(id)
    if (invalid) return localFailure(invalid)
    const scheduledAt = toApiDateTime("scheduledAt", params.scheduledAt)
    if (!scheduledAt.ok) return localFailure(scheduledAt.error)
    const result = await callApi(this.#config, {
      method: "PATCH",
      path: `/emails/${id}`,
      json: { scheduled_at: scheduledAt.value } satisfies Schemas["RescheduleRequest"],
      signal: options?.signal,
      retry: "repeatable",
    })
    return mapData(result, (wire: Schemas["RescheduledEmail"]) => camelizeKeys(wire))
  }

  /** `POST /v1/emails/{id}/cancel` — while `scheduled` or `queued`; refunded. Canceling twice answers the same. */
  async cancel(id: string, options?: RequestOptions): Promise<Result<AcceptedEmail>> {
    const invalid = checkEmailId(id)
    if (invalid) return localFailure(invalid)
    const result = await callApi(this.#config, { method: "POST", path: `/emails/${id}/cancel`, signal: options?.signal, retry: "repeatable" })
    return mapData(result, (wire: Schemas["AcceptedEmail"]) => camelizeKeys(wire))
  }

  /** Nothing to show: the key stays out of logs. */
  [INSPECT](): object {
    return {}
  }

  toJSON(): object {
    return {}
  }
}

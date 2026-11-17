/**
 * One API call, with retries. Never throws: every outcome is a `Result`.
 *
 * Retried, up to `maxRetries` more attempts (jittered backoff, or the
 * `Retry-After` the API sent):
 *   - `429` (`rate_limit_exceeded`, `daily_limit_reached`) and
 *     `409 idempotency_in_flight` — the API did not process the request;
 *   - network errors, timeouts and `5xx` — only for calls that are safe to
 *     repeat: reads, reschedule, cancel, and sends (which always carry an
 *     Idempotency-Key, made by the SDK when you give none). Not image
 *     uploads, which have no idempotency key: a repeat could store a second
 *     copy.
 * Never retried: `402 insufficient_balance` and every other `4xx`, a
 * redirect, and a `Retry-After` longer than a minute (a daily cap that
 * resets in hours is returned to you at once, with `error.retryAfterSeconds`).
 *
 * Redirects are never followed (`redirect: "manual"`): a 3xx would re-send
 * the email — and the key — to wherever it points. The API never redirects.
 */

import type { KeyResolution } from "./apiKey.js"
import { CharchySendError, localFailure, type ApiErrorCode, type BatchErrorItem, type ResponseHeaders, type ResponseMeta, type Result } from "./errors.js"

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type TransportConfig = {
  /** The key, resolved per request (see ./apiKey.ts). */
  resolveKey: () => KeyResolution
  baseUrl: string
  maxRetries: number
  timeoutMs: number
  fetch: FetchLike
  userAgent: string
}

/**
 * - `repeatable`: the call may be sent twice safely (idempotent by nature or by key).
 * - `refusals-only`: retry only answers that say the request was not processed.
 */
export type RetryPolicy = "repeatable" | "refusals-only"

export type ApiCall = {
  method: "GET" | "POST" | "PATCH"
  path: string
  query?: Record<string, string | number | undefined>
  json?: unknown
  form?: FormData
  idempotencyKey?: string | undefined
  signal?: AbortSignal | undefined
  retry: RetryPolicy
}

/** The longest `Retry-After` the SDK waits out by itself. */
export const MAX_RETRY_AFTER_SECONDS = 60
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000

type Attempt =
  | { kind: "answer"; status: number; headers: ResponseHeaders; body: unknown; bodyIsJson: boolean }
  | { kind: "network"; error: unknown; timedOut: boolean; aborted: boolean }

export async function callApi(config: TransportConfig, call: ApiCall): Promise<Result<unknown>> {
  const resolved = config.resolveKey()
  if (!resolved.ok) return localFailure(resolved.error)
  const apiKey = resolved.key
  const url = buildUrl(config.baseUrl, call.path, call.query)
  for (let attempt = 0; ; attempt++) {
    const outcome = await attemptOnce(config, apiKey, call, url)
    const result = toResult(outcome, apiKey)
    if (!result.error || attempt >= config.maxRetries) return result

    const waitMs = retryDelayMs(outcome, result.error, call.retry, attempt)
    if (waitMs === null) return result
    const slept = await sleep(waitMs, call.signal)
    if (!slept) return result
  }
}

export function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/v1${path}`)
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value))
  }
  return url.toString()
}

async function attemptOnce(config: TransportConfig, apiKey: string, call: ApiCall, url: string): Promise<Attempt> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.timeoutMs)
  const forwardAbort = () => controller.abort()
  if (call.signal?.aborted) controller.abort()
  call.signal?.addEventListener("abort", forwardAbort, { once: true })

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "User-Agent": config.userAgent,
  }
  if (call.json !== undefined) headers["Content-Type"] = "application/json"
  if (call.idempotencyKey !== undefined) headers["Idempotency-Key"] = call.idempotencyKey

  try {
    const response = await config.fetch(url, {
      method: call.method,
      headers,
      body: call.form ?? (call.json !== undefined ? JSON.stringify(call.json) : undefined),
      signal: controller.signal,
      redirect: "manual",
    })
    const responseHeaders = headersToRecord(response.headers)
    // A browser-style fetch reports a manual redirect as type "opaqueredirect", status 0.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      return { kind: "answer", status: response.status, headers: responseHeaders, body: null, bodyIsJson: false }
    }
    const text = await response.text()
    if (text.trim().length === 0) return { kind: "answer", status: response.status, headers: responseHeaders, body: text, bodyIsJson: false }
    try {
      return { kind: "answer", status: response.status, headers: responseHeaders, body: JSON.parse(text), bodyIsJson: true }
    } catch {
      return { kind: "answer", status: response.status, headers: responseHeaders, body: text, bodyIsJson: false }
    }
  } catch (error) {
    return { kind: "network", error, timedOut, aborted: call.signal?.aborted === true }
  } finally {
    clearTimeout(timer)
    call.signal?.removeEventListener("abort", forwardAbort)
  }
}

export function headersToRecord(headers: Headers): ResponseHeaders {
  const record: ResponseHeaders = {}
  headers.forEach((value, name) => {
    record[name.toLowerCase()] = value
  })
  return record
}

function readCount(headers: ResponseHeaders, name: string): number | null {
  const raw = headers[name]
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null
  return Number(raw.trim())
}

export function readMeta(headers: ResponseHeaders): ResponseMeta {
  const limit = readCount(headers, "ratelimit-limit")
  const remaining = readCount(headers, "ratelimit-remaining")
  const resetSeconds = readCount(headers, "ratelimit-reset")
  return {
    requestId: headers["x-request-id"] ?? null,
    rateLimit: limit !== null && remaining !== null && resetSeconds !== null ? { limit, remaining, resetSeconds } : null,
    emailsRemaining: readCount(headers, "x-charchy-emails-remaining"),
  }
}

function readRetryAfter(headers: ResponseHeaders): number | undefined {
  const raw = headers["retry-after"]
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(raw)
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

/** The key, wherever a runtime error message might have echoed it, replaced by its masked form. */
export function scrubKey(text: string, apiKey: string): string {
  return apiKey.length > 0 ? text.split(apiKey).join(maskKey(apiKey)) : text
}

/** `chy_live_…1a2b`: the prefix and the last four characters, never more. */
export function maskKey(apiKey: string): string {
  const prefix = /^chy_[a-z]+_/.exec(apiKey)?.[0] ?? ""
  return `${prefix}…${apiKey.slice(-4)}`
}

type ApiErrorBody = {
  error?: { code?: unknown; message?: unknown; field?: unknown; docs?: unknown; items?: unknown }
}

function toResult(outcome: Attempt, apiKey: string): Result<unknown> {
  if (outcome.kind === "network") {
    const causeText = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    const message = outcome.aborted
      ? "The request was aborted."
      : outcome.timedOut
        ? "The request timed out before Charchy Send answered."
        : scrubKey(`The request failed before Charchy Send answered: ${causeText}`, apiKey)
    // Never keep a cause that quotes the key (a runtime's "invalid header value" echoes it).
    const leaks = causeText.includes(apiKey) || (outcome.error instanceof Error && String(outcome.error.stack ?? "").includes(apiKey))
    const cause = leaks ? new Error(scrubKey(causeText, apiKey)) : outcome.error
    return {
      data: null,
      error: new CharchySendError({ code: "network_error", message, statusCode: null, cause }),
      headers: null,
      meta: null,
    }
  }

  const { status, headers, body, bodyIsJson } = outcome
  const meta = readMeta(headers)
  const requestId = meta.requestId
  if (status >= 300 && status < 400) {
    return {
      data: null,
      error: new CharchySendError({
        code: "invalid_response",
        message: `Charchy Send answered with a redirect (${status}), which the SDK never follows. Check baseUrl.`,
        statusCode: status,
        requestId,
      }),
      headers,
      meta,
    }
  }
  if (status === 0) {
    return {
      data: null,
      error: new CharchySendError({ code: "invalid_response", message: "Charchy Send answered with a redirect, which the SDK never follows. Check baseUrl.", statusCode: null, requestId }),
      headers,
      meta,
    }
  }
  if (status >= 200 && status < 300) {
    if (bodyIsJson && body !== null && typeof body === "object") return { data: body, error: null, headers, meta }
    return {
      data: null,
      error: new CharchySendError({
        code: "invalid_response",
        message: `Charchy Send answered ${status} without the JSON body it always sends.`,
        statusCode: status,
        requestId,
      }),
      headers,
      meta,
    }
  }

  const apiError = bodyIsJson ? (body as ApiErrorBody | null)?.error : undefined
  const retryAfterSeconds = readRetryAfter(headers)
  if (apiError && typeof apiError.code === "string" && typeof apiError.message === "string") {
    return {
      data: null,
      error: new CharchySendError({
        code: apiError.code as ApiErrorCode,
        message: apiError.message,
        field: typeof apiError.field === "string" ? apiError.field : undefined,
        docs: typeof apiError.docs === "string" ? apiError.docs : undefined,
        statusCode: status,
        requestId,
        retryAfterSeconds,
        items: Array.isArray(apiError.items) ? (apiError.items as BatchErrorItem[]) : undefined,
      }),
      headers,
      meta,
    }
  }

  // Not the API's error shape: a proxy or load balancer answered.
  const code: ApiErrorCode | "invalid_response" = status === 429 ? "rate_limit_exceeded" : status >= 500 ? "internal_error" : "invalid_response"
  return {
    data: null,
    error: new CharchySendError({
      code,
      message: `Charchy Send answered ${status} without an error body.`,
      statusCode: status,
      requestId,
      retryAfterSeconds,
    }),
    headers,
    meta,
  }
}

/** How long to wait before the next attempt, or null to return this result. */
export function retryDelayMs(
  outcome: Attempt,
  error: CharchySendError,
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random
): number | null {
  const backoff = () => Math.round(Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt) * (0.5 + random() / 2))
  const afterHeader = () => {
    const seconds = error.retryAfterSeconds
    if (seconds === undefined) return backoff()
    if (seconds > MAX_RETRY_AFTER_SECONDS) return null
    return Math.round(seconds * 1000 + random() * 250)
  }

  if (outcome.kind === "network") {
    if (outcome.aborted) return null
    return policy === "repeatable" ? backoff() : null
  }
  const { status } = outcome
  if (status === 429) return afterHeader()
  if (status === 409 && error.code === "idempotency_in_flight") return afterHeader()
  if (status >= 500 && policy === "repeatable") return error.retryAfterSeconds !== undefined ? afterHeader() : backoff()
  return null
}

export function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

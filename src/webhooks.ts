/**
 * Webhook verification — the Standard Webhooks spec (standardwebhooks.com),
 * which is how Charchy Send signs every event:
 *
 *   webhook-id         the event's id (`evt_…`), the same on every retry
 *   webhook-timestamp  Unix seconds when this attempt was signed
 *   webhook-signature  "v1,<base64 HMAC-SHA256 of `id.timestamp.body`>",
 *                      space-separated when two secrets sign (a rotation)
 *
 * The HMAC key is the base64-decoded part of the `whsec_…` secret. Web Crypto
 * only (`crypto.subtle`), so it runs on every edge runtime.
 */

import { camelizeKeys } from "./casing.js"
import { base64ToBytes, bytesToBase64, readEnv, webCrypto } from "./runtime.js"
import type { BounceDetails, Tags } from "./types.js"

// ─── Event types ────────────────────────────────────────────────────

type EventEnvelope<Type extends string, Data> = {
  /** `evt_…`, the same as the `webhook-id` header and on every retry: dedupe by it. */
  id: string
  type: Type
  /** ISO 8601, when it happened. Order events by it; delivery order is not guaranteed. */
  createdAt: string
  /** True on a sample from "Send test event" (no real email behind it). A real email sent with a test key has `data.test`. */
  test?: boolean
  data: Data
}

export type EmailEventData = {
  emailId: string
  from: string
  to: string[]
  subject: string
  /** ISO 8601, when the email was accepted. */
  createdAt: string
  tags: Tags
  /** Sent with a test key. */
  test: boolean
}

/** Per-recipient events name the address — may be a `cc` or `bcc`. */
type PerRecipient = { recipient: string }

export type EmailSentEvent = EventEnvelope<"email.sent", EmailEventData>
export type EmailDeliveredEvent = EventEnvelope<"email.delivered", EmailEventData & PerRecipient>
export type EmailDeliveryDelayedEvent = EventEnvelope<"email.delivery_delayed", EmailEventData & PerRecipient>
export type EmailBouncedEvent = EventEnvelope<"email.bounced", EmailEventData & PerRecipient & { bounce: BounceDetails }>
export type EmailComplainedEvent = EventEnvelope<"email.complained", EmailEventData & PerRecipient>
export type EmailFailedEvent = EventEnvelope<"email.failed", EmailEventData & { failed: { reason: string } }>
export type EmailSuppressedEvent = EventEnvelope<
  "email.suppressed",
  EmailEventData & PerRecipient & { suppressed: { reason: "previous_bounce" | "previous_complaint" } }
>
export type EmailExpiredEvent = EventEnvelope<"email.expired", EmailEventData & { expired: { reason: string } }>
export type EmailCanceledEvent = EventEnvelope<"email.canceled", EmailEventData>

export type DomainVerifiedEvent = EventEnvelope<"domain.verified", { domain: string }>
export type DomainFailedEvent = EventEnvelope<"domain.failed", { domain: string }>

export type AccountPauseCode =
  | "manual"
  | "bounce_rate"
  | "complaint_rate"
  | "volume_spike"
  | "not_transactional"
  | "provider_paused"
  | "reputation_finding"

export type AccountPausedEvent = EventEnvelope<"account.paused", { code: AccountPauseCode; reason: string }>
export type AccountResumedEvent = EventEnvelope<"account.resumed", Record<string, never>>
export type BalanceLowEvent = EventEnvelope<"balance.low", { usedPercent: 80 | 100; emailsLeft: number }>

export type EmailWebhookEvent =
  | EmailSentEvent
  | EmailDeliveredEvent
  | EmailDeliveryDelayedEvent
  | EmailBouncedEvent
  | EmailComplainedEvent
  | EmailFailedEvent
  | EmailSuppressedEvent
  | EmailExpiredEvent
  | EmailCanceledEvent

/** Every event Charchy Send sends, discriminated by `type` — `switch (event.type)` narrows `data`. */
export type WebhookEvent =
  | EmailWebhookEvent
  | DomainVerifiedEvent
  | DomainFailedEvent
  | AccountPausedEvent
  | AccountResumedEvent
  | BalanceLowEvent

export type WebhookEventType = WebhookEvent["type"]

// ─── Verification ───────────────────────────────────────────────────

export type WebhookVerificationFailure =
  | "missing_secret"
  | "invalid_secret"
  | "missing_headers"
  | "invalid_timestamp"
  | "timestamp_out_of_range"
  | "invalid_signature"
  | "invalid_payload"

/** Thrown by `verifyWebhook` when a request must be refused (answer it `400`). */
export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError"
  constructor(
    readonly reason: WebhookVerificationFailure,
    message: string
  ) {
    super(message)
  }
}

/** A `Headers`, or a plain object such as Express's `req.headers`. */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>

export type VerifyWebhookParams = {
  /** The RAW body, exactly as received: `await request.text()`, or Express's `express.raw()` Buffer. Never parsed or re-serialised JSON. */
  payload: string | Uint8Array | ArrayBuffer
  headers: WebhookHeaders
  /** `whsec_…`. Defaults to `process.env.CHARCHY_WEBHOOK_SECRET`. */
  secret?: string
}

const SECRET_PREFIX = "whsec_"
/** The spec's replay window, both ways. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60

function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== name) continue
    return Array.isArray(value) ? value.join(" ") : value
  }
  return undefined
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(head.length + tail.length)
  joined.set(head, 0)
  joined.set(tail, head.length)
  return joined
}

/** The base64 HMAC-SHA256 of `id.timestamp.payload` — what `webhook-signature` carries after `v1,`. */
export async function signWebhookPayload(secret: string, id: string, timestamp: string | number, payload: string | Uint8Array): Promise<string> {
  const crypto = await webCrypto()
  const key = await crypto.subtle.importKey("raw", secretBytes(secret) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload
  const signed = concatBytes(new TextEncoder().encode(`${id}.${timestamp}.`), body)
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)))
}

function secretBytes(secret: string): Uint8Array {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret
  try {
    const bytes = base64ToBytes(encoded)
    if (bytes.length === 0) throw new Error("empty")
    return bytes
  } catch {
    throw new WebhookVerificationError("invalid_secret", "The webhook secret is not a whsec_… secret. Copy it from Webhooks in the Charchy dashboard.")
  }
}

/**
 * Verifies a webhook request and returns its event, camelCased (`tags` keys
 * untouched). THROWS `WebhookVerificationError` when the request must be
 * refused — a missing header, a timestamp more than 5 minutes off, or no
 * matching signature. Every `v1` signature in the header is tried (two
 * during a secret rotation); the comparison is constant-time.
 */
export async function verifyWebhook(params: VerifyWebhookParams): Promise<WebhookEvent> {
  const secret = params.secret ?? readEnv("CHARCHY_WEBHOOK_SECRET")
  if (!secret) {
    throw new WebhookVerificationError("missing_secret", "Pass `secret`, or set CHARCHY_WEBHOOK_SECRET (whsec_…).")
  }
  secretBytes(secret) // a misconfigured secret is reported as such, before anything about the request
  const id = readHeader(params.headers, "webhook-id")
  const timestamp = readHeader(params.headers, "webhook-timestamp")
  const signatures = readHeader(params.headers, "webhook-signature")
  if (!id || !timestamp || !signatures) {
    throw new WebhookVerificationError("missing_headers", "The webhook-id, webhook-timestamp and webhook-signature headers are required.")
  }
  if (!/^\d+$/.test(timestamp)) throw new WebhookVerificationError("invalid_timestamp", "webhook-timestamp is not Unix seconds.")
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new WebhookVerificationError("timestamp_out_of_range", "webhook-timestamp is more than 5 minutes from now: refused as a possible replay.")
  }

  const raw: unknown = params.payload
  if (typeof raw !== "string" && !(raw instanceof Uint8Array) && !(raw instanceof ArrayBuffer)) {
    throw new WebhookVerificationError(
      "invalid_payload",
      `payload must be the raw body (a string, Buffer, Uint8Array or ArrayBuffer), not ${raw === null ? "null" : typeof raw}. Did express.json() or another body parser parse it? Use express.raw({ type: "application/json" }) or await request.text().`
    )
  }
  const payload = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
  const expected = base64ToBytes(await signWebhookPayload(secret, id, timestamp, payload))
  const matched = signatures.split(" ").some((entry) => {
    const comma = entry.indexOf(",")
    if (comma === -1 || entry.slice(0, comma) !== "v1") return false
    try {
      return constantTimeEqual(base64ToBytes(entry.slice(comma + 1)), expected)
    } catch {
      return false
    }
  })
  if (!matched) {
    throw new WebhookVerificationError(
      "invalid_signature",
      "No webhook-signature matches this body and secret. Check the secret, and pass the raw body exactly as received: parsed and re-serialised JSON never matches."
    )
  }

  let event: unknown
  try {
    event = JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(payload))
  } catch {
    throw new WebhookVerificationError("invalid_payload", "The signed body is not JSON.")
  }
  return camelizeKeys(event) as WebhookEvent
}

// ─── A ready endpoint ───────────────────────────────────────────────

/** One function per event type you care about; each gets that event, typed. */
export type WebhookHandlers = {
  [Type in WebhookEventType]?: (event: Extract<WebhookEvent, { type: Type }>) => unknown
}

export type WebhookHandlerOptions = {
  /** `whsec_…`. Defaults to `process.env.CHARCHY_WEBHOOK_SECRET`. */
  secret?: string
  /**
   * Told about every refused request and every handler that threw (default:
   * `console.error` for handler failures only — a stranger's bad request is
   * not worth a log line). Its own errors are ignored.
   */
  onError?: (error: unknown, event: WebhookEvent | null) => unknown
}

/**
 * A complete webhook endpoint as a standard `(request: Request) => Promise<Response>`
 * — Next.js App Router, Cloudflare Workers, Bun, Deno, Hono:
 *
 *   export const POST = webhookHandler({
 *     "email.bounced": async (event) => markBounced(event.data.recipient),
 *     "balance.low": async (event) => alertOps(event.data.emailsLeft),
 *   })
 *
 * Verifies the raw body, then answers:
 *   204  verified, and its handler finished (or there is none for this type);
 *   400  not a valid Charchy Send request — no detail, to a stranger;
 *   405  not a POST;
 *   500  a handler threw, or the secret is missing or malformed — so Charchy
 *        Send retries the event once you have fixed it.
 * Handlers run before the answer: keep them under a few seconds (the
 * delivery times out at 5), or hand the work to a queue.
 */
export function webhookHandler(handlers: WebhookHandlers, options: WebhookHandlerOptions = {}): (request: Request) => Promise<Response> {
  const report = webhookErrorReporter(options.onError)
  return (request: Request): Promise<Response> =>
    answerWebhook({
      method: request.method,
      headers: request.headers,
      readPayload: async () => new Uint8Array(await request.arrayBuffer()),
      resolveSecret: async () => options.secret,
      handlerFor: (type) => handlers[type] as ((event: WebhookEvent) => unknown) | undefined,
      report,
    })
}

/** @internal `options.onError`, or the default: log handler failures only. A failing logger never changes the answer. */
export function webhookErrorReporter(onError: WebhookHandlerOptions["onError"]): (error: unknown, event: WebhookEvent | null) => Promise<void> {
  return async (error, event) => {
    try {
      if (onError) await onError(error, event)
      else if (event) console.error(`[@charchy/send] The ${event.type} webhook handler threw:`, error)
    } catch {
      // A failing logger must not change the answer.
    }
  }
}

/** @internal One webhook request, whatever the framework. */
export type WebhookRequest = {
  method: string
  headers: WebhookHeaders
  /** The raw body. A throw is answered 400, like a body that fails verification. */
  readPayload: () => Promise<Uint8Array>
  /** Undefined: `CHARCHY_WEBHOOK_SECRET` from `process.env`. A throw is answered 500. */
  resolveSecret: () => Promise<string | undefined>
  handlerFor: (type: WebhookEventType) => ((event: WebhookEvent) => unknown) | undefined
  report: (error: unknown, event: WebhookEvent | null) => Promise<void>
}

/** @internal The answers `webhookHandler` documents — shared by every adapter so they can't drift. */
export async function answerWebhook(request: WebhookRequest): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
  let secret: string | undefined
  try {
    secret = await request.resolveSecret()
  } catch (error) {
    await request.report(error, null)
    return misconfiguredResponse()
  }
  let event: WebhookEvent
  try {
    const payload = await request.readPayload()
    event = await verifyWebhook({ payload, headers: request.headers, ...(secret !== undefined ? { secret } : {}) })
  } catch (error) {
    await request.report(error, null)
    const misconfigured =
      error instanceof WebhookBodyUnavailableError ||
      (error instanceof WebhookVerificationError && (error.reason === "missing_secret" || error.reason === "invalid_secret"))
    return misconfigured ? misconfiguredResponse() : new Response("Invalid webhook", { status: 400 })
  }

  const handle = request.handlerFor(event.type)
  if (handle) {
    try {
      await handle(event)
    } catch (error) {
      await request.report(error, event)
      return new Response("Webhook handler failed", { status: 500 })
    }
  }
  return new Response(null, { status: 204 })
}

/**
 * The raw body can no longer be read: something before the endpoint consumed
 * it (a framework adapter throws this; `webhookHandler` never does). Answered
 * 500 — the endpoint's fault, so the event is retried once it is fixed.
 */
export class WebhookBodyUnavailableError extends Error {
  override readonly name = "WebhookBodyUnavailableError"
}

/** @internal 500, so Charchy Send retries the event once the endpoint is fixed. */
export function misconfiguredResponse(): Response {
  return new Response("Webhook endpoint misconfigured", { status: 500 })
}

export class Webhooks {
  /** See `verifyWebhook`: verifies the request and returns the typed event, or throws `WebhookVerificationError`. */
  verify(params: VerifyWebhookParams): Promise<WebhookEvent> {
    return verifyWebhook(params)
  }

  /** See `webhookHandler`: a ready `(request: Request) => Promise<Response>` endpoint. */
  handler(handlers: WebhookHandlers, options?: WebhookHandlerOptions): (request: Request) => Promise<Response> {
    return webhookHandler(handlers, options)
  }
}

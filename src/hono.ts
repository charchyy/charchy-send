/**
 * `@charchy/send/hono` — Charchy Send for Hono apps.
 *
 *   import { charchySend, charchyWebhook, type CharchySendVariables } from "@charchy/send/hono"
 *
 *   const app = new Hono<{ Bindings: Env; Variables: CharchySendVariables }>()
 *   app.use("/api/*", charchySend())
 *   app.post("/api/signup", async (c) => {
 *     await c.var.charchySend.emails.send({ … })
 *   })
 *   app.post("/webhooks/charchy", charchyWebhook({ "email.bounced": (event, c) => … }))
 *
 * Why a subpath: on Cloudflare Workers, secrets arrive per request as
 * bindings on `c.env`, not in `process.env`, so `new CharchySend()` and
 * `webhookHandler()` with no arguments find no key there. These read the
 * binding first, then `process.env` (Node, Bun, Deno 2, Vercel), then
 * `Deno.env`.
 *
 * Types only from `hono` (a peer dependency of this subpath): nothing here
 * imports it at run time, and the root entry never imports this file.
 */

import type { Context, Env, Handler, MiddlewareHandler } from "hono"
import { CharchySend, type CharchySendOptions } from "./client.js"
import { readEnv } from "./runtime.js"
import { answerWebhook, WebhookBodyUnavailableError, webhookErrorReporter, type WebhookEvent, type WebhookEventType } from "./webhooks.js"

export { WebhookBodyUnavailableError } from "./webhooks.js"

// ─── Reading a secret ───────────────────────────────────────────────

/** A string, or a function of the request — e.g. `(c) => c.env.SEND_KEY`, or an async Secrets Store binding `(c) => c.env.SEND_KEY.get()`. */
export type HonoSecretSource<E extends Env = any> = string | ((c: Context<E>) => string | undefined | Promise<string | undefined>)

type DenoLike = { env?: { get(name: string): string | undefined } }

/** `c.env[name]` (Workers bindings), else `process.env[name]`, else `Deno.env.get(name)` — the first non-empty string. */
function readHonoEnv(c: Context, name: string): string | undefined {
  const bindings: unknown = c.env
  if (bindings !== null && typeof bindings === "object") {
    const value = (bindings as Record<string, unknown>)[name]
    if (typeof value === "string" && value.length > 0) return value
  }
  const fromProcess = readEnv(name)
  if (fromProcess !== undefined) return fromProcess
  // Deno 1 has no `process`. Without --allow-env, Deno throws its own permission error here (as `process.env` does on Deno 2): left to surface.
  const value = (globalThis as { Deno?: DenoLike }).Deno?.env?.get(name)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

async function resolveSecret(c: Context, source: HonoSecretSource | undefined, envName: string): Promise<string | undefined> {
  if (typeof source === "function") return (await source(c)) || undefined
  return source ?? readHonoEnv(c, envName)
}

// ─── The client middleware ──────────────────────────────────────────

export const DEFAULT_VARIABLE = "charchySend"

/** What `charchySend()` sets: `c.var.charchySend` (or the name you passed as `variable`). */
export type CharchySendVariables<Name extends string = typeof DEFAULT_VARIABLE> = { [Key in Name]: CharchySend }

export type CharchySendMiddlewareOptions<Name extends string = typeof DEFAULT_VARIABLE> = CharchySendOptions & {
  /** Default: the `CHARCHY_SEND_KEY` binding (`c.env`), else `process.env.CHARCHY_SEND_KEY`. Read on each request. */
  apiKey?: HonoSecretSource
  /** The context variable to set. Default `"charchySend"`. */
  variable?: Name
}

/** Clients kept per key; more than this many keys in one isolate means something is rotating keys per request. */
const MAX_CACHED_CLIENTS = 8

/**
 * Sets `c.var.charchySend` — a `CharchySend` client — for the routes after it.
 * The key is read on each request: `apiKey`, else the `CHARCHY_SEND_KEY`
 * binding on `c.env`, else `process.env.CHARCHY_SEND_KEY`. One client is
 * kept per key, not built per request. With no key the client is still set:
 * its calls return `missing_api_key`, nothing sent. Options are checked now,
 * so a bad `maxRetries` throws when the app is built, not on a request.
 */
export function charchySend<const Name extends string = typeof DEFAULT_VARIABLE>(
  options: CharchySendMiddlewareOptions<Name> = {}
): MiddlewareHandler<{ Variables: CharchySendVariables<Name> }> {
  const { apiKey, variable, ...clientOptions } = options
  const name = (variable ?? DEFAULT_VARIABLE) as Name
  if (typeof name !== "string" || name.length === 0) throw new Error("[@charchy/send] `variable` must be a non-empty string.")

  // Built now so a bad option throws at startup; it is also the client for a fixed key.
  const first = new CharchySend(typeof apiKey === "string" ? apiKey : undefined, clientOptions)
  const clients = new Map<string, CharchySend>()

  const clientFor = (key: string | undefined): CharchySend => {
    if (typeof apiKey === "string") return first
    const cacheKey = key ?? ""
    let client = clients.get(cacheKey)
    if (!client) {
      // No key: a client that reads process.env per request and returns missing_api_key until there is one.
      client = key === undefined ? first : new CharchySend(key, clientOptions)
      if (clients.size >= MAX_CACHED_CLIENTS) clients.delete(clients.keys().next().value as string)
      clients.set(cacheKey, client)
    }
    return client
  }

  return async (c, next) => {
    const key = typeof apiKey === "string" ? apiKey : await resolveSecret(c, apiKey, "CHARCHY_SEND_KEY")
    // `set` is typed from the variable name; this middleware's own Env says it is a CharchySend.
    ;(c.set as (key: string, value: CharchySend) => void)(name, clientFor(key))
    await next()
  }
}

// ─── The webhook endpoint ───────────────────────────────────────────

/** One function per event type; each gets that event, typed, and the Hono context (`c.env`, `c.var`, `c.executionCtx`). */
export type HonoWebhookHandlers<E extends Env = any> = {
  [Type in WebhookEventType]?: (event: Extract<WebhookEvent, { type: Type }>, c: Context<E>) => unknown
}

export type CharchyWebhookOptions<E extends Env = any> = {
  /** `whsec_…`. Default: the `CHARCHY_WEBHOOK_SECRET` binding (`c.env`), else `process.env.CHARCHY_WEBHOOK_SECRET`. Read on each request. */
  secret?: HonoSecretSource<E>
  /** Told about every refused request and every handler that threw (default: `console.error` for handler failures only). Its own errors are ignored. */
  onError?: (error: unknown, event: WebhookEvent | null, c: Context<E>) => unknown
}

/**
 * The raw body, byte for byte. Hono caches body reads on `c.req`: when
 * nothing has read it, or a middleware read it as text, bytes or a blob,
 * `c.req.arrayBuffer()` returns the exact bytes (Charchy Send sends UTF-8
 * JSON, which a text round trip keeps; `c.req.json()` caches the text from
 * Hono 4.9). A body parsed as JSON by Hono before 4.9 (cached parsed), read
 * as form data, or read straight from `c.req.raw` cannot be recovered
 * exactly, and no signature would match it.
 */
async function readRawBody(c: Context): Promise<Uint8Array> {
  const cached = Object.keys(c.req.bodyCache ?? {})
  const exact = cached.length === 0 ? !c.req.raw.bodyUsed : cached.some((key) => key === "arrayBuffer" || key === "text" || key === "blob")
  if (!exact) {
    throw new WebhookBodyUnavailableError(
      cached.length === 0
        ? "The request body was read from c.req.raw before the Charchy Send webhook handler, so its raw bytes are gone. Register the webhook route before that middleware, or read the body with c.req.text()."
        : `The request body was already parsed (as ${cached.join(", ")}) before the Charchy Send webhook handler, so its raw bytes are gone and no signature can match. Register the webhook route before that middleware.`
    )
  }
  return new Uint8Array(await c.req.arrayBuffer())
}

/**
 * A complete webhook endpoint as a Hono handler:
 *
 *   app.post("/webhooks/charchy", charchyWebhook({
 *     "email.bounced": (event, c) => markBounced(c.env.DB, event.data.recipient),
 *   }))
 *
 * The same answers as `webhookHandler` — 204 handled, 400 not a valid
 * Charchy Send request, 405 not a POST, 500 a handler threw or the secret is
 * missing or malformed — plus 500 when the raw body was consumed before this
 * handler. The secret is `secret`, else the `CHARCHY_WEBHOOK_SECRET` binding,
 * else `process.env.CHARCHY_WEBHOOK_SECRET`. Handlers run before the answer:
 * on Workers, hand slow work to `c.executionCtx.waitUntil(…)` or a queue.
 */
export function charchyWebhook<E extends Env = any>(handlers: HonoWebhookHandlers<E>, options: CharchyWebhookOptions<E> = {}): Handler<E> {
  const { onError } = options
  return (c: Context<E>): Promise<Response> =>
    answerWebhook({
      method: c.req.method,
      headers: c.req.raw.headers,
      readPayload: () => readRawBody(c),
      resolveSecret: () => resolveSecret(c, options.secret as HonoSecretSource | undefined, "CHARCHY_WEBHOOK_SECRET"),
      handlerFor: (type) => {
        const handle = handlers[type] as ((event: WebhookEvent, c: Context<E>) => unknown) | undefined
        return handle && ((event: WebhookEvent) => handle(event, c))
      },
      report: webhookErrorReporter(
        onError
          ? (error, event) => onError(error, event, c)
          : // The default logs handler failures; a consumed body is a bug in this app, so it is logged too.
            (error, event) => {
              if (event) console.error(`[@charchy/send] The ${event.type} webhook handler threw:`, error)
              else if (error instanceof WebhookBodyUnavailableError) console.error(`[@charchy/send] ${error.message}`)
            }
      ),
    })
}

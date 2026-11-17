import { Emails } from "./resources/emails.js"
import { Images, UsageResource } from "./resources/images-and-usage.js"
import { resolveApiKey, type KeyMode } from "./apiKey.js"
import { INSPECT, warnIfBrowser } from "./runtime.js"
import { testAddress } from "./testing.js"
import { maskKey, type FetchLike, type TransportConfig } from "./transport.js"
import type { SimulatedOutcome } from "./types.js"
import { VERSION } from "./version.js"
import { Webhooks } from "./webhooks.js"

export type CharchySendOptions = {
  /** Default `https://api.charchy.krd`. Must be https (http only for localhost). */
  baseUrl?: string
  /** Extra attempts after the first, for answers that are safe to retry. Default 2; 0 turns retries off. */
  maxRetries?: number
  /** Per attempt, in milliseconds. Default 30 000; at most 600 000. */
  timeoutMs?: number
  /** A custom `fetch` (a proxy agent, a test double). Default: the global `fetch`. */
  fetch?: FetchLike
  /** Appended to the User-Agent, e.g. `"my-app/2.3"`. Printable ASCII only. */
  userAgent?: string
}

export type { KeyMode } from "./apiKey.js"

export const DEFAULT_BASE_URL = "https://api.charchy.krd"
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

function configError(message: string): Error {
  return new Error(`[@charchy/send] ${message}`)
}

function readBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw configError("baseUrl is not a URL. Leave it out to use https://api.charchy.krd.")
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw configError("baseUrl must be https:// (http:// only for localhost): the API key travels with every request.")
  }
  if (url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw configError("baseUrl can't have a query, a fragment or credentials.")
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
}

/**
 * The Charchy Send client.
 *
 *   const send = new CharchySend()                 // reads CHARCHY_SEND_KEY
 *   const { data, error } = await send.emails.send({ … })
 *
 * API methods never throw: they resolve to `{ data, error, headers, meta }`.
 * Creating the client never needs the key: it is read (from the argument,
 * else `CHARCHY_SEND_KEY`) when a request is made, so a client at the top of
 * a module is safe in `next build` and deploys without runtime secrets. A
 * missing or malformed key comes back from the first call as
 * `missing_api_key` / `invalid_api_key`, with nothing sent.
 * The key lives in a private field: logging the client shows only `chy_live_…1a2b`.
 */
export class CharchySend {
  readonly emails: Emails
  readonly images: Images
  readonly usage: UsageResource
  readonly webhooks: Webhooks
  /** Test-mode helpers. */
  readonly test: {
    /** A magic address with a known outcome: `send.test.address("bounced", "signup-42")` → `"bounced+signup-42@sim.charchy.krd"`. */
    address(outcome: SimulatedOutcome, label?: string): string
  }
  readonly #explicitKey: string | undefined
  readonly #baseUrl: string

  constructor(apiKey?: string, options: CharchySendOptions = {}) {
    warnIfBrowser()
    // Options are code, checked now; the key is environment, checked per request (./apiKey.ts).
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw configError("maxRetries must be a whole number from 0 to 10.")
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw configError(`timeoutMs must be more than 0 and at most ${MAX_TIMEOUT_MS}.`)
    }
    if (options.userAgent !== undefined && !/^[\x20-\x7e]{1,200}$/.test(options.userAgent)) {
      throw configError("userAgent must be 1–200 printable ASCII characters (no line breaks).")
    }

    this.#explicitKey = apiKey
    this.#baseUrl = readBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    const config: TransportConfig = {
      resolveKey: () => resolveApiKey(apiKey),
      baseUrl: this.#baseUrl,
      maxRetries,
      timeoutMs,
      // Called through globalThis: a detached `fetch` throws "Illegal invocation" on Workers.
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      userAgent: `charchy-send-node/${VERSION}${options.userAgent ? ` ${options.userAgent}` : ""}`,
    }
    this.emails = new Emails(config)
    this.images = new Images(config)
    this.usage = new UsageResource(config)
    this.webhooks = new Webhooks()
    this.test = { address: testAddress }
  }

  /**
   * `"test"` or `"live"` from the key — read now, like a request would — or
   * `null` while there is no valid key (none passed and `CHARCHY_SEND_KEY`
   * unset, or one that isn't shaped like a key).
   */
  get mode(): KeyMode | null {
    const resolved = resolveApiKey(this.#explicitKey)
    return resolved.ok ? resolved.mode : null
  }

  /** What `console.log(send)` and `util.inspect(send)` show: never the key. */
  [INSPECT](): object {
    return this.toJSON()
  }

  /** What `JSON.stringify(send)` shows: never the key — its masked form, or null while there is none. */
  toJSON(): { mode: KeyMode | null; key: string | null; baseUrl: string } {
    const resolved = resolveApiKey(this.#explicitKey)
    return { mode: resolved.ok ? resolved.mode : null, key: resolved.ok ? maskKey(resolved.key) : null, baseUrl: this.#baseUrl }
  }
}

import { Emails } from "./resources/emails.js"
import { Images, UsageResource } from "./resources/images-and-usage.js"
import { INSPECT, readEnv, warnIfBrowser } from "./runtime.js"
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

/** `test` for a `chy_test_` key (never sends, never charges), `live` for `chy_live_`. */
export type KeyMode = "test" | "live"

export const DEFAULT_BASE_URL = "https://api.charchy.krd"
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
/** The exact shape of a Charchy Send key. */
const KEY_PATTERN = /^chy_(live|test)_[0-9a-f]{64}$/
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
 * The key lives in a private field: logging the client shows only `chy_live_…1a2b`.
 */
export class CharchySend {
  readonly emails: Emails
  readonly images: Images
  readonly usage: UsageResource
  readonly webhooks: Webhooks
  /** `"test"` or `"live"`, from the key. */
  readonly mode: KeyMode
  /** Test-mode helpers. */
  readonly test: {
    /** A magic address with a known outcome: `send.test.address("bounced", "signup-42")` → `"bounced+signup-42@sim.charchy.krd"`. */
    address(outcome: SimulatedOutcome, label?: string): string
  }
  readonly #maskedKey: string
  readonly #baseUrl: string

  constructor(apiKey?: string, options: CharchySendOptions = {}) {
    warnIfBrowser()
    const key = (apiKey ?? readEnv("CHARCHY_SEND_KEY"))?.trim()
    if (!key) {
      throw configError("Missing API key. Pass it to new CharchySend(key), or set CHARCHY_SEND_KEY. Create keys under API keys in the Charchy dashboard.")
    }
    const match = KEY_PATTERN.exec(key)
    if (!match) {
      // Never echo any of it: a wrong secret pasted here is still a secret.
      throw configError(
        `That is not a Charchy Send API key: expected chy_live_ or chy_test_ followed by 64 lowercase hex characters (73 in all); got ${key.length} characters.`
      )
    }
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw configError("maxRetries must be a whole number from 0 to 10.")
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw configError(`timeoutMs must be more than 0 and at most ${MAX_TIMEOUT_MS}.`)
    }
    if (options.userAgent !== undefined && !/^[\x20-\x7e]{1,200}$/.test(options.userAgent)) {
      throw configError("userAgent must be 1–200 printable ASCII characters (no line breaks).")
    }

    this.mode = match[1] === "live" ? "live" : "test"
    this.#maskedKey = maskKey(key)
    this.#baseUrl = readBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    const config: TransportConfig = {
      apiKey: key,
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

  /** What `console.log(send)` and `util.inspect(send)` show: never the key. */
  [INSPECT](): object {
    return this.toJSON()
  }

  /** What `JSON.stringify(send)` shows: never the key. */
  toJSON(): { mode: KeyMode; key: string; baseUrl: string } {
    return { mode: this.mode, key: this.#maskedKey, baseUrl: this.#baseUrl }
  }
}

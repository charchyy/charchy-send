/**
 * The API key, resolved when a request is made — never when the client is
 * created. A client built at the top of a module therefore survives places
 * that load code without runtime secrets (`next build`, a deploy that
 * analyses modules): only an actual request needs the key. Reading
 * `CHARCHY_SEND_KEY` at request time also picks up a key set after the client
 * was created.
 *
 * Missing → `missing_api_key`; present but not shaped like a key →
 * `invalid_api_key` — the API's own codes, returned locally with
 * `statusCode: null`, nothing sent. The message never echoes the value.
 */

import { CharchySendError } from "./errors.js"
import { readEnv } from "./runtime.js"

/** `test` for a `chy_test_` key (never sends, never charges), `live` for `chy_live_`. */
export type KeyMode = "test" | "live"

/** The exact shape of a Charchy Send key. */
const KEY_PATTERN = /^chy_(live|test)_[0-9a-f]{64}$/

export type KeyResolution = { ok: true; key: string; mode: KeyMode } | { ok: false; error: CharchySendError }

export function resolveApiKey(explicitKey: string | undefined): KeyResolution {
  const key = (explicitKey ?? readEnv("CHARCHY_SEND_KEY"))?.trim()
  if (!key) {
    return {
      ok: false,
      error: new CharchySendError({
        code: "missing_api_key",
        message:
          "No API key: pass it to new CharchySend(key), or set CHARCHY_SEND_KEY in this server's environment. Create keys under API keys in the Charchy dashboard.",
        statusCode: null,
      }),
    }
  }
  const match = KEY_PATTERN.exec(key)
  if (!match) {
    return {
      ok: false,
      error: new CharchySendError({
        code: "invalid_api_key",
        // Never echo any of it: a wrong secret pasted here is still a secret.
        message: `That is not a Charchy Send API key: expected chy_live_ or chy_test_ followed by 64 lowercase hex characters (73 in all); got ${key.length} characters.`,
        statusCode: null,
      }),
    }
  }
  return { ok: true, key, mode: match[1] === "live" ? "live" : "test" }
}

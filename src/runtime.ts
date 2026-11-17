/**
 * What the SDK needs from the runtime, read defensively: Node 18+, Bun,
 * Deno, Vercel Edge and Cloudflare Workers all have `fetch`, `Headers`,
 * `TextEncoder`, `btoa` and (except Node 18) a global Web Crypto. Nothing
 * here imports a Node module at the top level.
 */

type ProcessLike = { env?: Record<string, string | undefined> }

/** An environment variable, or undefined where there is no `process` (edge runtimes without it). */
export function readEnv(name: string): string | undefined {
  const runtime = (globalThis as { process?: ProcessLike }).process
  const value = runtime?.env?.[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

let browserWarningShown = false

/** Warn once when the client is created in a browser: keys belong on servers. */
export function warnIfBrowser(): void {
  if (browserWarningShown) return
  if (typeof window === "undefined" || typeof document === "undefined") return
  browserWarningShown = true
  console.warn(
    "[@charchy/send] This looks like a browser. API keys belong on your server: anyone can read a key shipped to a browser, " +
      "and the API sends no CORS headers, so these requests fail anyway. Send email from server code. https://charchy.krd/docs/api-keys"
  )
}

/** For tests only. */
export function resetBrowserWarning(): void {
  browserWarningShown = false
}

/**
 * Web Crypto. Global everywhere but Node 18, where it lives on
 * `node:crypto` — imported only then, with a specifier bundlers leave alone.
 */
export async function webCrypto(): Promise<Crypto> {
  const global = (globalThis as { crypto?: Crypto }).crypto
  if (global?.subtle) return global
  // Built at run time: a literal would be bundled (or refused) by edge bundlers that never reach this line.
  const specifier = ["node", "crypto"].join(":")
  const nodeCrypto = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as { webcrypto?: Crypto }
  if (!nodeCrypto.webcrypto?.subtle) throw new Error("[@charchy/send] Web Crypto is not available in this runtime.")
  return nodeCrypto.webcrypto
}

export async function randomUUID(): Promise<string> {
  return (await webCrypto()).randomUUID()
}

const BASE64_CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  const NodeBuffer = (globalThis as { Buffer?: { from(bytes: Uint8Array): { toString(encoding: "base64"): string } } }).Buffer
  if (NodeBuffer) return NodeBuffer.from(bytes).toString("base64")
  let binary = ""
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK))
  }
  return btoa(binary)
}

/** Throws on input that is not base64. */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Node's `util.inspect` hook (also used by `console.log`), by its registered symbol: no `node:util` import. */
export const INSPECT: unique symbol = Symbol.for("nodejs.util.inspect.custom") as never

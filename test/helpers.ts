import { createHmac, randomBytes } from "node:crypto"
import { vi } from "vitest"
import { CharchySend, type CharchySendOptions } from "../src/index.js"

export const TEST_KEY = `chy_test_${"a".repeat(64)}`

export type RecordedCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  rawBody: BodyInit | null | undefined
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | Error

/** A `fetch` that answers from a queue and records every request. */
export function fakeFetch(...replies: Reply[]) {
  const calls: RecordedCall[] = []
  const queue = [...replies]
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]))
    const rawBody = init.body
    calls.push({ url, method: init.method ?? "GET", headers, rawBody, body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody })
    const reply = queue.shift()
    if (reply === undefined) throw new Error(`fakeFetch: no reply queued for call ${calls.length}`)
    if (reply instanceof Error) throw reply
    const body = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json))
    const nullBodyStatus = [204, 205, 304].includes(reply.status ?? 200)
    return new Response(nullBodyStatus ? null : body, {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", "x-request-id": `req_${calls.length}`, ...reply.headers },
    })
  })
  return { fetch, calls }
}

export function clientWith(fetch: CharchySendOptions["fetch"], options: CharchySendOptions = {}) {
  return new CharchySend(TEST_KEY, { fetch, ...options })
}

export function apiError(status: number, code: string, message = "Refused.", extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Reply {
  return { status, json: { error: { code, message, docs: `https://charchy.krd/docs/errors#${code}`, ...extra } }, headers }
}

/**
 * Test-only Standard Webhooks signer with node:crypto — an implementation
 * independent of the SDK's. test/webhooks.test.ts checks it against vectors
 * recorded from Charchy Send's own signer (test/fixtures/webhook-vectors.json).
 */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`
}

export function signedHeaders(secrets: string[], message: { id: string; timestamp: number; body: string }) {
  const signatures = secrets.map((secret) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
    return `v1,${createHmac("sha256", key).update(`${message.id}.${message.timestamp}.${message.body}`).digest("base64")}`
  })
  return { "webhook-id": message.id, "webhook-timestamp": String(message.timestamp), "webhook-signature": signatures.join(" ") }
}

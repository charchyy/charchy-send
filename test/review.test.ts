/**
 * Regressions for the pre-release review (2026-11-17): each finding as a test.
 */
import { inspect } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CharchySend, verifyWebhook, WebhookVerificationError } from "../src/index.js"
import { clientWith, fakeFetch, TEST_KEY } from "./helpers.js"

const LIVE_KEY = `chy_live_${"0123456789abcdef".repeat(4)}`
const SECRET_PART = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const leaks = (text: string) => text.includes(SECRET_PART)

describe("H1: the key never shows in logs", () => {
  it("inspect, console formatting and JSON of the client and its resources show only the masked key", () => {
    const send = new CharchySend(LIVE_KEY, { fetch: fakeFetch().fetch })
    for (const target of [send, send.emails, send.images, send.usage, send.webhooks]) {
      expect(leaks(inspect(target, { depth: 10, showHidden: true }))).toBe(false)
      expect(leaks(JSON.stringify(target))).toBe(false)
    }
    expect(JSON.parse(JSON.stringify(send))).toEqual({ mode: "live", key: "chy_live_…cdef", baseUrl: "https://api.charchy.krd" })
    expect(inspect(send)).toContain("chy_live_…cdef")
    expect(Object.keys(send)).not.toContain("config")
  })

  it("results and errors never contain the key", async () => {
    const { fetch } = fakeFetch({ status: 500, json: { error: { code: "internal_error", message: "x" } } })
    const result = await new CharchySend(LIVE_KEY, { fetch, maxRetries: 0 }).usage.get()
    expect(leaks(inspect(result, { depth: 10 }))).toBe(false)
    expect(leaks(JSON.stringify(result))).toBe(false)
  })

  it("a runtime error that echoes the Authorization header is scrubbed, cause included", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      throw new TypeError(`Headers.append: "${(init.headers as Record<string, string>).Authorization}" is an invalid header value.`)
    })
    const result = await new CharchySend(LIVE_KEY, { fetch, maxRetries: 0 }).usage.get()
    expect(result.error?.code).toBe("network_error")
    expect(leaks(result.error!.message)).toBe(false)
    expect(result.error!.message).toContain("chy_live_…cdef")
    expect(leaks(inspect(result.error, { depth: 10 }))).toBe(false)
  })
})

describe("H2: keys, user agents and idempotency keys are checked before anything is sent", () => {
  it("trims the key and requires the API's exact format", () => {
    expect(new CharchySend(`  ${TEST_KEY}\n`).mode).toBe("test")
    for (const bad of [`${TEST_KEY.slice(0, -1)}\n`, `chy_live_${"A".repeat(64)}`, `chy_live_${"a".repeat(63)}`, `chy_live_${"a".repeat(32)}\r\n${"a".repeat(32)}`, `chy_live_SECRET​SECRET`]) {
      expect(() => new CharchySend(bad)).toThrow(/64 lowercase hex/)
    }
  })

  it("L1: the refusal never echoes the input — only what was expected and the length", () => {
    let message = ""
    try {
      new CharchySend("whsec_ABCDEFGHIJKL")
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("got 18 characters")
    expect(message).not.toMatch(/whsec|ABCD/)
  })

  it("refuses a user agent with a line break", () => {
    expect(() => new CharchySend(TEST_KEY, { userAgent: "x\r\nX-Evil: 1" })).toThrow(/userAgent/)
  })

  it("refuses an idempotency key with a line break or non-ASCII locally, without a request or a retry", async () => {
    const { fetch } = fakeFetch()
    const send = clientWith(fetch)
    for (const idempotencyKey of ["a\r\nb", "", "x".repeat(257), "داواکاری/1"]) {
      const result = await send.emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" }, { idempotencyKey })
      expect(result.error).toMatchObject({ code: "validation_error", field: "idempotencyKey", statusCode: null })
      expect(result.meta).toBeNull()
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("M1: redirects are never followed", () => {
  it("asks fetch not to follow, and a 3xx is invalid_response, not retried", async () => {
    const { fetch, calls } = fakeFetch({ status: 307, text: "", headers: { location: "https://elsewhere.example/steal" } })
    const result = await clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" })
    expect(result.error).toMatchObject({ code: "invalid_response", statusCode: 307 })
    expect(calls).toHaveLength(1)
    expect((fetch.mock.calls[0]![1] as RequestInit).redirect).toBe("manual")
  })

  it("an opaque redirect (a browser-style fetch) is refused too", async () => {
    const opaque = Object.assign(new Response(null, { status: 200 }), {})
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" })
    const result = await clientWith(async () => opaque).usage.get()
    expect(result.error?.code).toBe("invalid_response")
  })
})

describe("M2: baseUrl", () => {
  it("must be https (http only for localhost), with no query, fragment or credentials", () => {
    expect(() => new CharchySend(TEST_KEY, { baseUrl: "http://api.charchy.krd" })).toThrow(/https/)
    expect(() => new CharchySend(TEST_KEY, { baseUrl: "api.charchy.krd" })).toThrow(/not a URL/)
    expect(() => new CharchySend(TEST_KEY, { baseUrl: "https://api.charchy.krd/?x=1" })).toThrow(/query/)
    expect(() => new CharchySend(TEST_KEY, { baseUrl: "https://api.charchy.krd/#x" })).toThrow(/fragment/)
    expect(() => new CharchySend(TEST_KEY, { baseUrl: "https://u:p@api.charchy.krd" })).toThrow(/credentials/)
    expect(() => new CharchySend(TEST_KEY, { baseUrl: "http://localhost:3211" })).not.toThrow()
    expect(() => new CharchySend(TEST_KEY, { baseUrl: "http://127.0.0.1:3211" })).not.toThrow()
    expect(() => new CharchySend(TEST_KEY, { baseUrl: "http://[::1]:3211" })).not.toThrow()
  })

  it("normalises trailing slashes", async () => {
    const { fetch, calls } = fakeFetch({ json: { plan: null } })
    await clientWith(fetch, { baseUrl: "https://sandbox.example.com///" }).usage.get()
    expect(calls[0]!.url).toBe("https://sandbox.example.com/v1/usage")
  })
})

describe("M3: email ids are checked before they become a path", () => {
  it("refuses '..', '.', '' and anything not em_… for get, update, cancel and waitFor", async () => {
    const { fetch } = fakeFetch()
    const send = clientWith(fetch)
    for (const id of ["..", ".", "", "em_../usage", "em_1?x=1", "img_123"]) {
      expect((await send.emails.get(id)).error).toMatchObject({ code: "validation_error", field: "id" })
      expect((await send.emails.update(id, { scheduledAt: "1h" })).error).toMatchObject({ code: "validation_error", field: "id" })
      expect((await send.emails.cancel(id)).error).toMatchObject({ code: "validation_error", field: "id" })
      expect((await send.emails.waitFor(id)).error).toMatchObject({ code: "validation_error", field: "id" })
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("M4: webhook payloads must be the raw body", () => {
  it("a parsed object is invalid_payload with a hint, not a RangeError", async () => {
    const headers = { "webhook-id": "a", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" }
    const attempt = verifyWebhook({ payload: { a: 1 } as never, headers, secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" })
    await expect(attempt).rejects.toBeInstanceOf(WebhookVerificationError)
    await expect(attempt).rejects.toMatchObject({ reason: "invalid_payload", message: expect.stringMatching(/express\.json\(\)/) })
  })

  it("a signature mismatch says to pass the raw body", async () => {
    const headers = { "webhook-id": "a", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" }
    await expect(verifyWebhook({ payload: "{}", headers, secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" })).rejects.toMatchObject({
      reason: "invalid_signature",
      message: expect.stringMatching(/raw body/),
    })
  })
})

describe("M5: a 2xx without a JSON body is never a silent success", () => {
  it.each([
    ["an empty 204", { status: 204, text: "" }],
    ["an empty 200", { status: 200, text: "" }],
    ["whitespace", { status: 200, text: "  \n" }],
    ["JSON null", { status: 200, text: "null" }],
    ["HTML", { status: 200, text: "<html></html>" }],
  ])("%s is invalid_response", async (_name, reply) => {
    const { fetch } = fakeFetch(reply)
    const result = await clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" })
    expect(result.data).toBeNull()
    expect(result.error?.code).toBe("invalid_response")
  })
})

describe("L3: expiresAt is checked against now and scheduledAt", () => {
  it("refuses an expiry already past or not after the send time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-17T10:00:00Z"))
    const { fetch } = fakeFetch({ json: { id: "em_1", status: "scheduled" } })
    const send = clientWith(fetch)
    const base = { from: "a@x.example", to: "b@x.example", subject: "s", text: "t" }
    expect((await send.emails.send({ ...base, expiresAt: "2026-11-17T09:59:00Z" })).error).toMatchObject({ field: "expiresAt" })
    expect((await send.emails.send({ ...base, scheduledAt: "2h", expiresAt: "10m" })).error).toMatchObject({ field: "expiresAt" })
    expect((await send.emails.batch([base, { ...base, scheduledAt: "1d", expiresAt: "1d" }])).error).toMatchObject({ field: "emails[1].expiresAt" })
    expect((await send.emails.send({ ...base, scheduledAt: "2h", expiresAt: "3h" })).error).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe("L4: timeoutMs", () => {
  it("must be finite, above 0 and at most 600 000", () => {
    for (const timeoutMs of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 600_001]) {
      expect(() => new CharchySend(TEST_KEY, { timeoutMs })).toThrow(/timeoutMs/)
    }
    expect(() => new CharchySend(TEST_KEY, { timeoutMs: 600_000 })).not.toThrow()
  })
})

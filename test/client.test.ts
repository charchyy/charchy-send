import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CharchySend, VERSION } from "../src/index.js"
import { resetBrowserWarning } from "../src/runtime.js"
import { parseDuration } from "../src/time.js"
import { MAX_RETRY_AFTER_SECONDS, retryDelayMs } from "../src/transport.js"
import { CharchySendError } from "../src/errors.js"
import { apiError, clientWith, fakeFetch, TEST_KEY } from "./helpers.js"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetBrowserWarning()
})

describe("new CharchySend()", () => {
  it("reads CHARCHY_SEND_KEY when no key is passed", async () => {
    vi.stubEnv("CHARCHY_SEND_KEY", TEST_KEY)
    const { fetch, calls } = fakeFetch({ json: { plan: null } })
    await new CharchySend(undefined, { fetch }).usage.get()
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it("never needs the key to be created; bad options still throw at once", () => {
    vi.stubEnv("CHARCHY_SEND_KEY", "")
    expect(() => new CharchySend()).not.toThrow()
    expect(() => new CharchySend("re_123456789")).not.toThrow()
    expect(() => new CharchySend(TEST_KEY, { maxRetries: -1 })).toThrow(/maxRetries/)
  })

  it("uses baseUrl and the userAgent suffix", async () => {
    const { fetch, calls } = fakeFetch({ json: { plan: null } })
    await clientWith(fetch, { baseUrl: "https://sandbox.example.com/", userAgent: "my-app/2.3" }).usage.get()
    expect(calls[0]!.url).toBe("https://sandbox.example.com/v1/usage")
    expect(calls[0]!.headers["user-agent"]).toBe(`charchy-send-node/${VERSION} my-app/2.3`)
  })

  it("warns once in a browser", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubGlobal("window", {})
    vi.stubGlobal("document", {})
    new CharchySend(TEST_KEY)
    new CharchySend(TEST_KEY)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/belong on your server/)
  })

  it("does not warn on a server", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    new CharchySend(TEST_KEY)
    expect(warn).not.toHaveBeenCalled()
  })

  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})

describe("retries", () => {
  it("honours Retry-After on 429, then succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { fetch } = fakeFetch(apiError(429, "rate_limit_exceeded", "Slow down.", {}, { "retry-after": "2" }), { json: { plan: null } })
    const pending = clientWith(fetch).usage.get()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).data).toEqual({ plan: null })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("returns a daily cap whose Retry-After is long at once, with retryAfterSeconds", async () => {
    const { fetch } = fakeFetch(apiError(429, "daily_limit_reached", "Daily cap.", {}, { "retry-after": "7200" }))
    const result = await clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.error).toMatchObject({ code: "daily_limit_reached", statusCode: 429, retryAfterSeconds: 7200 })
  })

  it("gives up after maxRetries and returns the last error", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { fetch } = fakeFetch(apiError(503, "sending_unavailable"), apiError(503, "sending_unavailable"), apiError(503, "sending_unavailable"))
    const pending = clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" })
    await vi.runAllTimersAsync()
    expect((await pending).error?.code).toBe("sending_unavailable")
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("does not repeat an image upload after a network error or 500, only after a 429", async () => {
    const network = fakeFetch(new TypeError("socket hang up"))
    expect((await clientWith(network.fetch).images.upload(new Uint8Array([1]))).error?.code).toBe("network_error")
    expect(network.fetch).toHaveBeenCalledTimes(1)

    const serverError = fakeFetch(apiError(500, "internal_error"))
    await clientWith(serverError.fetch).images.upload(new Uint8Array([1]))
    expect(serverError.fetch).toHaveBeenCalledTimes(1)

    vi.spyOn(Math, "random").mockReturnValue(0)
    const limited = fakeFetch(apiError(429, "rate_limit_exceeded", "Slow.", {}, { "retry-after": "0" }), {
      json: { id: "img_1", url: "https://files.charchy.krd/i/1/logo.png", content_type: "image/png", size: 1 },
    })
    const uploaded = await clientWith(limited.fetch).images.upload(new Uint8Array([1]), { filename: "logo.png", contentType: "image/png" })
    expect(uploaded.data).toEqual({ id: "img_1", url: "https://files.charchy.krd/i/1/logo.png", contentType: "image/png", size: 1 })
    const form = limited.calls[1]!.rawBody as FormData
    expect((form.get("file") as File).name).toBe("logo.png")
  })

  it("decides retries by the published table", () => {
    const answer = (status: number) => ({ kind: "answer" as const, status, headers: {}, body: null, bodyIsJson: true })
    const error = (code: string, retryAfterSeconds?: number) =>
      new CharchySendError({ code: code as never, message: "", statusCode: 0, retryAfterSeconds })
    const random = () => 0
    expect(retryDelayMs(answer(402), error("insufficient_balance"), "repeatable", 0, random)).toBeNull()
    expect(retryDelayMs(answer(409), error("idempotency_conflict"), "repeatable", 0, random)).toBeNull()
    expect(retryDelayMs(answer(422), error("schedule_out_of_range"), "repeatable", 0, random)).toBeNull()
    expect(retryDelayMs(answer(409), error("idempotency_in_flight", 1), "repeatable", 0, random)).toBe(1_000)
    expect(retryDelayMs(answer(429), error("rate_limit_exceeded", MAX_RETRY_AFTER_SECONDS + 1), "repeatable", 0, random)).toBeNull()
    expect(retryDelayMs(answer(500), error("internal_error"), "repeatable", 1, random)).toBe(500)
    expect(retryDelayMs(answer(500), error("internal_error"), "refusals-only", 0, random)).toBeNull()
    expect(retryDelayMs({ kind: "network", error: null, timedOut: true, aborted: false }, error("network_error"), "repeatable", 0, random)).toBe(250)
    expect(retryDelayMs({ kind: "network", error: null, timedOut: false, aborted: true }, error("network_error"), "repeatable", 0, random)).toBeNull()
  })
})

describe("errors without an API answer", () => {
  it("a timeout is a network_error", async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    )
    const result = await clientWith(fetch, { timeoutMs: 5, maxRetries: 0 }).usage.get()
    expect(result.error).toMatchObject({ code: "network_error", statusCode: null, docs: "https://charchy.krd/docs/sdks/node#errors" })
    expect(result.error?.message).toMatch(/timed out/)
    expect(result.headers).toBeNull()
  })

  it("an aborted signal stops at once, without retrying", async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError")
      return new Response("{}")
    })
    const result = await clientWith(fetch).usage.get({ signal: controller.signal })
    expect(result.error?.message).toMatch(/aborted/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("a non-JSON answer is invalid_response; a non-JSON 502 is retried as internal_error", async () => {
    const html = fakeFetch({ status: 200, text: "<html>proxy</html>" })
    expect((await clientWith(html.fetch).usage.get()).error).toMatchObject({ code: "invalid_response", statusCode: 200, requestId: "req_1" })

    vi.spyOn(Math, "random").mockReturnValue(0)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const gateway = fakeFetch({ status: 502, text: "Bad gateway" }, { json: { plan: null } })
    const pending = clientWith(gateway.fetch).usage.get()
    await vi.runAllTimersAsync()
    expect((await pending).data).toEqual({ plan: null })
  })
})

describe("durations", () => {
  it("parses s, m, h and d, and nothing else", () => {
    expect(parseDuration("30s")).toBe(30_000)
    expect(parseDuration("10m")).toBe(600_000)
    expect(parseDuration(" 2H ")).toBe(7_200_000)
    expect(parseDuration("1d")).toBe(86_400_000)
    expect(parseDuration("1.5h")).toBeNull()
    expect(parseDuration("in 10 minutes")).toBeNull()
    expect(parseDuration("2026-11-20T09:00:00Z")).toBeNull()
  })
})

describe("usage.get", () => {
  it("camelCases the whole answer", async () => {
    const { fetch } = fakeFetch({
      json: {
        plan: { key: "growth", emails_included: 50000, emails_used: 12840, emails_left: 37160, term_ends_at: "2026-12-14T09:00:00Z" },
        credits: null,
        daily: { cap: 5000, surge_cap: 10000, used: 612, resets_at: "2026-11-17T00:00:00Z" },
        rate_limit: { requests_per_second: 10, burst: 20 },
        test: { daily_cap: 1000, used: 37 },
      },
    })
    const { data } = await clientWith(fetch).usage.get()
    expect(data).toEqual({
      plan: { key: "growth", emailsIncluded: 50000, emailsUsed: 12840, emailsLeft: 37160, termEndsAt: "2026-12-14T09:00:00Z" },
      credits: null,
      daily: { cap: 5000, surgeCap: 10000, used: 612, resetsAt: "2026-11-17T00:00:00Z" },
      rateLimit: { requestsPerSecond: 10, burst: 20 },
      test: { dailyCap: 1000, used: 37 },
    })
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"
import { CharchySend, testAddress, webhookHandler, type EmailBouncedEvent } from "../src/index.js"
import addressVectors from "./fixtures/address-vectors.json" with { type: "json" }
import { apiError, clientWith, fakeFetch, newWebhookSecret, signedHeaders, TEST_KEY } from "./helpers.js"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const base = { subject: "s", text: "t" }

describe("send.test.address", () => {
  it("builds magic addresses, with an optional label", () => {
    const send = new CharchySend(TEST_KEY)
    expect(send.test.address("delivered")).toBe("delivered@sim.charchy.krd")
    expect(send.test.address("bounced", "signup-42")).toBe("bounced+signup-42@sim.charchy.krd")
    expect(testAddress("delayed", "ci_1")).toBe("delayed+ci_1@sim.charchy.krd")
  })

  it("throws on an unknown outcome or a label that isn't letters, digits, _ or -", () => {
    expect(() => testAddress("lost" as never)).toThrow(/outcome/)
    for (const label of ["", "a b", "a@b", "a+b", "x".repeat(41), "a\nb"]) expect(() => testAddress("delivered", label)).toThrow(/label/)
  })
})

describe("send.mode", () => {
  it("is test or live from the key", () => {
    expect(new CharchySend(TEST_KEY).mode).toBe("test")
    expect(new CharchySend(`chy_live_${"b".repeat(64)}`).mode).toBe("live")
  })
})

describe("result.meta", () => {
  it("parses the request id, rate limit and emails remaining; raw headers stay", async () => {
    const { fetch } = fakeFetch({
      json: { id: "em_1", status: "queued" },
      headers: { "ratelimit-limit": "20", "ratelimit-remaining": "17", "ratelimit-reset": "1", "x-charchy-emails-remaining": "48210" },
    })
    const result = await clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", ...base })
    expect(result.meta).toEqual({ requestId: "req_1", rateLimit: { limit: 20, remaining: 17, resetSeconds: 1 }, emailsRemaining: 48210 })
    expect(result.headers?.["ratelimit-remaining"]).toBe("17")
  })

  it("is there on API errors too, and null when nothing was sent", async () => {
    const { fetch } = fakeFetch(apiError(402, "insufficient_balance", "Used up.", {}, { "x-charchy-emails-remaining": "0" }))
    const send = clientWith(fetch)
    expect((await send.emails.send({ from: "a@x.example", to: "b@x.example", ...base })).meta).toMatchObject({ requestId: "req_1", emailsRemaining: 0, rateLimit: null })
    expect((await send.emails.get("..")).meta).toBeNull()
  })
})

describe("address objects", () => {
  it("formats { name, email }, quoting names with specials and keeping Kurdish and Arabic names as they are", async () => {
    const { fetch, calls } = fakeFetch({ json: { id: "em_1", status: "queued" } })
    await clientWith(fetch).emails.send({
      from: { name: "Darin Game", email: "orders@daringaming.com" },
      to: [{ name: "Ara, Karim", email: "ara@example.com" }, "plain@example.com", { email: "noname@example.com" }],
      cc: { name: 'Shno "the boss" \\ Ali', email: "shno@example.com" },
      bcc: [{ name: "دارین گەیم", email: "audit@example.com" }],
      replyTo: { name: "Support (24/7)", email: "support@daringaming.com" },
      ...base,
    })
    expect(calls[0]!.body).toMatchObject({
      from: "Darin Game <orders@daringaming.com>",
      to: ['"Ara, Karim" <ara@example.com>', "plain@example.com", "noname@example.com"],
      cc: ['"Shno \\"the boss\\" \\\\ Ali" <shno@example.com>'],
      bcc: ["دارین گەیم <audit@example.com>"],
      reply_to: ['"Support (24/7)" <support@daringaming.com>'],
    })
  })

  it("refuses line breaks, control characters and < > before sending", async () => {
    const { fetch } = fakeFetch()
    const send = clientWith(fetch)
    const cases: [Parameters<typeof send.emails.send>[0], string][] = [
      [{ from: "a@x.example", to: "b@x.example\r\nBcc: evil@x.example", ...base }, "to"],
      [{ from: { name: "A\nB", email: "a@x.example" }, to: "b@x.example", ...base }, "from.name"],
      [{ from: "a@x.example", to: [{ name: "x", email: "b@x.example" }, { name: "<script>", email: "c@x.example" }], ...base }, "to[1].name"],
      [{ from: "a@x.example", to: { email: "b@x.example\n" }, ...base }, "to.email"],
      [{ from: "a@x.example", to: { email: "not an address" }, ...base }, "to.email"],
    ]
    for (const [params, field] of cases) expect((await send.emails.send(params)).error).toMatchObject({ code: "validation_error", field })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("emails.waitFor", () => {
  const email = (status: string) => ({
    json: { id: "em_1", status, from: "a", to: ["b"], cc: [], bcc: [], reply_to: [], subject: "s", tags: {}, test: true, created_at: "t", scheduled_at: null, expires_at: null, events: [] },
  })

  it("reads until a wanted status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const { fetch } = fakeFetch(email("queued"), email("sent"), email("delivered"))
    const pending = clientWith(fetch).emails.waitFor("em_1", { until: ["delivered"], intervalMs: 500 })
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.data?.status).toBe("delivered")
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("times out with wait_timeout, and stops at once on a status the email can't leave", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const slow = fakeFetch(...Array.from({ length: 10 }, () => email("sent")))
    const pending = clientWith(slow.fetch).emails.waitFor("em_1", { until: ["delivered"], timeoutMs: 2_000, intervalMs: 1_000 })
    await vi.runAllTimersAsync()
    expect((await pending).error).toMatchObject({ code: "wait_timeout", statusCode: null, docs: "https://charchy.krd/docs/sdks/node#errors" })

    const canceled = fakeFetch(email("canceled"))
    expect((await clientWith(canceled.fetch).emails.waitFor("em_1", { until: ["delivered"] })).error?.code).toBe("wait_unexpected_status")
    expect(canceled.fetch).toHaveBeenCalledTimes(1)
  })

  it("returns a read error as it is, and refuses a silly timeout", async () => {
    const { fetch } = fakeFetch(apiError(404, "not_found"))
    expect((await clientWith(fetch).emails.waitFor("em_1")).error?.code).toBe("not_found")
    expect((await clientWith(fetch).emails.waitFor("em_1", { timeoutMs: Number.POSITIVE_INFINITY })).error?.field).toBe("timeoutMs")
  })
})

describe("webhooks.handler", () => {
  const NOW = 1_800_000_000
  const bounced = JSON.stringify({
    id: "evt_1",
    type: "email.bounced",
    created_at: "2026-11-16T09:00:02.400Z",
    data: { email_id: "em_1", from: "a", to: ["b"], subject: "s", created_at: "t", tags: {}, test: true, recipient: "b@x.example", bounce: { type: "permanent" } },
  })

  async function request(body: string, secret: string, options: { method?: string; tamper?: boolean } = {}) {
    const headers = signedHeaders([secret], { id: "evt_1", timestamp: NOW, body })
    return new Request("https://app.example/api/webhooks/charchy", {
      method: options.method ?? "POST",
      headers: { "content-type": "application/json", ...headers },
      body: options.method === "GET" ? undefined : options.tamper ? body.replace("permanent", "transient") : body,
    })
  }

  it("verifies, runs the typed handler and answers 204; other types get 204 without a handler", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW * 1000)
    const secret = newWebhookSecret()
    const seen: EmailBouncedEvent[] = []
    const handle = new CharchySend(TEST_KEY).webhooks.handler({ "email.bounced": (event) => void seen.push(event) }, { secret })
    expect((await handle(await request(bounced, secret))).status).toBe(204)
    expect(seen[0]?.data.bounce.type).toBe("permanent")
    expect(seen[0]?.data.recipient).toBe("b@x.example")

    const delivered = bounced.replace("email.bounced", "email.delivered")
    expect((await handle(await request(delivered, secret))).status).toBe(204)
    expect(seen).toHaveLength(1)
  })

  it("answers 400 without detail to a bad signature, 405 to a GET, and 500 when a handler throws or the secret is missing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW * 1000)
    const secret = newWebhookSecret()
    const errors: unknown[] = []
    const handle = webhookHandler(
      {
        "email.bounced": () => {
          throw new Error("database down")
        },
      },
      { secret, onError: (error) => void errors.push(error) }
    )

    const refused = await handle(await request(bounced, secret, { tamper: true }))
    expect(refused.status).toBe(400)
    expect(await refused.text()).toBe("Invalid webhook")
    expect((await handle(await request(bounced, secret, { method: "GET" }))).status).toBe(405)
    expect((await handle(await request(bounced, secret))).status).toBe(500)
    expect(errors.map((error) => (error as Error).message)).toEqual([expect.stringMatching(/No webhook-signature/), "database down"])

    vi.stubEnv("CHARCHY_WEBHOOK_SECRET", "")
    const unconfigured = webhookHandler({}, { onError: () => {} })
    expect((await unconfigured(await request(bounced, secret))).status).toBe(500)
  })

  it("reads CHARCHY_WEBHOOK_SECRET per request: a handler made before the secret is set works once it is", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW * 1000)
    vi.stubEnv("CHARCHY_WEBHOOK_SECRET", "")
    const handle = webhookHandler({}, { onError: () => {} }) // created at module load, no secret yet
    const secret = newWebhookSecret()
    expect((await handle(await request(bounced, secret))).status).toBe(500)
    vi.stubEnv("CHARCHY_WEBHOOK_SECRET", secret)
    expect((await handle(await request(bounced, secret))).status).toBe(204)
  })
})

describe("address objects as the API reads them", () => {
  it.each(addressVectors.vectors)("$name is written so the API reads back the same name", async (vector) => {
    const { formatAddress } = await import("../src/addresses.js")
    const written = formatAddress({ name: vector.name, email: vector.email }, "from")
    expect(written).toEqual({ ok: true, value: vector.written })
    // Recorded from the API's own parser: the name it reads is the name given (trimmed).
    expect(vector.apiReadsName).toBe(vector.name.trim())
    expect(vector.apiReadsEmail).toBe(vector.email)
  })
})

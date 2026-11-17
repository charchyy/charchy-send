import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CharchySend, verifyWebhook, WebhookVerificationError, type WebhookEvent } from "../src/index.js"
import vectors from "./fixtures/webhook-vectors.json" with { type: "json" }
import { newWebhookSecret, signedHeaders, TEST_KEY } from "./helpers.js"

const NOW_SECONDS = 1_800_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW_SECONDS * 1000)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const deliveredPayload = JSON.stringify({
  id: "evt_2b7k9x4m1q8w3n5p6r0s2t4v",
  type: "email.delivered",
  created_at: "2026-11-16T09:00:02.400Z",
  data: {
    email_id: "em_8f2k1x9q4w7m3n5p6r0s2t4v",
    from: "Darin Game <orders@daringaming.com>",
    to: ["customer@example.com"],
    subject: "داواکارییەکەت گەیشت",
    created_at: "2026-11-16T09:00:00.120Z",
    tags: { order_type: "first" },
    test: false,
    recipient: "customer@example.com",
  },
})

async function signed(payload: string, secrets: string[], timestamp = NOW_SECONDS) {
  return signedHeaders(secrets, { id: "evt_2b7k9x4m1q8w3n5p6r0s2t4v", timestamp, body: payload })
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(WebhookVerificationError)
  return (error as WebhookVerificationError).reason
}

describe("verifyWebhook", () => {
  it("accepts the Standard Webhooks spec's published example", async () => {
    vi.setSystemTime(1614265330 * 1000)
    const event = await verifyWebhook({
      payload: '{"test": 2432232314}',
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      headers: {
        "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
        "webhook-timestamp": "1614265330",
        "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      },
    })
    expect(event).toEqual({ test: 2432232314 })
  })

  it.each(vectors.vectors)("verifies a vector Charchy Send's own signer made: $name", async (vector) => {
    for (const secret of vector.secrets) {
      const event = await verifyWebhook({ payload: vector.body, headers: new Headers(vector.headers), secret })
      expect(event.id).toBe(JSON.parse(vector.body).id)
    }
    // The tests' own signer matches the real one, so the other tests here exercise the real format.
    expect(signedHeaders([...vector.secrets], { id: vector.headers["webhook-id"], timestamp: NOW_SECONDS, body: vector.body })).toEqual(vector.headers)
    await expect(verifyWebhook({ payload: vector.body.replace("2026", "2027"), headers: vector.headers, secret: vector.secrets[0]! })).rejects.toMatchObject({ reason: "invalid_signature" })
  })

  it("verifies a Kurdish body from a Headers object and camelCases the event", async () => {
    const secret = newWebhookSecret()
    const headers = new Headers(await signed(deliveredPayload, [secret]))
    const event: WebhookEvent = await verifyWebhook({ payload: deliveredPayload, headers, secret })
    expect(event.type).toBe("email.delivered")
    if (event.type !== "email.delivered") throw new Error("narrowing")
    expect(event.data).toMatchObject({ emailId: "em_8f2k1x9q4w7m3n5p6r0s2t4v", recipient: "customer@example.com", tags: { order_type: "first" } })
    expect(event.createdAt).toBe("2026-11-16T09:00:02.400Z")
  })

  it("takes Express's raw Buffer and plain header object, and either secret during a rotation", async () => {
    const [current, previous] = [newWebhookSecret(), newWebhookSecret()]
    const headers = await signed(deliveredPayload, [current, previous])
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2)
    const expressHeaders = { "Webhook-Id": headers["webhook-id"], "webhook-timestamp": headers["webhook-timestamp"], "webhook-signature": headers["webhook-signature"] }
    for (const secret of [current, previous]) {
      const event = await verifyWebhook({ payload: Buffer.from(deliveredPayload), headers: expressHeaders, secret })
      expect(event.id).toBe("evt_2b7k9x4m1q8w3n5p6r0s2t4v")
    }
    expect(await refusal(verifyWebhook({ payload: deliveredPayload, headers: expressHeaders, secret: newWebhookSecret() }))).toBe("invalid_signature")
  })

  it("refuses a changed byte, a stale or future timestamp, and missing headers", async () => {
    const secret = newWebhookSecret()
    const headers = await signed(deliveredPayload, [secret])
    expect(await refusal(verifyWebhook({ payload: deliveredPayload.replace("first", "fIrst"), headers, secret }))).toBe("invalid_signature")

    const stale = await signed(deliveredPayload, [secret], NOW_SECONDS - 5 * 60 - 1)
    expect(await refusal(verifyWebhook({ payload: deliveredPayload, headers: stale, secret }))).toBe("timestamp_out_of_range")
    const future = await signed(deliveredPayload, [secret], NOW_SECONDS + 5 * 60 + 1)
    expect(await refusal(verifyWebhook({ payload: deliveredPayload, headers: future, secret }))).toBe("timestamp_out_of_range")
    const edge = await signed(deliveredPayload, [secret], NOW_SECONDS - 5 * 60)
    await expect(verifyWebhook({ payload: deliveredPayload, headers: edge, secret })).resolves.toBeDefined()

    const { "webhook-signature": _dropped, ...unsigned } = headers
    expect(await refusal(verifyWebhook({ payload: deliveredPayload, headers: unsigned, secret }))).toBe("missing_headers")
    expect(await refusal(verifyWebhook({ payload: deliveredPayload, headers: { ...headers, "webhook-timestamp": "soon" }, secret }))).toBe("invalid_timestamp")
  })

  it("ignores other signature versions and malformed entries", async () => {
    const secret = newWebhookSecret()
    const headers = await signed(deliveredPayload, [secret])
    const good = headers["webhook-signature"].slice(3)
    const mixed = { ...headers, "webhook-signature": `v2,${good} v1,not*base64 v1,${good}` }
    await expect(verifyWebhook({ payload: deliveredPayload, headers: mixed, secret })).resolves.toBeDefined()
    expect(await refusal(verifyWebhook({ payload: deliveredPayload, headers: { ...headers, "webhook-signature": `v1a,${good}` }, secret }))).toBe("invalid_signature")
  })

  it("reads CHARCHY_WEBHOOK_SECRET, and reports a missing or malformed secret", async () => {
    const secret = newWebhookSecret()
    const headers = await signed(deliveredPayload, [secret])
    vi.stubEnv("CHARCHY_WEBHOOK_SECRET", secret)
    await expect(new CharchySend(TEST_KEY).webhooks.verify({ payload: deliveredPayload, headers })).resolves.toMatchObject({ type: "email.delivered" })

    vi.stubEnv("CHARCHY_WEBHOOK_SECRET", "")
    expect(await refusal(verifyWebhook({ payload: deliveredPayload, headers }))).toBe("missing_secret")
    expect(await refusal(verifyWebhook({ payload: deliveredPayload, headers, secret: "whsec_***" }))).toBe("invalid_secret")
  })

  it("narrows data by type", async () => {
    const secret = newWebhookSecret()
    const payload = JSON.stringify({
      id: "evt_x",
      type: "email.bounced",
      created_at: "2026-11-16T09:00:02.400Z",
      data: {
        email_id: "em_1",
        from: "a",
        to: ["b"],
        subject: "s",
        created_at: "t",
        tags: {},
        test: true,
        recipient: "b",
        bounce: { type: "permanent", sub_type: "no_email", diagnostic_code: "smtp; 550" },
      },
    })
    const event = await verifyWebhook({ payload, headers: signedHeaders([secret], { id: "evt_x", timestamp: NOW_SECONDS, body: payload }), secret })
    if (event.type === "email.bounced") {
      expect(event.data.bounce.subType).toBe("no_email")
      expect(event.data.bounce.diagnosticCode).toBe("smtp; 550")
    } else {
      throw new Error(`expected email.bounced, got ${event.type}`)
    }
  })
})

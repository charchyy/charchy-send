import { createElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { unwrap, type EmailSummary } from "../src/index.js"
import { apiError, clientWith, fakeFetch } from "./helpers.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.useRealTimers()
})

describe("emails.send", () => {
  it("sends snake_case JSON, keeps tags and headers keys as given, and returns camelCase", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-17T10:00:00Z"))
    const { fetch, calls } = fakeFetch({ json: { id: "em_1", status: "queued" }, headers: { "x-charchy-emails-remaining": "99" } })
    const result = await clientWith(fetch).emails.send({
      from: "Darin Game <orders@daringaming.com>",
      to: "customer@example.com",
      cc: ["a@example.com", "b@example.com"],
      replyTo: "support@daringaming.com",
      subject: "Your order #4821",
      html: "<p>Thanks</p>",
      tags: { order_type: "first-order" },
      headers: { "List-Unsubscribe": "<https://x.example/u>", "X-Entity_Ref": "4821" },
      scheduledAt: new Date("2026-11-20T06:00:00Z"),
      expiresAt: "2026-11-20T12:00:00+03:00",
    })

    expect(result).toEqual({
      data: { id: "em_1", status: "queued" },
      error: null,
      headers: expect.objectContaining({ "x-charchy-emails-remaining": "99" }),
      meta: { requestId: "req_1", rateLimit: null, emailsRemaining: 99 },
    })
    const [call] = calls
    expect(call!.url).toBe("https://api.charchy.krd/v1/emails")
    expect(call!.method).toBe("POST")
    expect(call!.headers.authorization).toMatch(/^Bearer chy_test_/)
    expect(call!.headers["content-type"]).toBe("application/json")
    expect(call!.headers["user-agent"]).toMatch(/^charchy-send-node\/\d+\.\d+\.\d+$/)
    expect(call!.body).toEqual({
      from: "Darin Game <orders@daringaming.com>",
      to: ["customer@example.com"],
      cc: ["a@example.com", "b@example.com"],
      reply_to: ["support@daringaming.com"],
      subject: "Your order #4821",
      html: "<p>Thanks</p>",
      tags: { order_type: "first-order" },
      headers: { "List-Unsubscribe": "<https://x.example/u>", "X-Entity_Ref": "4821" },
      scheduled_at: "2026-11-20T06:00:00.000Z",
      expires_at: "2026-11-20T12:00:00+03:00",
    })
  })

  it("turns a duration into an ISO time from now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-17T10:00:00Z"))
    const { fetch, calls } = fakeFetch({ json: { id: "em_1", status: "scheduled" } })
    await clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t", scheduledAt: "2h", expiresAt: "1d" })
    expect(calls[0]!.body).toMatchObject({ scheduled_at: "2026-11-17T12:00:00.000Z", expires_at: "2026-11-18T10:00:00.000Z" })
  })

  it("encodes attachment bytes as base64 and infers common content types", async () => {
    const { fetch, calls } = fakeFetch({ json: { id: "em_1", status: "queued" } })
    await clientWith(fetch).emails.send({
      from: "a@x.example",
      to: "b@x.example",
      subject: "Invoice",
      text: "Attached.",
      attachments: [
        { filename: "invoice.pdf", content: new TextEncoder().encode("%PDF-1.7") },
        { filename: "logo.PNG", content: Buffer.from([137, 80, 78, 71]), contentId: "logo" },
        { filename: "data.bin", content: "AAEC", contentType: "application/octet-stream" },
        { filename: "notes.txt", content: new Blob(["hi"]) },
      ],
    })
    expect((calls[0]!.body as { attachments: unknown }).attachments).toEqual([
      { filename: "invoice.pdf", content: "JVBERi0xLjc=", content_type: "application/pdf" },
      { filename: "logo.PNG", content: "iVBORw==", content_type: "image/png", content_id: "logo" },
      { filename: "data.bin", content: "AAEC", content_type: "application/octet-stream" },
      { filename: "notes.txt", content: "aGk=", content_type: "text/plain" },
    ])
  })

  it("refuses an attachment with an unknown type locally, without a request", async () => {
    const { fetch } = fakeFetch()
    const result = await clientWith(fetch).emails.send({
      from: "a@x.example",
      to: "b@x.example",
      subject: "s",
      text: "t",
      attachments: [{ filename: "blob.xyz", content: "AAEC" }],
    })
    expect(result.error).toMatchObject({ code: "validation_error", field: "attachments[0].contentType", statusCode: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("renders `react` with @react-email/render, and refuses react together with html", async () => {
    const { fetch, calls } = fakeFetch({ json: { id: "em_1", status: "queued" } })
    const send = clientWith(fetch)
    await send.emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", react: createElement("p", null, "Hello from React") })
    expect((calls[0]!.body as { html: string }).html).toContain("<p>Hello from React</p>")

    const both = await send.emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", html: "<p/>", react: createElement("p") })
    expect(both.error).toMatchObject({ code: "validation_error", field: "react" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("makes one Idempotency-Key when none is given, and keeps it across retries", async () => {
    const { fetch, calls } = fakeFetch(new TypeError("fetch failed"), apiError(500, "internal_error"), { json: { id: "em_1", status: "queued" } })
    vi.spyOn(Math, "random").mockReturnValue(0)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const pending = clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" })
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result.data).toEqual({ id: "em_1", status: "queued" })
    expect(calls).toHaveLength(3)
    const key = calls[0]!.headers["idempotency-key"]
    expect(key).toMatch(UUID)
    expect(calls.map((call) => call.headers["idempotency-key"])).toEqual([key, key, key])
  })

  it("sends your Idempotency-Key as given, and none of its own with retries off", async () => {
    const { fetch, calls } = fakeFetch({ json: { id: "em_1", status: "queued" } }, { json: { id: "em_2", status: "queued" } })
    await clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" }, { idempotencyKey: "order-confirmation/4821" })
    await clientWith(fetch, { maxRetries: 0 }).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" })
    expect(calls[0]!.headers["idempotency-key"]).toBe("order-confirmation/4821")
    expect(calls[1]!.headers["idempotency-key"]).toBeUndefined()
  })

  it("never retries 402 insufficient_balance or a validation error", async () => {
    for (const reply of [apiError(402, "insufficient_balance"), apiError(400, "validation_error", "Bad to.", { field: "to" }), apiError(409, "idempotency_conflict")]) {
      const { fetch } = fakeFetch(reply)
      const result = await clientWith(fetch).emails.send({ from: "a@x.example", to: "b@x.example", subject: "s", text: "t" })
      expect(result.error).not.toBeNull()
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })

  it("maps an API error to CharchySendError with status, request id and docs; unwrap throws it", async () => {
    const { fetch } = fakeFetch(apiError(403, "domain_not_verified", "daringaming.com is not verified.", { field: "from" }))
    const result = await clientWith(fetch).emails.send({ from: "a@daringaming.com", to: "b@x.example", subject: "s", text: "t" })
    expect(result.data).toBeNull()
    expect(result.headers?.["x-request-id"]).toBe("req_1")
    expect(result.error?.toJSON()).toEqual({
      name: "CharchySendError",
      code: "domain_not_verified",
      message: "daringaming.com is not verified.",
      field: "from",
      docs: "https://charchy.krd/docs/errors#domain_not_verified",
      statusCode: 403,
      requestId: "req_1",
    })
    expect(() => unwrap(result)).toThrow(result.error!)
  })
})

describe("emails.batch", () => {
  it("sends { emails } and returns ids in order", async () => {
    const { fetch, calls } = fakeFetch({ json: { emails: [{ id: "em_1", status: "queued" }, { id: "em_2", status: "scheduled" }] } })
    const result = await clientWith(fetch).emails.batch(
      [
        { from: "a@x.example", to: "one@x.example", subject: "1", text: "1" },
        { from: "a@x.example", to: ["two@x.example"], subject: "2", text: "2", scheduledAt: "2026-12-01T09:00:00Z" },
      ],
      { idempotencyKey: "digest/2026-11-17" }
    )
    expect(calls[0]!.url).toBe("https://api.charchy.krd/v1/emails/batch")
    expect(calls[0]!.headers["idempotency-key"]).toBe("digest/2026-11-17")
    expect(calls[0]!.body).toEqual({
      emails: [
        { from: "a@x.example", to: ["one@x.example"], subject: "1", text: "1" },
        { from: "a@x.example", to: ["two@x.example"], subject: "2", text: "2", scheduled_at: "2026-12-01T09:00:00Z" },
      ],
    })
    expect(result.data?.emails.map((email) => email.id)).toEqual(["em_1", "em_2"])
  })

  it("returns every invalid email by index on 422", async () => {
    const items = [{ index: 1, code: "validation_error", field: "to", message: '"x@" is not an email address.' }]
    const { fetch } = fakeFetch(apiError(422, "validation_error", "1 of the emails is invalid, so none were sent.", { items }))
    const result = await clientWith(fetch).emails.batch([
      { from: "a@x.example", to: "ok@x.example", subject: "s", text: "t" },
      { from: "a@x.example", to: "x@", subject: "s", text: "t" },
    ])
    expect(result.error?.items).toEqual(items)
  })

  it("names the batch position of a local problem", async () => {
    const { fetch } = fakeFetch()
    const result = await clientWith(fetch).emails.batch([
      { from: "a@x.example", to: "b@x.example", subject: "s", text: "t" },
      { from: "a@x.example", to: "b@x.example", subject: "s", text: "t", scheduledAt: new Date("nope") },
    ])
    expect(result.error).toMatchObject({ code: "validation_error", field: "emails[1].scheduledAt" })
  })
})

describe("reading, rescheduling and canceling", () => {
  const wireEmail = {
    id: "em_1",
    status: "bounced",
    from: "a@x.example",
    to: ["b@x.example"],
    cc: [],
    bcc: [],
    reply_to: ["r@x.example"],
    subject: "s",
    tags: { order_id: "4821" },
    test: true,
    created_at: "2026-11-17T10:00:00.000Z",
    scheduled_at: null,
    expires_at: null,
    events: [
      { type: "sent", at: "2026-11-17T10:00:01.000Z", simulated: true },
      {
        type: "bounced",
        at: "2026-11-17T10:00:02.000Z",
        recipient: "b@x.example",
        bounce: { type: "permanent", sub_type: "no_email", diagnostic_code: "smtp; 550 5.1.1 user unknown" },
        simulated: true,
      },
    ],
  }

  it("get camelCases nested fields but not tag keys", async () => {
    const { fetch, calls } = fakeFetch({ json: wireEmail })
    const { data } = await clientWith(fetch).emails.get("em_1")
    expect(calls[0]!.url).toBe("https://api.charchy.krd/v1/emails/em_1")
    expect(data).toMatchObject({ replyTo: ["r@x.example"], createdAt: "2026-11-17T10:00:00.000Z", scheduledAt: null, tags: { order_id: "4821" } })
    expect(data?.events[1]?.bounce).toEqual({ type: "permanent", subType: "no_email", diagnosticCode: "smtp; 550 5.1.1 user unknown" })
  })

  it("list passes the filters as query parameters", async () => {
    const { fetch, calls } = fakeFetch({ json: { data: [], has_more: false } })
    const { data } = await clientWith(fetch).emails.list({ limit: 50, status: "bounced", tag: "type:order", to: "b@x.example" })
    expect(calls[0]!.url).toBe("https://api.charchy.krd/v1/emails?limit=50&status=bounced&tag=type%3Aorder&to=b%40x.example")
    expect(data).toEqual({ data: [], hasMore: false })
  })

  it("listAll follows next_cursor until has_more is false", async () => {
    const summary = (id: string) => ({ id, status: "delivered", from: "a", to: ["b"], subject: "s", tags: {}, test: false, created_at: "t", scheduled_at: null })
    const { fetch, calls } = fakeFetch(
      { json: { data: [summary("em_1"), summary("em_2")], has_more: true, next_cursor: "c1" } },
      { json: { data: [summary("em_3")], has_more: false } }
    )
    const seen: EmailSummary[] = []
    for await (const email of clientWith(fetch).emails.listAll({ status: "delivered" })) seen.push(email)
    expect(seen.map((email) => email.id)).toEqual(["em_1", "em_2", "em_3"])
    expect(calls.map((call) => new URL(call.url).search)).toEqual(["?limit=100&status=delivered", "?limit=100&after=c1&status=delivered"])
  })

  it("listAll throws the page's error", async () => {
    const { fetch } = fakeFetch(apiError(403, "restricted_api_key"))
    const iterate = async () => {
      for await (const _ of clientWith(fetch).emails.listAll()) void _
    }
    await expect(iterate()).rejects.toMatchObject({ name: "CharchySendError", code: "restricted_api_key" })
  })

  it("update sends scheduled_at and cancel posts to /cancel", async () => {
    const { fetch, calls } = fakeFetch(
      { json: { id: "em_1", status: "scheduled", scheduled_at: "2026-11-20T05:00:00.000Z" } },
      { json: { id: "em_1", status: "canceled" } }
    )
    const send = clientWith(fetch)
    const updated = await send.emails.update("em_1", { scheduledAt: "2026-11-20T08:00:00+03:00" })
    const canceled = await send.emails.cancel("em_1")
    expect(calls[0]).toMatchObject({ method: "PATCH", url: "https://api.charchy.krd/v1/emails/em_1", body: { scheduled_at: "2026-11-20T08:00:00+03:00" } })
    expect(calls[1]).toMatchObject({ method: "POST", url: "https://api.charchy.krd/v1/emails/em_1/cancel" })
    expect(updated.data).toEqual({ id: "em_1", status: "scheduled", scheduledAt: "2026-11-20T05:00:00.000Z" })
    expect(canceled.data).toEqual({ id: "em_1", status: "canceled" })
  })
})

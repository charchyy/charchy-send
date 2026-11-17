// Live smoke test of the BUILT package against a real deployment — not in CI.
//
//   pnpm build
//   CHARCHY_SEND_BASE_URL=https://api.charchy.krd CHARCHY_SEND_KEY=chy_test_… pnpm smoke
//
// Both variables are required: the script never guesses where to send.
// Test keys only (it refuses a live key): magic addresses at @sim.charchy.krd,
// nothing reaches an inbox, nothing is charged. The key is never printed.

import { createHmac, randomBytes } from "node:crypto"
import { inspect } from "node:util"

const baseUrl = process.env.CHARCHY_SEND_BASE_URL ?? ""
const key = process.env.CHARCHY_SEND_KEY ?? ""
if (!baseUrl) {
  console.error("Set CHARCHY_SEND_BASE_URL (e.g. https://api.charchy.krd).")
  process.exit(1)
}
if (!key.startsWith("chy_test_")) {
  console.error("Set CHARCHY_SEND_KEY to a TEST key (chy_test_…). The smoke test never uses a live key.")
  process.exit(1)
}

// Imported only now: the checks above answer even before a build.
const { CharchySend, unwrap } = await import("../dist/index.mjs")

const send = new CharchySend(key, { baseUrl, userAgent: "sdk-smoke" })
const run = `smoke-${Date.now()}`
const from = { name: "SDK smoke, Charchy", email: "smoke@example.com" } // a comma in the name: written quoted
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

try {
  console.log(`Charchy Send smoke test against ${baseUrl} (key ${key.slice(0, 9)}…${key.slice(-4)})\n`)
  check("mode and inspect: test, key masked", send.mode === "test" && !inspect(send).includes(key) && !JSON.stringify(send).includes(key), inspect(send))

  const delivered = await send.emails.send(
    { from, to: send.test.address("delivered", "sdk"), subject: "SDK smoke: delivered", html: "<p>It works.</p>", tags: { run, kind: "delivered" } },
    { idempotencyKey: `${run}/delivered` }
  )
  check("send to delivered@sim", !delivered.error && delivered.data.id.startsWith("em_"), delivered.error?.message ?? `${delivered.data.id} ${delivered.data.status}`)
  check(
    "meta: request id and rate limit parsed",
    Boolean(delivered.meta?.requestId?.startsWith("req_")) && typeof delivered.meta?.rateLimit?.remaining === "number",
    JSON.stringify(delivered.meta)
  )

  const replay = await send.emails.send(
    { from, to: send.test.address("delivered", "sdk"), subject: "SDK smoke: delivered", html: "<p>It works.</p>", tags: { run, kind: "delivered" } },
    { idempotencyKey: `${run}/delivered` }
  )
  check("same Idempotency-Key returns the same id", replay.data?.id === delivered.data?.id, replay.data?.id ?? replay.error?.code)

  const conflict = await send.emails.send({ from, to: send.test.address("delivered", "sdk"), subject: "different", text: "x" }, { idempotencyKey: `${run}/delivered` })
  check("same key, different body → idempotency_conflict", conflict.error?.code === "idempotency_conflict", conflict.error?.code ?? "accepted")

  const bounced = await send.emails.send({ from, to: send.test.address("bounced", "sdk"), subject: "SDK smoke: bounced", text: "Bounce me.", tags: { run, kind: "bounced" } })
  check("send to bounced@sim (auto idempotency key)", !bounced.error, bounced.error?.message ?? bounced.data.id)

  const batch = await send.emails.batch([
    { from, to: "delivered+batch1@sim.charchy.krd", subject: "SDK smoke: batch 1", text: "1", tags: { run, kind: "batch" } },
    { from, to: ["delivered+batch2@sim.charchy.krd"], subject: "SDK smoke: batch 2", text: "2", tags: { run, kind: "batch" } },
  ])
  check("batch of 2", batch.data?.emails.length === 2, batch.error?.message ?? batch.data.emails.map((email) => email.id).join(", "))

  const invalid = await send.emails.send({ from, to: "not-an-address@", subject: "s", text: "t" })
  check("invalid address → validation_error with field", invalid.error?.code === "validation_error", `${invalid.error?.statusCode} ${invalid.error?.field}: ${invalid.error?.message}`)

  const scheduled = await send.emails.send({ from, to: "delivered+scheduled@sim.charchy.krd", subject: "SDK smoke: scheduled", text: "Later.", scheduledAt: "1d", tags: { run, kind: "scheduled" } })
  check("scheduledAt \"1d\" → scheduled", scheduled.data?.status === "scheduled", scheduled.error?.message ?? scheduled.data.status)
  if (scheduled.data) {
    const moved = await send.emails.update(scheduled.data.id, { scheduledAt: "2d" })
    check("update scheduledAt \"2d\"", moved.data?.status === "scheduled", moved.error?.message ?? moved.data.scheduledAt)
    const canceled = await send.emails.cancel(scheduled.data.id)
    check("cancel", canceled.data?.status === "canceled", canceled.error?.message ?? canceled.data.status)
  }

  if (delivered.data) {
    const { data: email, error } = await send.emails.waitFor(delivered.data.id, { until: ["delivered"], timeoutMs: 30_000 })
    check("waitFor: delivered@sim ends delivered", email?.status === "delivered", error?.message ?? `test=${email.test}, from ${email.from}, events ${email.events.map((event) => event.type).join(" → ")}`)
  }
  if (bounced.data) {
    const { data: email, error } = await send.emails.waitFor(bounced.data.id, { until: ["bounced"], timeoutMs: 30_000 })
    const bounce = email?.events.find((event) => event.type === "bounced")?.bounce
    check("waitFor: bounced@sim ends bounced, with camelCased bounce", email?.status === "bounced" && bounce !== undefined, error?.message ?? JSON.stringify(bounce))
    const unexpected = await send.emails.waitFor(bounced.data.id, { until: ["delivered"], timeoutMs: 2_000 })
    check("waitFor: a bounced email never becomes delivered → wait_timeout", unexpected.error?.code === "wait_timeout", unexpected.error?.message)
  }
  if (scheduled.data) {
    const stuck = await send.emails.waitFor(scheduled.data.id, { until: ["delivered"] })
    check("waitFor: a canceled email → wait_unexpected_status at once", stuck.error?.code === "wait_unexpected_status", stuck.error?.message)
  }

  const page = await send.emails.list({ tag: `run:${run}`, limit: 2 })
  check("list by tag (page of 2)", !page.error && page.data.data.length === 2, page.error?.message ?? `${page.data.data.length} on the page, hasMore=${page.data.hasMore}`)

  const all = []
  for await (const email of send.emails.listAll({ tag: `run:${run}`, limit: 2 })) all.push(email.id)
  check("listAll follows the cursor", all.length === 5 && new Set(all).size === 5, `${all.length} emails`)

  // A webhook endpoint from webhooks.handler, fed an event signed here the Standard Webhooks way.
  const secret = `whsec_${randomBytes(32).toString("base64")}`
  const seen = []
  const endpoint = send.webhooks.handler({ "email.delivered": (event) => void seen.push(event) }, { secret, onError: () => {} })
  const body = JSON.stringify({
    id: "evt_smoke",
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: { email_id: delivered.data?.id ?? "em_x", from: "a", to: ["b"], subject: "s", created_at: new Date().toISOString(), tags: { run }, test: true, recipient: "b" },
  })
  const signedRequest = (payload) => {
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`evt_smoke.${timestamp}.${body}`).digest("base64")
    return new Request("https://example.com/webhooks", {
      method: "POST",
      headers: { "webhook-id": "evt_smoke", "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}` },
      body: payload,
    })
  }
  const accepted = await endpoint(signedRequest(body))
  const refused = await endpoint(signedRequest(body.replace("email.delivered", "email.bounced")))
  check(
    "webhooks.handler: 204 and a typed event; 400 for a changed body",
    accepted.status === 204 && refused.status === 400 && seen[0]?.data.emailId === delivered.data?.id && seen[0]?.data.tags.run === run,
    `${accepted.status} / ${refused.status}, emailId ${seen[0]?.data.emailId}`
  )

  const usage = await send.usage.get()
  check("usage.get", !usage.error, usage.error?.message ?? `test ${usage.data.test.used}/${usage.data.test.dailyCap}, daily cap ${usage.data.daily.cap} (surge ${usage.data.daily.surgeCap}), plan ${usage.data.plan?.key ?? "none"}`)
} catch (error) {
  check("unexpected exception", false, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)

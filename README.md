# @charchy/send

The official TypeScript SDK for [Charchy Send](https://charchy.krd/docs) (Namabar) — transactional email from your own domain: sign-in codes, password resets, receipts, order and booking updates.

Zero dependencies. Node 18+, Bun, Deno, Vercel Edge and Cloudflare Workers. ESM and CommonJS, fully typed.

```bash
npm install @charchy/send
# or
pnpm add @charchy/send
yarn add @charchy/send
bun add @charchy/send
```

## Quickstart

Create a key under **API keys** in the Charchy dashboard and keep it in your server's environment. A test key (`chy_test_…`) goes through every check but never sends.

```bash
CHARCHY_SEND_KEY=chy_test_…
```

```ts
import { CharchySend } from "@charchy/send"

const send = new CharchySend() // reads CHARCHY_SEND_KEY when a request is made

const { data, error } = await send.emails.send(
  {
    from: { name: "My App", email: "no-reply@myapp.com" },
    to: send.test.address("delivered"), // "delivered@sim.charchy.krd"
    subject: "Hello from Charchy Send",
    html: "<p>It works.</p>",
  },
  { idempotencyKey: "welcome/user-123" }
)

if (error) throw error // a CharchySendError
console.log(data.id) // "em_…"
```

Creating the client never needs the key — it is read on each request — so `new CharchySend()` at the top of a module is safe in `next build` and in deploys that load code without your secrets. With no key, a call returns `missing_api_key` (nothing sent); a value that isn't shaped like a key, `invalid_api_key`.

Keys belong on your server. The SDK warns once if it runs in a browser, and the API sends no CORS headers anyway. The key lives in a private field: `console.log(send)` shows `{ mode: 'test', key: 'chy_test_…1a2b', baseUrl: … }`, never the key.

## Results and errors

Every API method resolves to `{ data, error, headers, meta }` and never throws:

```ts
const { data, error, meta } = await send.emails.get("em_8f2k1x9q4w7m3n5p6r0s2t4v")
if (error) {
  console.error(error.code, error.message, error.docs, error.requestId)
} else {
  console.log(data.status, meta.rateLimit?.remaining, meta.emailsRemaining)
}
```

`meta` is the response headers that matter, parsed: `requestId` (`x-request-id`), `rateLimit` (`{ limit, remaining, resetSeconds }` from `ratelimit-*`) and `emailsRemaining` (`x-charchy-emails-remaining`). `headers` keeps every header, lower-cased. Both are `null` when no answer came back.

Prefer exceptions? `unwrap` returns `data` or throws the error:

```ts
import { unwrap } from "@charchy/send"

const { id } = await send.emails.send({ from, to, subject: "Receipt", text: "Thanks!" }).then(unwrap)
```

`CharchySendError` (`instanceof Error`):

| Field | |
|---|---|
| `code` | One of the [API's error codes](https://charchy.krd/docs/errors) (`domain_not_verified`, `insufficient_balance`, …) or an SDK code: `network_error` (no answer, or a timeout), `invalid_response` (an answer that isn't the API's JSON: a proxy page, a redirect, an empty body), `react_render_error`, `wait_timeout`, `wait_unexpected_status` |
| `message` | For people; may change. Match on `code`. |
| `field` | The request field at fault (`to[0]`, `attachments[1].contentType`, `idempotencyKey`) |
| `docs` | The code's section of charchy.krd/docs/errors |
| `statusCode` | The HTTP status; `null` when no answer came back or a local check failed |
| `requestId` | `x-request-id` — quote it to support |
| `retryAfterSeconds` | `Retry-After`, when the API sent one |
| `items` | A refused batch: every invalid email as `{ index, code, field, message }` |

Your input is checked before anything is sent — addresses with line breaks, an `expiresAt` already past or before `scheduledAt`, a malformed idempotency key, an id that isn't `em_…` — and refused as `validation_error` with `field` and `statusCode: null`. A missing or malformed key is refused the same way, as `missing_api_key` or `invalid_api_key`.

## Retries and idempotency

The SDK retries up to `maxRetries` times (default 2) with jittered backoff:

| Answer | Retried? |
|---|---|
| `429 rate_limit_exceeded`, `429 daily_limit_reached`, `409 idempotency_in_flight` | Yes, after `Retry-After` — unless it is over 60 s (a daily cap that resets in hours comes back at once, with `retryAfterSeconds`) |
| Network error, timeout, `5xx` | Yes — sends, reads, reschedule and cancel. Not image uploads |
| `402 insufficient_balance`, `409 idempotency_conflict`, every other `4xx`, a redirect | Never |

**A retry never sends twice.** `emails.send` and `emails.batch` without an `idempotencyKey` get a random one (`crypto.randomUUID()`) on the first attempt, reused by every retry of that call. That protects the SDK's own retries only: a second call is a new email. Give your own key, built from the event behind the email, and your retries (a re-run job, a redelivered queue message) are safe too:

```ts
await send.emails.send({ from, to, subject: "Order confirmed", html }, { idempotencyKey: `order-confirmation/${order.id}` })
```

Keys are 1–256 printable ASCII characters, kept 24 hours. The same key with a different body is `409 idempotency_conflict`. See [Idempotency](https://charchy.krd/docs/idempotency). `maxRetries: 0` turns retries (and the automatic key) off.

## Emails

### `emails.send(params, options?)`

```ts
const tenMinutes = new Date(Date.now() + 10 * 60_000)

await send.emails.send(
  {
    from: { name: "Darin Game", email: "orders@daringaming.com" }, // on a verified domain (any domain with a test key)
    to: ["customer@example.com", { name: "Ara, Karim", email: "ara@example.com" }], // to + cc + bcc ≤ 50
    cc: "accounts@example.com",
    replyTo: "Support <support@daringaming.com>",
    subject: "Your sign-in code: 482910",
    html: "<p>Your code is <b>482910</b>.</p>", // html, text or both (text is made from html when missing)
    text: "Your code is 482910.",
    tags: { type: "signin_code" }, // or [{ name, value }]; keys are never case-converted
    headers: { "X-Entity-Ref-ID": "signin/7f1c2a" },
    expiresAt: tenMinutes, // dropped (and refunded) if it can't leave in time
  },
  { idempotencyKey: "signin-code/7f1c2a", signal: AbortSignal.timeout(15_000) }
)
```

- **Addresses** are a string (`"a@b.com"`, `"Name <a@b.com>"`), `{ name, email }`, or an array of them. The SDK writes `{ name, email }` safely: a name with a comma or quote is quoted and escaped, so it can never split into two recipients; Kurdish and Arabic names are kept as they are. Line breaks and control characters are refused.
- **Times:** `scheduledAt` and `expiresAt` take a `Date`, an ISO 8601 string (sent as it is), or a duration from now — `"30s"`, `"10m"`, `"2h"`, `"1d"` — turned into an ISO time with your server's clock. The API itself takes ISO 8601 only. `expiresAt` must be in the future and after `scheduledAt`.

```ts
await send.emails.send({ from, to, subject: "Your appointment is tomorrow", text: "See you at 10:00.", scheduledAt: "1d", expiresAt: "26h" })
```

### Attachments

```ts
import { readFile } from "node:fs/promises"

await send.emails.send({
  from,
  to,
  subject: "Invoice #4821",
  text: "Attached.",
  attachments: [
    { filename: "invoice-4821.pdf", content: await readFile("invoice-4821.pdf") }, // Buffer / Uint8Array / ArrayBuffer / Blob
    { filename: "logo.png", content: logoBase64, contentId: "logo" }, // a string is taken as base64; <img src="cid:logo">
  ],
})
```

`contentType` is inferred for pdf, png, jpg, gif, webp, txt, csv, ics, html, json and zip; set it for anything else. Up to 3 files, 3 MB together. For logos, prefer a [hosted image](#images).

### React Email

```bash
npm install @react-email/render   # optional peer dependency, only for `react`
```

```tsx
import { WelcomeEmail } from "./emails/welcome"

await send.emails.send({ from, to, subject: "Welcome", react: <WelcomeEmail name="Ara" /> })
```

`react` is rendered to `html` with `@react-email/render`, loaded only when you use it. Without it installed you get `react_render_error`; you can always render yourself and pass `html`.

### `emails.batch(emails, options?)`

Up to 100 emails, no attachments, one request. All accepted or none:

```ts
const { data, error } = await send.emails.batch(
  users.map((user) => ({ from, to: user.email, subject: "Your weekly receipt", html: receiptHtml(user) })),
  { idempotencyKey: "weekly-receipts/2026-W47" }
)
if (error) console.error(error.items) // [{ index, code, field, message }] when any email is invalid
else console.log(data.emails) // [{ id, status }] in request order
```

### `emails.get(id)`

```ts
const email = await send.emails.get("em_8f2k1x9q4w7m3n5p6r0s2t4v").then(unwrap)
console.log(email.status) // "delivered", "bounced", …
console.log(email.events) // [{ type, at, recipient?, bounce?: { type, subType, message, diagnosticCode }, … }]
```

### `emails.waitFor(id, options?)` — for tests and CI

Reads the email until it reaches a status you name:

```ts
const sent = await send.emails.send({ from, to: send.test.address("bounced", "signup-42"), subject: "Test", text: "t" }).then(unwrap)
const { data: bounced, error: waitError } = await send.emails.waitFor(sent.id, { until: ["bounced"], timeoutMs: 30_000 })
if (waitError) throw waitError // wait_timeout, or wait_unexpected_status (canceled, expired, failed, unknown)
console.log(bounced.events.at(-1)?.bounce?.subType) // "no_email"
```

`until` defaults to any status an email ends in; `intervalMs` defaults to 1 s (at least 250 ms); `timeoutMs` to 60 s (at most 10 minutes).

### `emails.list(params?)` and `emails.listAll(params?)`

```ts
const page = await send.emails.list({ limit: 50, status: "bounced", tag: "type:order_confirmation", to: "customer@example.com" }).then(unwrap)
console.log(page.data, page.nextCursor) // a page, newest first (30 days); pass nextCursor as `after`

for await (const bouncedEmail of send.emails.listAll({ status: "bounced" })) {
  console.log(bouncedEmail.id) // every page, followed for you; a failed page throws its CharchySendError
}
```

### `emails.update(id, { scheduledAt })` and `emails.cancel(id)`

```ts
await send.emails.update("em_8f2k1x9q4w7m3n5p6r0s2t4v", { scheduledAt: "2026-11-20T08:00:00+03:00" }) // while still scheduled
await send.emails.cancel("em_8f2k1x9q4w7m3n5p6r0s2t4v") // while scheduled or queued; refunded; canceling twice answers the same
```

Reading, rescheduling and canceling need a key with **full** permission.

## Images

Host a logo once and use its permanent URL in every email (PNG, JPEG, GIF or WebP, up to 2 MB):

```ts
const image = await send.images.upload(await readFile("logo.png"), { filename: "logo.png" }).then(unwrap)
console.log(image.url) // "https://files.charchy.krd/i/…/logo.png"
```

Takes a `Blob`/`File`, `Uint8Array`/`Buffer` or `ArrayBuffer`.

## Usage

```ts
const usage = await send.usage.get().then(unwrap)
console.log(usage.plan?.emailsLeft, usage.credits?.emails)
console.log(usage.daily) // { cap, surgeCap, used, resetsAt }
console.log(usage.test) // { dailyCap, used }
```

## Webhooks

### A ready endpoint: `webhooks.handler`

One line gives you a standard `(request: Request) => Promise<Response>` — for the Next.js App Router, Cloudflare Workers, Bun, Deno and Hono. It verifies the signature on the raw body, then calls the handler for that event type, typed:

```ts
// app/api/webhooks/charchy/route.ts
import { webhookHandler } from "@charchy/send"

export const POST = webhookHandler({
  "email.bounced": async (event) => markBounced(event.data.recipient, event.data.bounce.type),
  "email.complained": async (event) => markComplained(event.data.recipient),
  "balance.low": async (event) => alertOps(`${event.data.usedPercent}% used, ${event.data.emailsLeft} left`),
})
```

It answers `204` once the handler finished (or when there is none for that type), `400` with no detail to a request that fails verification, `405` to anything but `POST`, and `500` when a handler throws or the secret is missing — so Charchy Send retries the event once you've fixed it. The secret defaults to `CHARCHY_WEBHOOK_SECRET`; pass `{ secret, onError }` to change it or to log refusals. Handlers run before the answer: keep them under a few seconds, or hand the work to a queue. Also on the client as `send.webhooks.handler`. On Hono, use [`charchyWebhook`](#hono) — it reads the secret from Workers bindings too.

### Verify it yourself: `verifyWebhook`

`verifyWebhook` checks the [Standard Webhooks](https://www.standardwebhooks.com) signature against the **raw** body, refuses timestamps more than 5 minutes off, tries every signature (two during a secret rotation) in constant time, and returns the typed event. It throws `WebhookVerificationError` (with a `reason`) when the request must be refused. Also `send.webhooks.verify`.

Express — the raw body, not `express.json()`:

```ts
import express from "express"
import { verifyWebhook, type WebhookEvent } from "@charchy/send"

const app = express()

app.post("/webhooks/charchy", express.raw({ type: "application/json" }), async (req, res) => {
  let event: WebhookEvent
  try {
    event = await verifyWebhook({ payload: req.body, headers: req.headers })
  } catch {
    return res.status(400).send("Invalid signature")
  }
  res.sendStatus(204)
  await queue.add("charchy-event", event)
})
```

`event` is a union discriminated by `type`, so `data` narrows:

```ts
import type { WebhookEvent } from "@charchy/send"

async function handleCharchyEvent(event: WebhookEvent) {
  switch (event.type) {
    case "email.bounced":
      return markBounced(event.data.recipient, event.data.bounce.type) // "permanent" | "transient" | "undetermined"
    case "account.paused":
      return alertOps(`Sending paused: ${event.data.code} — ${event.data.reason}`)
  }
}
```

Dedupe by `event.id` (the same on every retry) and order by `event.createdAt`. Events: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, `email.expired`, `email.canceled`, `domain.verified`, `domain.failed`, `account.paused`, `account.resumed`, `balance.low` — see [Events](https://charchy.krd/docs/events).

## Hono

`@charchy/send/hono` reads the key and the webhook secret where Hono keeps them: the Workers binding on `c.env` first, then `process.env` (Node, Bun, Deno, Vercel, Lambda), then `Deno.env`. `hono` 4 is an optional peer dependency; the root entry never imports it.

```ts
import { Hono } from "hono"
import { charchySend, charchyWebhook, type CharchySendVariables } from "@charchy/send/hono"

type AppEnv = {
  Bindings: { CHARCHY_SEND_KEY: string; CHARCHY_WEBHOOK_SECRET: string }
  Variables: CharchySendVariables
}

const app = new Hono<AppEnv>()

// Before any body-parsing middleware: the signature is over the raw bytes.
app.post(
  "/webhooks/charchy",
  charchyWebhook<AppEnv>({
    "email.bounced": async (event, c) => markBounced(event.data.recipient, event.data.bounce.type),
  })
)

app.use("/api/*", charchySend()) // sets c.var.charchySend
app.post("/api/orders/:id/confirm", async (c) => {
  const { error } = await c.var.charchySend.emails.send(
    { from, to, subject: "Order confirmed", html },
    { idempotencyKey: `order-confirmation/${c.req.param("id")}` }
  )
  return error ? c.json({ error: error.code }, 502) : c.body(null, 204)
})

export default app
```

`charchySend(options?)` takes the client's options plus `apiKey` (a string, or `(c) => string | Promise<string>` for another binding name or a Secrets Store) and `variable` (default `"charchySend"`; `CharchySendVariables<"mailer">` types a renamed one). The key is read per request and one client is kept per key. Without a key the client is still set, and its calls return `missing_api_key`.

`charchyWebhook(handlers, options?)` answers like `webhookHandler` (`204`, `400`, `405`, `500`); each handler also gets the context (`c.env`, `c.var`, `c.executionCtx.waitUntil`). `secret` and `onError(error, event, c)` are optional. A body that was already consumed is answered `500` with a `WebhookBodyUnavailableError` (logged by default): one read through `c.req.json()`/`text()`/`arrayBuffer()` is cached by Hono and still verifies (a `json()` read only from Hono 4.9); a read straight from `c.req.raw` cannot.

## Test mode

```ts
console.log(send.mode) // "test" for a chy_test_ key, "live" for chy_live_, null while there is no valid key

send.test.address("delivered") // "delivered@sim.charchy.krd"
send.test.address("bounced", "signup-42") // "bounced+signup-42@sim.charchy.krd"
```

With a test key nothing is sent or charged, and webhooks still fire. The magic addresses play out a known outcome with test **and** live keys, for free: `"delivered"`, `"bounced"`, `"complained"`, `"suppressed"`, `"delayed"`. The label (letters, digits, `_`, `-`) tells tests apart. With `emails.waitFor` that is an end-to-end test in three lines. See [Test mode](https://charchy.krd/docs/test-mode).

## Options

```ts
import { CharchySend } from "@charchy/send"

const client = new CharchySend(process.env.CHARCHY_SEND_KEY, {
  baseUrl: "https://api.charchy.krd", // the default; https only (http just for localhost)
  maxRetries: 2, // extra attempts, 0–10; 0 turns retries and the automatic key off
  timeoutMs: 30_000, // per attempt, at most 600 000
  fetch: customFetch, // e.g. a proxy-aware fetch, or a test double
  userAgent: "my-app/2.3", // appended to charchy-send-node/<version>
})
```

The key must be `chy_live_` or `chy_test_` and 64 hex characters, checked on each request: a missing key returns `missing_api_key` and anything else `invalid_api_key` (never echoing what you passed), with nothing sent. Options are code, so a bad option throws at once. Redirects are never followed. Every method also takes `{ signal }` (an `AbortSignal`) to cancel it and its retries.

## Runtimes

Uses only `fetch`, `FormData`, `Blob`, `TextEncoder` and Web Crypto. On Cloudflare Workers the key is a binding, not `process.env`: pass it (`new CharchySend(env.CHARCHY_SEND_KEY)`), or use [`@charchy/send/hono`](#hono). Node 18+ (on Node 18, Web Crypto comes from `node:crypto`), Bun, Deno (`npm:@charchy/send`), Vercel Edge and Node runtimes, Cloudflare Workers, AWS Lambda. `react` needs `@react-email/render`, which needs Node 20+.

## Types

Everything is exported: `SendEmailParams`, `BatchEmailParams`, `Address`, `Email`, `EmailSummary`, `EmailStatus`, `EmailEvent`, `Usage`, `Image`, `Result`, `ResponseMeta`, `CharchySendError`, `CharchySendErrorCode`, `ApiErrorCode`, `SimulatedOutcome`, `WebhookEvent`, `WebhookHandlers` and one type per event (`EmailBouncedEvent`, …). The answer types are checked against the API's OpenAPI file on every build, and every code block in this README is typechecked too.

## Help

Docs: [charchy.krd/docs](https://charchy.krd/docs) — also as Markdown for AI tools at [charchy.krd/llms-full.txt](https://charchy.krd/llms-full.txt). Bugs and feature requests: [GitHub issues](https://github.com/charchyy/charchy-send/issues). Questions about your account: [support@charchy.krd](mailto:support@charchy.krd) (quote `error.requestId`). Security reports: see [SECURITY.md](https://github.com/charchyy/charchy-send/blob/main/SECURITY.md).

## Development

```bash
pnpm install
pnpm run typecheck   # source, tests and every code block in this README
pnpm run test
pnpm run build
```

Types are generated from `openapi/openapi.yaml`, a copy of [charchy.krd/docs/openapi.yaml](https://charchy.krd/docs/openapi.yaml) kept in step by a daily workflow (`pnpm generate` by hand). Releases: [RELEASING.md](./RELEASING.md).

MIT License.

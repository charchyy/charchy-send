# Changelog

`@charchy/send` follows semantic versioning. Until 1.0 (after the private beta), a minor version may change the API; a patch never does.

## 0.2.0 — unreleased

`@charchy/send/hono`: Charchy Send for Hono apps, where a Cloudflare Workers secret is a binding on `c.env` and not in `process.env`. `hono` 4 is an optional peer dependency; the root entry is unchanged and still has no dependencies.

- `charchySend(options?)` middleware sets `c.var.charchySend`. The key is read per request: `apiKey` (a string, or a function of the context — another binding name, an async Secrets Store), else the `CHARCHY_SEND_KEY` binding, else `process.env`, else `Deno.env`. One client per key, not one per request. Takes the client's options, checked when the app is built, and `variable` to rename it. `CharchySendVariables` types it: `new Hono<{ Variables: CharchySendVariables }>()`.
- `charchyWebhook(handlers, options?)`: a Hono handler with `webhookHandler`'s answers (`204`, `400`, `405`, `500`). Handlers get the event and the context. The secret comes from `secret`, else the `CHARCHY_WEBHOOK_SECRET` binding, else `process.env`. The raw body is read through Hono's body cache, so a middleware that read it first with `c.req.text()`, `arrayBuffer()` or (Hono 4.9+) `json()` does not break verification. A body that cannot be recovered byte for byte is answered `500` with a `WebhookBodyUnavailableError`, logged by default.
- `webhookHandler` and `charchyWebhook` share one implementation; `webhookHandler`'s answers are unchanged.

## 0.1.1 — 2026-11-19

No code changes. The README lists pnpm, yarn and bun installs, and this is the first version published by CI with provenance (staged, then approved with 2FA).

## 0.1.0 — 2026-11-17

The first version, for the Charchy Send v1 API.

- `new CharchySend(apiKey?, { baseUrl, maxRetries, timeoutMs, fetch, userAgent })`. The key (the argument, else `CHARCHY_SEND_KEY`) is read on each request, never at construction, so a client at the top of a module is safe in `next build` and secret-less deploys; a missing or malformed key comes back as `missing_api_key` / `invalid_api_key` with nothing sent. `send.mode` is `"test"`, `"live"`, or `null` while there is no valid key. The webhook secret is likewise read per request.
- `emails.send`, `emails.batch`, `emails.get`, `emails.list`, `emails.listAll` (async iterator), `emails.update`, `emails.cancel`, `images.upload`, `usage.get` — each resolving to `{ data, error, headers, meta }`; `unwrap()` for exceptions. `meta` parses the request id, rate limit and emails remaining.
- `emails.waitFor(id, { until })` and `send.test.address(outcome, label)` for end-to-end tests against the magic addresses.
- `webhooks.handler({ "email.bounced": … })`: a complete `Request → Response` endpoint; `webhooks.verify` / `verifyWebhook` for your own routes. Standard Webhooks, Web Crypto, typed events.
- Retries with jittered backoff and `Retry-After`; an automatic Idempotency-Key on sends, so a retry never sends twice. Redirects are never followed.
- Addresses as strings or `{ name, email }`, written safely; `scheduledAt`/`expiresAt` as a `Date`, ISO string or `"10m"`-style duration; attachments from bytes; `react` with the optional `@react-email/render`. Input is checked before anything is sent.
- The key never appears in `console.log`, `util.inspect` or `JSON.stringify` of the client, its results or its errors.

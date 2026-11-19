# Changelog

`@charchy/send` follows semantic versioning. Until 1.0 (after the private beta), a minor version may change the API; a patch never does.

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

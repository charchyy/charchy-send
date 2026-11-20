import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CharchySend, type WebhookEvent } from "../src/index.js"
import { charchySend, charchyWebhook, WebhookBodyUnavailableError, type CharchySendVariables } from "../src/hono.js"
import { fakeFetch, newWebhookSecret, signedHeaders, TEST_KEY } from "./helpers.js"

const LIVE_KEY = `chy_live_${"b".repeat(64)}`
const OTHER_TEST_KEY = `chy_test_${"c".repeat(64)}`
const NOW_SECONDS = 1_800_000_000

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const accepted = { status: 200, json: { id: "em_8f2k1x9q4w7m3n5p6r0s2t4v", status: "queued" } }

/** An app whose route sends one email and reports what the client saw. */
function sendingApp(middleware: ReturnType<typeof charchySend>) {
  const app = new Hono<{ Variables: CharchySendVariables }>()
  app.use("*", middleware)
  app.post("/send", async (c) => {
    const { data, error } = await c.var.charchySend.emails.send({ from: "a@example.com", to: "b@example.com", subject: "s", text: "t" })
    return c.json({ mode: c.var.charchySend.mode, id: data?.id ?? null, error: error?.code ?? null })
  })
  return app
}

describe("charchySend middleware", () => {
  it("reads the key from Workers-style bindings on c.env, per request", async () => {
    vi.stubEnv("CHARCHY_SEND_KEY", "")
    const { fetch, calls } = fakeFetch(accepted, accepted)
    const app = sendingApp(charchySend({ fetch }))

    const first = await app.request("/send", { method: "POST" }, { CHARCHY_SEND_KEY: TEST_KEY })
    expect(await first.json()).toEqual({ mode: "test", id: "em_8f2k1x9q4w7m3n5p6r0s2t4v", error: null })
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`)

    const second = await app.request("/send", { method: "POST" }, { CHARCHY_SEND_KEY: LIVE_KEY })
    expect(await second.json()).toMatchObject({ mode: "live" })
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${LIVE_KEY}`)
  })

  it("prefers the binding to process.env, and falls back to process.env (Node, Bun)", async () => {
    vi.stubEnv("CHARCHY_SEND_KEY", LIVE_KEY)
    const { fetch, calls } = fakeFetch(accepted, accepted)
    const app = sendingApp(charchySend({ fetch }))

    await app.request("/send", { method: "POST" }, { CHARCHY_SEND_KEY: TEST_KEY })
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`)

    // @hono/node-server's c.env: { incoming, outgoing } — no key there.
    await app.request("/send", { method: "POST" }, { incoming: {}, outgoing: {} })
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${LIVE_KEY}`)
  })

  it("falls back to Deno.env when there is no process.env", async () => {
    vi.stubEnv("CHARCHY_SEND_KEY", "")
    vi.stubGlobal("Deno", { env: { get: (name: string) => (name === "CHARCHY_SEND_KEY" ? TEST_KEY : undefined) } })
    const { fetch, calls } = fakeFetch(accepted)
    await sendingApp(charchySend({ fetch })).request("/send", { method: "POST" })
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it("surfaces Deno's permission error instead of guessing (no --allow-env)", async () => {
    vi.stubEnv("CHARCHY_SEND_KEY", "")
    vi.stubGlobal("Deno", {
      env: {
        get: () => {
          throw new Error('Requires env access to "CHARCHY_SEND_KEY"')
        },
      },
    })
    const app = sendingApp(charchySend({ fetch: fakeFetch().fetch }))
    app.onError((error, c) => c.text(error.message, 500))
    const response = await app.request("/send", { method: "POST" })
    expect(response.status).toBe(500)
    expect(await response.text()).toMatch(/--allow-env|env access/)
  })

  it("takes an explicit key over every environment", async () => {
    vi.stubEnv("CHARCHY_SEND_KEY", LIVE_KEY)
    const { fetch, calls } = fakeFetch(accepted)
    await sendingApp(charchySend({ apiKey: OTHER_TEST_KEY, fetch })).request("/send", { method: "POST" }, { CHARCHY_SEND_KEY: TEST_KEY })
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${OTHER_TEST_KEY}`)
  })

  it("takes a key function — another binding name, or an async Secrets Store binding", async () => {
    const { fetch, calls } = fakeFetch(accepted, accepted)
    await sendingApp(charchySend({ apiKey: (c) => c.env.MY_SEND_KEY, fetch })).request("/send", { method: "POST" }, { MY_SEND_KEY: TEST_KEY })
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`)

    const secretsStore = { get: async () => OTHER_TEST_KEY }
    await sendingApp(charchySend({ apiKey: (c) => c.env.SEND_KEY.get(), fetch })).request("/send", { method: "POST" }, { SEND_KEY: secretsStore })
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${OTHER_TEST_KEY}`)
  })

  it("still sets a client without a key: its calls return missing_api_key, nothing sent", async () => {
    vi.stubEnv("CHARCHY_SEND_KEY", "")
    const { fetch, calls } = fakeFetch()
    const response = await sendingApp(charchySend({ fetch })).request("/send", { method: "POST" }, { CHARCHY_SEND_KEY: "" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode: null, id: null, error: "missing_api_key" })
    expect(calls).toHaveLength(0)
  })

  it("returns invalid_api_key for a binding that isn't a key, without echoing it", async () => {
    const { fetch, calls } = fakeFetch()
    const response = await sendingApp(charchySend({ fetch })).request("/send", { method: "POST" }, { CHARCHY_SEND_KEY: "sk_live_not_ours" })
    expect(await response.json()).toMatchObject({ error: "invalid_api_key" })
    expect(calls).toHaveLength(0)
  })

  it("keeps one client per key across requests", async () => {
    const app = new Hono<{ Variables: CharchySendVariables }>()
    const seen: CharchySend[] = []
    app.use(charchySend())
    app.get("/", (c) => {
      seen.push(c.var.charchySend)
      return c.body(null, 204)
    })
    await app.request("/", {}, { CHARCHY_SEND_KEY: TEST_KEY })
    await app.request("/", {}, { CHARCHY_SEND_KEY: TEST_KEY })
    await app.request("/", {}, { CHARCHY_SEND_KEY: LIVE_KEY })
    expect(seen[0]).toBeInstanceOf(CharchySend)
    expect(seen[0]).toBe(seen[1])
    expect(seen[2]).not.toBe(seen[0])
    expect(seen[2]!.mode).toBe("live")
  })

  it("bounds the cache when keys keep changing", async () => {
    const app = new Hono<{ Variables: CharchySendVariables }>()
    const seen: CharchySend[] = []
    app.use(charchySend())
    app.get("/", (c) => {
      seen.push(c.var.charchySend)
      return c.body(null, 204)
    })
    const keys = Array.from({ length: 10 }, (_, index) => `chy_test_${index.toString(16).repeat(64)}`)
    for (const key of keys) await app.request("/", {}, { CHARCHY_SEND_KEY: key })
    await app.request("/", {}, { CHARCHY_SEND_KEY: keys[0]! }) // evicted: a fresh client
    await app.request("/", {}, { CHARCHY_SEND_KEY: keys[9]! }) // still cached
    expect(seen[10]).not.toBe(seen[0])
    expect(seen[11]).toBe(seen[9])
  })

  it("sets the variable name you choose", async () => {
    const app = new Hono<{ Variables: CharchySendVariables<"mailer"> }>()
    app.use(charchySend({ variable: "mailer" }))
    app.get("/", (c) => c.json({ mode: c.var.mailer.mode, default: c.get("charchySend" as never) ?? null }))
    expect(await (await app.request("/", {}, { CHARCHY_SEND_KEY: TEST_KEY })).json()).toEqual({ mode: "test", default: null })
  })

  it("checks options when the app is built, not on a request", () => {
    expect(() => charchySend({ maxRetries: 11 })).toThrow(/maxRetries/)
    expect(() => charchySend({ baseUrl: "http://api.example.com" })).toThrow(/https/)
    expect(() => charchySend({ variable: "" })).toThrow(/variable/)
  })

  it("passes client options through", async () => {
    const { fetch, calls } = fakeFetch(accepted)
    await sendingApp(charchySend({ fetch, baseUrl: "http://localhost:8787", userAgent: "my-worker/1.0" })).request(
      "/send",
      { method: "POST" },
      { CHARCHY_SEND_KEY: TEST_KEY }
    )
    expect(calls[0]!.url).toBe("http://localhost:8787/v1/emails")
    expect(calls[0]!.headers["user-agent"]).toMatch(/ my-worker\/1\.0$/)
  })

  it("reaches routes mounted with app.route()", async () => {
    const { fetch, calls } = fakeFetch(accepted)
    type AppEnv = { Bindings: { CHARCHY_SEND_KEY: string }; Variables: CharchySendVariables }
    const users = new Hono<AppEnv>()
    users.post("/", async (c) => {
      const { error } = await c.var.charchySend.emails.send({ from: "a@example.com", to: "b@example.com", subject: "s", text: "t" })
      return c.json({ error: error?.code ?? null })
    })
    const app = new Hono<AppEnv>()
    app.use("/api/*", charchySend({ fetch }))
    app.route("/api/users", users)
    const response = await app.request("/api/users", { method: "POST" }, { CHARCHY_SEND_KEY: TEST_KEY })
    expect(await response.json()).toEqual({ error: null })
    expect(calls).toHaveLength(1)
  })
})

// ─── Webhooks ───────────────────────────────────────────────────────

const deliveredPayload = JSON.stringify({
  id: "evt_2b7k9x4m1q8w3n5p6r0s2t4v",
  type: "email.delivered",
  created_at: "2026-11-16T09:00:02.400Z",
  data: {
    email_id: "em_8f2k1x9q4w7m3n5p6r0s2t4v",
    from: "orders@daringaming.com",
    to: ["customer@example.com"],
    subject: "داواکارییەکەت گەیشت",
    created_at: "2026-11-16T09:00:00.120Z",
    tags: {},
    test: false,
    recipient: "customer@example.com",
  },
})

function signedRequest(secret: string, body = deliveredPayload, init: RequestInit = {}): RequestInit {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...signedHeaders([secret], { id: "evt_2b7k9x4m1q8w3n5p6r0s2t4v", timestamp: NOW_SECONDS, body }) },
    ...init,
  }
}

describe("charchyWebhook", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW_SECONDS * 1000)
  })

  type Bindings = { CHARCHY_WEBHOOK_SECRET: string; BOUNCES: { add(address: string): void } }

  it("verifies with the binding's secret and hands the typed event and the context to the handler", async () => {
    const secret = newWebhookSecret()
    const delivered: string[] = []
    const app = new Hono<{ Bindings: Bindings }>()
    app.post(
      "/webhooks/charchy",
      charchyWebhook<{ Bindings: Bindings }>({
        "email.delivered": (event, c) => {
          delivered.push(event.data.recipient)
          c.env.BOUNCES.add(event.data.emailId)
        },
      })
    )
    const added: string[] = []
    const response = await app.request("/webhooks/charchy", signedRequest(secret), { CHARCHY_WEBHOOK_SECRET: secret, BOUNCES: { add: (id: string) => added.push(id) } })
    expect(response.status).toBe(204)
    expect(delivered).toEqual(["customer@example.com"])
    expect(added).toEqual(["em_8f2k1x9q4w7m3n5p6r0s2t4v"])
  })

  it("falls back to process.env, and takes an explicit secret or a function", async () => {
    const secret = newWebhookSecret()
    vi.stubEnv("CHARCHY_WEBHOOK_SECRET", secret)
    const app = new Hono()
    app.post("/env", charchyWebhook({}))
    app.post("/explicit", charchyWebhook({}, { secret: newWebhookSecret() }))
    app.post("/function", charchyWebhook({}, { secret: (c) => c.env.OTHER }))
    expect((await app.request("/env", signedRequest(secret))).status).toBe(204)
    expect((await app.request("/explicit", signedRequest(secret))).status).toBe(400) // the explicit secret wins, and doesn't match
    expect((await app.request("/function", signedRequest(secret), { OTHER: secret })).status).toBe(204)
  })

  it("answers 400 to a bad signature, a changed body or missing headers — with no detail", async () => {
    const secret = newWebhookSecret()
    const onError = vi.fn()
    const app = new Hono()
    app.post("/hook", charchyWebhook({}, { secret, onError }))

    const wrongSecret = await app.request("/hook", signedRequest(newWebhookSecret()))
    expect(wrongSecret.status).toBe(400)
    expect(await wrongSecret.text()).toBe("Invalid webhook")

    const tampered = signedRequest(secret)
    expect((await app.request("/hook", { ...tampered, body: deliveredPayload.replace("customer", "Customer") })).status).toBe(400)
    expect((await app.request("/hook", { method: "POST", body: deliveredPayload })).status).toBe(400)
    expect(onError.mock.calls.map(([error]) => (error as { reason: string }).reason)).toEqual(["invalid_signature", "invalid_signature", "missing_headers"])
    expect(onError.mock.calls[0]![1]).toBeNull()
    expect(onError.mock.calls[0]![2]).toHaveProperty("req") // the Hono context
  })

  it("answers 500 when the secret is missing, malformed or its function throws, so the event is retried", async () => {
    vi.stubEnv("CHARCHY_WEBHOOK_SECRET", "")
    const app = new Hono()
    app.post("/missing", charchyWebhook({}))
    app.post("/malformed", charchyWebhook({}, { secret: "whsec_***" }))
    app.post(
      "/throws",
      charchyWebhook(
        {},
        {
          secret: () => {
            throw new Error("store unavailable")
          },
          onError: () => {},
        }
      )
    )
    for (const path of ["/missing", "/malformed", "/throws"]) {
      const response = await app.request(path, signedRequest(newWebhookSecret()))
      expect(response.status).toBe(500)
      expect(await response.text()).toBe("Webhook endpoint misconfigured")
    }
  })

  it("answers 405 to anything but POST", async () => {
    const app = new Hono()
    app.all("/hook", charchyWebhook({}, { secret: newWebhookSecret() }))
    const response = await app.request("/hook", { method: "PUT", body: "x" })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
  })

  it("answers 500 when a handler throws, and 204 for an event with no handler", async () => {
    const secret = newWebhookSecret()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const app = new Hono()
    app.post("/throws", charchyWebhook({ "email.delivered": () => Promise.reject(new Error("db down")) }, { secret }))
    app.post("/unhandled", charchyWebhook({ "email.bounced": () => {} }, { secret }))
    expect((await app.request("/throws", signedRequest(secret))).status).toBe(500)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("email.delivered"), expect.any(Error))
    expect((await app.request("/unhandled", signedRequest(secret))).status).toBe(204)
  })

  it("verifies after a middleware read the body as JSON or text (Hono caches body reads)", async () => {
    const secret = newWebhookSecret()
    const seen: unknown[] = []
    const app = new Hono()
    app.use("/json", async (c, next) => {
      seen.push(await c.req.json())
      await next()
    })
    app.use("/text", async (c, next) => {
      seen.push(await c.req.text())
      await next()
    })
    app.use("/bytes", async (c, next) => {
      seen.push(await c.req.arrayBuffer())
      await next()
    })
    for (const path of ["/json", "/text", "/bytes"]) app.post(path, charchyWebhook({}, { secret }))
    for (const path of ["/json", "/text", "/bytes"]) expect((await app.request(path, signedRequest(secret))).status, path).toBe(204)
    expect(seen).toHaveLength(3)
  })

  it("lets a later handler read the body again", async () => {
    const secret = newWebhookSecret()
    const app = new Hono()
    const webhook = charchyWebhook({}, { secret })
    let after: string | null = null
    app.post("/hook", async (c, next) => {
      await next()
      after = await c.req.text()
    }, webhook)
    expect((await app.request("/hook", signedRequest(secret))).status).toBe(204)
    expect(after).toBe(deliveredPayload)
  })

  it("answers 500 and says why when the raw body was consumed straight from c.req.raw", async () => {
    const secret = newWebhookSecret()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const onError = vi.fn()
    const app = new Hono()
    app.use(async (c, next) => {
      await c.req.raw.text()
      await next()
    })
    app.post("/default", charchyWebhook({}, { secret }))
    app.post("/reported", charchyWebhook({}, { secret, onError }))
    const response = await app.request("/default", signedRequest(secret))
    expect(response.status).toBe(500)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("c.req.raw"))
    expect((await app.request("/reported", signedRequest(secret))).status).toBe(500)
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(WebhookBodyUnavailableError)
  })

  it("answers 500 when the body was read as form data", async () => {
    const secret = newWebhookSecret()
    const app = new Hono()
    app.use(async (c, next) => {
      await c.req.formData().catch(() => null)
      await next()
    })
    app.post("/hook", charchyWebhook({}, { secret, onError: () => {} }))
    const response = await app.request("/hook", signedRequest(secret, deliveredPayload, { headers: { ...signedRequest(secret).headers, "content-type": "application/x-www-form-urlencoded" } }))
    expect(response.status).toBe(500)
  })

  it("types each handler's event by its type", async () => {
    const secret = newWebhookSecret()
    const app = new Hono()
    const types: WebhookEvent["type"][] = []
    app.post(
      "/hook",
      charchyWebhook(
        {
          "email.bounced": (event) => {
            types.push(event.type)
            return event.data.bounce.subType
          },
          "email.delivered": (event) => {
            types.push(event.type)
            return event.data.recipient
          },
        },
        { secret }
      )
    )
    await app.request("/hook", signedRequest(secret))
    expect(types).toEqual(["email.delivered"])
  })
})

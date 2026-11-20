/**
 * Compile-time checks for `@charchy/send/hono`: the variable is typed where
 * the middleware runs, handlers get typed events and the app's context.
 */

import { Hono, type Context } from "hono"
import type { CharchySend } from "../src/index.js"
import { charchySend, charchyWebhook, type CharchySendVariables } from "../src/hono.js"

type Equal<Left, Right> = (<Probe>() => Probe extends Left ? 1 : 2) extends <Probe>() => Probe extends Right ? 1 : 2 ? true : false
type Assert<Condition extends true> = Condition

// 1. Declared on the app: every route sees c.var.charchySend.
type AppEnv = { Bindings: { CHARCHY_SEND_KEY: string; DB: { run(sql: string): Promise<void> } }; Variables: CharchySendVariables }
const app = new Hono<AppEnv>()
app.use(charchySend())
app.get("/", (c) => {
  const client = c.var.charchySend
  type _ = Assert<Equal<typeof client, CharchySend>>
  return c.text(String(c.get("charchySend").mode))
})

// 2. Chained: the middleware's own Env flows into the app.
const chained = new Hono().use(charchySend()).get("/", (c) => c.text(String(c.var.charchySend.mode)))
void chained

// 3. A renamed variable.
const renamed = new Hono().use(charchySend({ variable: "mailer" })).get("/", (c) => {
  type _ = Assert<Equal<typeof c.var.mailer, CharchySend>>
  // @ts-expect-error — only the chosen name is set
  void c.var.charchySend
  return c.text("ok")
})
void renamed

// 4. The webhook handler: typed events; the context typed from the generic.
app.post(
  "/webhooks/charchy",
  charchyWebhook<AppEnv>({
    "email.bounced": async (event, c) => {
      type _ = Assert<Equal<typeof event.type, "email.bounced">>
      await c.env.DB.run(`-- ${event.data.bounce.type} ${event.data.recipient}`)
      c.var.charchySend.mode
    },
    "balance.low": (event) => event.data.emailsLeft,
  })
)

// 5. Without the generic it still fits any app; the context is untyped (any).
app.post(
  "/webhooks/loose",
  charchyWebhook({
    "email.delivered": (_event, c: Context) => c.env,
    // @ts-expect-error — not an event type
    "email.opened": () => {},
  })
)

// 6. Options are the client's options plus apiKey/variable.
charchySend({ apiKey: (c) => c.env.MY_KEY, maxRetries: 0, timeoutMs: 5_000, userAgent: "x/1" })
charchySend({ apiKey: async () => "chy_test_…" })
// @ts-expect-error — not an option
charchySend({ retries: 2 })

export {}

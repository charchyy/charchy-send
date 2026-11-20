// Typechecks every ```ts / ```tsx block of README.md under strict mode, as
// its own module, against the SDK's source — so an example on npm can't drift
// from the API or stop compiling. Part of `pnpm typecheck`.
//
// Names an example uses without defining (`from`, `users`, `queue`…) are
// declared once in the prelude below; `express` and `next/server` get just
// enough types for the examples.

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(root, ".readme-check")
const readme = readFileSync(join(root, "README.md"), "utf8")

const blocks = [...readme.matchAll(/^```(ts|tsx)\n([\s\S]*?)^```$/gm)].map((match) => ({ language: match[1], code: match[2] }))
if (blocks.length === 0) throw new Error("No ts blocks found in README.md")

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, "emails"), { recursive: true })

writeFileSync(
  join(out, "prelude.d.ts"),
  `// Names the README's examples use without defining them.
declare const send: import("@charchy/send").CharchySend
declare const unwrap: typeof import("@charchy/send").unwrap
declare const readFile: typeof import("node:fs/promises").readFile
declare const from: string
declare const to: string
declare const html: string
declare const logoBase64: string
declare const order: { id: string }
declare const users: { email: string; name: string }[]
declare function receiptHtml(user: { email: string; name: string }): string
declare function markBounced(address: string, bounceType?: string): Promise<void>
declare function markComplained(address: string): Promise<void>
declare function alertOps(message: string): Promise<void>
declare const queue: { add(name: string, payload: unknown): Promise<unknown> }
declare const customFetch: import("@charchy/send").FetchLike

declare module "express" {
  type Request = { body: Uint8Array; headers: Record<string, string | string[] | undefined> }
  type Response = { status(code: number): Response; send(body: string): Response; sendStatus(code: number): Response }
  type Handler = (req: Request, res: Response) => unknown
  type App = { post(path: string, ...handlers: Handler[]): void }
  const express: { (): App; raw(options: { type: string }): Handler }
  export default express
}

declare module "next/server" {
  export function after(task: () => unknown): void
}
`
)
writeFileSync(
  join(out, "emails", "welcome.tsx"),
  `export function WelcomeEmail({ name }: { name: string }) {\n  return <p>Welcome, {name}</p>\n}\n`
)
blocks.forEach((block, index) => {
  writeFileSync(join(out, `block-${String(index + 1).padStart(2, "0")}.${block.language}`), `${block.code}\nexport {}\n`)
})
writeFileSync(
  join(out, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        moduleDetection: "force",
        jsx: "react-jsx",
        types: ["node"],
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        noEmit: true,
        paths: { "@charchy/send": ["../src/index.ts"], "@charchy/send/hono": ["../src/hono.ts"] },
      },
      include: ["**/*.ts", "**/*.tsx"],
    },
    null,
    2
  )
)

try {
  execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", join(out, "tsconfig.json")], { stdio: "inherit" })
  console.log(`README: ${blocks.length} code blocks typecheck.`)
} catch {
  console.error(`README: a code block does not typecheck (see .readme-check/block-NN for the numbering).`)
  process.exit(1)
}

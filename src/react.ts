import { CharchySendError } from "./errors.js"
import type { ReactEmailElement } from "./types.js"

type RenderModule = { render: (element: ReactEmailElement) => Promise<string> | string }

/**
 * `react` → HTML with `@react-email/render`, an OPTIONAL peer dependency:
 * imported only when an email has `react`, never bundled into this package.
 */
export async function renderReactEmail(element: ReactEmailElement): Promise<{ ok: true; html: string } | { ok: false; error: CharchySendError }> {
  let renderer: RenderModule
  try {
    renderer = (await import("@react-email/render")) as unknown as RenderModule
  } catch (cause) {
    return {
      ok: false,
      error: new CharchySendError({
        code: "react_render_error",
        field: "react",
        message: "To send `react`, install @react-email/render (npm install @react-email/render), or render the email yourself and pass `html`.",
        statusCode: null,
        cause,
      }),
    }
  }
  try {
    return { ok: true, html: await renderer.render(element) }
  } catch (cause) {
    return {
      ok: false,
      error: new CharchySendError({
        code: "react_render_error",
        field: "react",
        message: `Rendering the React email failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        statusCode: null,
        cause,
      }),
    }
  }
}

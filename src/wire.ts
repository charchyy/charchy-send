/**
 * camelCase input → the API's snake_case request body, field by field (the
 * request side is mapped explicitly: the result is typed as the generated
 * OpenAPI request type, so a wrong name fails typecheck). Also does the
 * conveniences: one address or many, Date/duration times, bytes → base64,
 * `react` → `html`, a content type from the file name.
 */

import { formatAddress, formatAddressList } from "./addresses.js"
import { localValidationError, type CharchySendError } from "./errors.js"
import type { components } from "./generated/openapi.js"
import { renderReactEmail } from "./react.js"
import { bytesToBase64 } from "./runtime.js"
import { toApiDateTime } from "./time.js"
import type { Attachment, EmailParams, SendEmailParams } from "./types.js"

type WireEmailFields = components["schemas"]["EmailFields"]
type WireSendEmail = components["schemas"]["SendEmailRequest"]
type WireAttachment = components["schemas"]["Attachment"]

type Mapped<Value> = { ok: true; value: Value } | { ok: false; error: CharchySendError }

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  ics: "text/calendar",
  html: "text/html",
  json: "application/json",
  zip: "application/zip",
}

export function contentTypeFromFilename(filename: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase()
  return extension === undefined ? undefined : CONTENT_TYPES[extension]
}

export async function toWireEmailFields(params: EmailParams, fieldPrefix = ""): Promise<Mapped<WireEmailFields>> {
  const field = (name: string) => `${fieldPrefix}${name}`
  if (params.react !== undefined && params.html !== undefined) {
    return { ok: false, error: localValidationError(field("react"), "Give `react` or `html`, not both: `react` is rendered into `html`.") }
  }

  let html = params.html
  if (params.react !== undefined) {
    const rendered = await renderReactEmail(params.react)
    if (!rendered.ok) return rendered
    html = rendered.html
  }

  const from = formatAddress(params.from, field("from"))
  if (!from.ok) return from
  const to = formatAddressList(params.to, field("to"))
  if (!to.ok) return to
  const wire: WireEmailFields = { from: from.value, to: to.value, subject: params.subject }
  for (const [name, wireName] of [
    ["cc", "cc"],
    ["bcc", "bcc"],
    ["replyTo", "reply_to"],
  ] as const) {
    const addresses = params[name]
    if (addresses === undefined) continue
    const list = formatAddressList(addresses, field(name))
    if (!list.ok) return list
    wire[wireName] = list.value
  }
  if (html !== undefined) wire.html = html
  if (params.text !== undefined) wire.text = params.text
  if (params.headers !== undefined) wire.headers = params.headers
  if (params.tags !== undefined) wire.tags = params.tags

  for (const [name, wireName] of [
    ["scheduledAt", "scheduled_at"],
    ["expiresAt", "expires_at"],
  ] as const) {
    const value = params[name]
    if (value === undefined) continue
    const converted = toApiDateTime(field(name), value)
    if (!converted.ok) return converted
    wire[wireName] = converted.value
  }

  // An expiry already past, or before the send time, can only end `expired`: say so now.
  const expiresAt = wire.expires_at === undefined ? Number.NaN : Date.parse(wire.expires_at)
  if (!Number.isNaN(expiresAt)) {
    if (expiresAt <= Date.now()) {
      return { ok: false, error: localValidationError(field("expiresAt"), "expiresAt is already past: the email would expire before it is sent.") }
    }
    const scheduledAt = wire.scheduled_at === undefined ? Number.NaN : Date.parse(wire.scheduled_at)
    if (!Number.isNaN(scheduledAt) && expiresAt <= scheduledAt) {
      return { ok: false, error: localValidationError(field("expiresAt"), "expiresAt must be after scheduledAt: the email would expire before it is due.") }
    }
  }
  return { ok: true, value: wire }
}

async function toWireAttachment(attachment: Attachment, field: string): Promise<Mapped<WireAttachment>> {
  const contentType = attachment.contentType ?? contentTypeFromFilename(attachment.filename)
  if (contentType === undefined) {
    return { ok: false, error: localValidationError(`${field}.contentType`, `Set contentType for "${attachment.filename}" (e.g. "application/pdf").`) }
  }
  const { content } = attachment
  let base64: string
  if (typeof content === "string") base64 = content
  else if (content instanceof Uint8Array) base64 = bytesToBase64(content)
  else if (content instanceof ArrayBuffer) base64 = bytesToBase64(new Uint8Array(content))
  else if (typeof Blob !== "undefined" && content instanceof Blob) base64 = bytesToBase64(new Uint8Array(await content.arrayBuffer()))
  else return { ok: false, error: localValidationError(`${field}.content`, "content must be a Uint8Array, Buffer, ArrayBuffer, Blob or base64 string.") }

  const wire: WireAttachment = { filename: attachment.filename, content: base64, content_type: contentType }
  if (attachment.contentId !== undefined) wire.content_id = attachment.contentId
  return { ok: true, value: wire }
}

export async function toWireSendEmail(params: SendEmailParams): Promise<Mapped<WireSendEmail>> {
  const fields = await toWireEmailFields(params)
  if (!fields.ok) return fields
  if (params.attachments === undefined) return fields
  const attachments: WireAttachment[] = []
  for (const [index, attachment] of params.attachments.entries()) {
    const mapped = await toWireAttachment(attachment, `attachments[${index}]`)
    if (!mapped.ok) return mapped
    attachments.push(mapped.value)
  }
  return { ok: true, value: { ...fields.value, attachments } }
}

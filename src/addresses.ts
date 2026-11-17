/**
 * Addresses as the API reads them: `a@b.com` or `Name <a@b.com>`, the name
 * optionally in double quotes with `\` escapes. The API refuses a line break anywhere,
 * a control character in a name, and `<` or `>` in a name even when quoted —
 * so does this, before anything is sent.
 *
 * `{ name, email }` is written as `Name <email>`, the name quoted when it has
 * an RFC 5322 special (`"(),.:;<>@[\]`) so a comma can never split it into
 * two recipients. Kurdish and Arabic names need no quoting: the API encodes
 * them (RFC 2047) when it sends.
 */

import { localValidationError, type CharchySendError } from "./errors.js"
import type { Address, AddressInput } from "./types.js"

type Mapped<Value> = { ok: true; value: Value } | { ok: false; error: CharchySendError }

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/
const NEEDS_QUOTES = /[",.:;()[\]@\\]/

export function formatAddress(address: Address, field: string): Mapped<string> {
  if (typeof address === "string") {
    if (CONTROL.test(address)) return { ok: false, error: localValidationError(field, `${field} contains a line break or control character.`) }
    return { ok: true, value: address }
  }
  if (address === null || typeof address !== "object" || typeof address.email !== "string") {
    return { ok: false, error: localValidationError(field, `${field} must be "a@example.com", "Name <a@example.com>" or { name, email }.`) }
  }
  // Control characters are checked BEFORE trimming: a trailing CR/LF is still an injection attempt.
  if (CONTROL.test(address.email)) return { ok: false, error: localValidationError(`${field}.email`, `${field}.email contains a line break or control character.`) }
  const email = address.email.trim()
  if (email.length === 0 || /[\s<>]/.test(email) || !email.includes("@")) {
    return { ok: false, error: localValidationError(`${field}.email`, `${field}.email is not an email address.`) }
  }
  if (address.name !== undefined && typeof address.name !== "string") {
    return { ok: false, error: localValidationError(`${field}.name`, `${field}.name must be a string.`) }
  }
  if (CONTROL.test(address.name ?? "")) return { ok: false, error: localValidationError(`${field}.name`, `${field}.name contains a line break or control character.`) }
  const name = (address.name ?? "").trim()
  if (name.length === 0) return { ok: true, value: email }
  if (/[<>]/.test(name)) return { ok: false, error: localValidationError(`${field}.name`, `${field}.name can't contain < or >.`) }
  const written = NEEDS_QUOTES.test(name) ? `"${name.replace(/[\\"]/g, (special) => `\\${special}`)}"` : name
  return { ok: true, value: `${written} <${email}>` }
}

export function formatAddressList(addresses: AddressInput, field: string): Mapped<string[]> {
  const list = Array.isArray(addresses) ? addresses : [addresses]
  const formatted: string[] = []
  for (const [index, address] of list.entries()) {
    const mapped = formatAddress(address, Array.isArray(addresses) ? `${field}[${index}]` : field)
    if (!mapped.ok) return mapped
    formatted.push(mapped.value)
  }
  return { ok: true, value: formatted }
}

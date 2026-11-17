import { localValidationError, type CharchySendError } from "./errors.js"
import type { DateInput } from "./types.js"

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const DURATION = /^\s*(\d+)\s*([smhd])\s*$/i

/** `"10m"` → milliseconds, or null when the string is not a short duration. */
export function parseDuration(value: string): number | null {
  const match = DURATION.exec(value)
  if (!match) return null
  const unit = match[2]!.toLowerCase() as keyof typeof UNIT_MS
  return Number(match[1]) * UNIT_MS[unit]
}

/**
 * A `DateInput` as the API's ISO 8601 string:
 *
 *   Date          → toISOString()
 *   "10m", "2h"   → now + the duration, as ISO (this machine's clock)
 *   anything else → sent as it is; the API checks it
 */
export function toApiDateTime(
  field: string,
  value: DateInput,
  now: () => number = Date.now
): { ok: true; value: string } | { ok: false; error: CharchySendError } {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false, error: localValidationError(field, `${field} is an invalid Date.`) }
    return { ok: true, value: value.toISOString() }
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      error: localValidationError(field, `${field} must be a Date, an ISO 8601 string or a duration like "10m".`),
    }
  }
  const duration = parseDuration(value)
  if (duration !== null) return { ok: true, value: new Date(now() + duration).toISOString() }
  return { ok: true, value }
}

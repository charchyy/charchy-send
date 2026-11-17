import type { SimulatedOutcome } from "./types.js"

const OUTCOMES: ReadonlySet<string> = new Set<SimulatedOutcome>(["delivered", "bounced", "complained", "suppressed", "delayed"])
const LABEL = /^[A-Za-z0-9_-]{1,40}$/

/**
 * A magic address that plays out a known outcome — free, with test or live
 * keys, never reaching a real inbox (charchy.krd/docs/test-mode):
 *
 *   testAddress("bounced", "signup-42") // "bounced+signup-42@sim.charchy.krd"
 *
 * The label (letters, digits, `_`, `-`, up to 40) tells your tests apart in
 * the dashboard and in `emails.list({ to })`. Throws on an unknown outcome or
 * label: those are bugs in the test, not answers.
 */
export function testAddress(outcome: SimulatedOutcome, label?: string): string {
  if (!OUTCOMES.has(outcome)) {
    throw new TypeError(`[@charchy/send] Unknown simulated outcome. Use one of: ${[...OUTCOMES].join(", ")}.`)
  }
  if (label === undefined) return `${outcome}@sim.charchy.krd`
  if (!LABEL.test(label)) {
    throw new TypeError("[@charchy/send] A test address label is 1–40 letters, digits, _ or -.")
  }
  return `${outcome}+${label}@sim.charchy.krd`
}

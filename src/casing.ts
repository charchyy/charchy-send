/**
 * The API speaks snake_case; the SDK speaks camelCase. Answers are converted
 * generically — so a field the API adds later still reaches you, camelCased —
 * except inside `tags` and `headers`, whose keys are yours and come back as
 * you sent them.
 */

/** Objects whose keys are user data: their keys are never converted. */
const OPAQUE_KEYS = new Set(["tags", "headers"])

export type CamelCase<Key extends string> = Key extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : Key

/** The camelCase shape of an API answer type (`tags` and `headers` kept as they are). */
export type Camelize<Value> = Value extends readonly (infer Item)[]
  ? Camelize<Item>[]
  : Value extends object
    ? {
        [Key in keyof Value as Key extends string ? CamelCase<Key> : Key]: Key extends "tags" | "headers"
          ? Value[Key]
          : Camelize<Value[Key]>
      }
    : Value

export function camelCaseKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())
}

export function camelizeKeys<Value>(value: Value): Camelize<Value> {
  return convert(value) as Camelize<Value>
}

function convert(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convert)
  if (value === null || typeof value !== "object") return value
  const converted: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    converted[camelCaseKey(key)] = OPAQUE_KEYS.has(key) ? child : convert(child)
  }
  return converted
}

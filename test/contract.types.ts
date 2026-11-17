/**
 * Compile-time proof that the hand-shaped public types are exactly the
 * camelCase of the types generated from openapi.yaml. `pnpm typecheck`
 * fails here when the contract changes and src/types.ts was not updated.
 */

import type { Camelize } from "../src/casing.js"
import type { components } from "../src/generated/openapi.js"
import type { ApiErrorCode } from "../src/errors.js"
import type {
  AcceptedEmail,
  BatchResult,
  BounceDetails,
  Email,
  EmailEvent,
  EmailList,
  EmailStatus,
  EmailSummary,
  EndReason,
  Image,
  RescheduledEmail,
  Tags,
  Usage,
} from "../src/types.js"
import type { AccountPauseCode, EmailWebhookEvent, WebhookEventType } from "../src/webhooks.js"

type Schemas = components["schemas"]

type Equal<Left, Right> = (<Probe>() => Probe extends Left ? 1 : 2) extends <Probe>() => Probe extends Right ? 1 : 2 ? true : false
/** Same keys, optionality and value types, ignoring how the type is spelled (an alias, an intersection). */
type Same<Left, Right> = Equal<Flatten<Left>, Flatten<Right>>
type Flatten<Value> = Value extends readonly (infer Item)[]
  ? Flatten<Item>[]
  : Value extends object
    ? { [Key in keyof Value]: Flatten<Value[Key]> }
    : Value
type Assert<Condition extends true> = Condition

export type Contract = [
  Assert<Same<EmailStatus, Schemas["EmailStatus"]>>,
  Assert<Same<EndReason, Schemas["EndReason"]>>,
  Assert<Same<Tags, Schemas["Tags"]>>,
  Assert<Same<AcceptedEmail, Camelize<Schemas["AcceptedEmail"]>>>,
  Assert<Same<BatchResult, Camelize<Schemas["BatchResponse"]>>>,
  Assert<Same<BounceDetails, Camelize<Schemas["BounceDetails"]>>>,
  Assert<Same<EmailEvent, Camelize<Schemas["EmailEvent"]>>>,
  Assert<Same<EmailSummary, Camelize<Schemas["EmailSummary"]>>>,
  Assert<Same<Email, Camelize<Schemas["Email"]>>>,
  Assert<Same<EmailList, Camelize<Schemas["EmailList"]>>>,
  Assert<Same<RescheduledEmail, Camelize<Schemas["RescheduledEmail"]>>>,
  Assert<Same<Usage, Camelize<Schemas["Usage"]>>>,
  Assert<Same<Image, Camelize<Schemas["Image"]>>>,
  Assert<Same<ApiErrorCode, Schemas["ErrorCode"]>>,
  // Webhooks: the event names and pause codes match; the per-event `data`
  // is narrowed by hand (the contract states it in prose).
  Assert<Same<EmailWebhookEvent["type"], NonNullable<Schemas["EmailWebhookEvent"]["type"]>>>,
  Assert<
    Same<
      WebhookEventType,
      NonNullable<
        Schemas["EmailWebhookEvent"]["type"] | Schemas["DomainWebhookEvent"]["type"] | Schemas["AccountWebhookEvent"]["type"]
      >
    >
  >,
  Assert<Same<AccountPauseCode, NonNullable<NonNullable<Schemas["AccountWebhookEvent"]["data"]>["code"]>>>,
]

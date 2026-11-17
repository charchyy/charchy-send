/**
 * The public types: the API's fields in camelCase, shaped by hand so they
 * read well in an editor. test/contract.types.ts proves at typecheck time
 * that every answer type here is exactly the camelCase of the generated
 * OpenAPI type (src/generated/openapi.ts), so they cannot drift from
 * openapi.yaml.
 */

export type EmailStatus =
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "canceled"
  | "expired"
  | "suppressed"
  | "failed"
  | "unknown"

/** Up to 10 pairs; keys and values use letters, digits, `_` and `-`. Keys are never case-converted. */
export type Tags = Record<string, string>

/** Tags as an object, or as `{ name, value }` pairs. They always come back as an object. */
export type TagsInput = Tags | { name: string; value: string }[]

/**
 * One address: `"a@example.com"`, `"Name <a@example.com>"`, or
 * `{ name, email }` — the SDK writes the name safely (quoted when it holds
 * commas, quotes or other specials; Kurdish and Arabic names as they are).
 */
export type Address = string | { name?: string; email: string }

/** One address, or an array of them. */
export type AddressInput = Address | Address[]

/**
 * A moment: a `Date`, an ISO 8601 string with a time zone (sent as it is),
 * or a duration from now — `"30s"`, `"10m"`, `"2h"`, `"1d"` — turned into an
 * ISO time by the SDK with this machine's clock. The API itself takes ISO
 * 8601 only.
 */
export type DateInput = Date | string

/** A file's bytes — `Buffer` is a `Uint8Array` — or a base64 string. */
export type AttachmentContent = Uint8Array | ArrayBuffer | Blob | string

export type Attachment = {
  /** What the reader sees: a plain file name, no folders. */
  filename: string
  /** The bytes, or a string that is ALREADY base64. */
  content: AttachmentContent
  /** e.g. `application/pdf`. Optional for common extensions (pdf, png, jpg, gif, webp, txt, csv, ics, html, json, zip); required otherwise. */
  contentType?: string
  /** Makes it an inline image: `<img src="cid:<contentId>">` in your html. */
  contentId?: string
}

/** Any React element (`<WelcomeEmail />`), rendered with `@react-email/render`. */
export type ReactEmailElement = { type: unknown; props: unknown; key: unknown }

export type EmailParams = {
  from: Address
  /** `to` + `cc` + `bcc` together: at most 50 addresses. */
  to: AddressInput
  cc?: AddressInput
  bcc?: AddressInput
  replyTo?: AddressInput
  subject: string
  /** Up to 512 KB. Give `html`, `text`, `react` or a mix (not `html` with `react`). */
  html?: string
  /** Up to 512 KB. Generated from `html` when missing. */
  text?: string
  /** A React Email component, rendered to `html`. Needs `@react-email/render` installed. */
  react?: ReactEmailElement
  /** Custom headers, sent as you write them. `List-Unsubscribe` is allowed; From, To, Subject and the like are refused. */
  headers?: Record<string, string>
  tags?: TagsInput
  /** Send later: up to 30 days ahead. In the past = now. */
  scheduledAt?: DateInput
  /** Drop the email (refunded) if it can't leave by then — for codes that expire. */
  expiresAt?: DateInput
}

export type SendEmailParams = EmailParams & {
  /** Up to 3 files, 3 MB together before base64. */
  attachments?: Attachment[]
}

/** A batch email: the same fields, without attachments. */
export type BatchEmailParams = EmailParams

export type RequestOptions = {
  /** Abort the request (and its retries). */
  signal?: AbortSignal
}

export type SendOptions = RequestOptions & {
  /**
   * 1–256 printable ASCII characters, kept 24 hours. Build it from the event
   * behind the email (`order-confirmation/4821`). Without one, the SDK makes
   * a random key per call so its own retries can't send twice.
   */
  idempotencyKey?: string
}

export type AcceptedEmail = { id: string; status: EmailStatus }

export type BatchResult = {
  /** One per email, in the order you sent them. */
  emails: AcceptedEmail[]
}

export type BounceDetails = {
  /** `permanent` = a hard bounce; the address is suppressed. */
  type?: "permanent" | "transient" | "undetermined"
  subType?: string
  message?: string
  diagnosticCode?: string
}

/** Why an email ended without being delivered (`failed`, `expired`, `unknown` events). */
export type EndReason =
  | "expires_at"
  | "held_too_long"
  | "domain_not_verified"
  | "rejected"
  | "retries_exhausted"
  | "content_missing"
  | "recipient_not_allowed"
  | "no_answer"

export type EmailEvent = {
  type: EmailStatus
  /** ISO 8601. */
  at: string
  /** Set on per-recipient events (delivered, delayed, bounced, complained, suppressed). */
  recipient?: string
  bounce?: BounceDetails
  reason?: EndReason
  /** Why, in words (`failed`). */
  message?: string
  /** Played out by test mode or a magic address — nothing was sent. */
  simulated?: boolean
}

export type EmailSummary = {
  id: string
  status: EmailStatus
  from: string
  to: string[]
  subject: string
  tags: Tags
  /** Sent with a test key. */
  test: boolean
  createdAt: string
  scheduledAt: string | null
}

export type Email = {
  id: string
  status: EmailStatus
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  tags: Tags
  /** Sent with a test key. */
  test: boolean
  createdAt: string
  scheduledAt: string | null
  expiresAt: string | null
  /** The timeline, one entry per recipient for per-recipient events. */
  events: EmailEvent[]
}

export type EmailList = {
  data: EmailSummary[]
  hasMore: boolean
  /** Pass as `after` for the next page. */
  nextCursor?: string
}

export type ListEmailsParams = {
  /** Page size, 1–100 (default 20). */
  limit?: number
  /** The `nextCursor` of the previous page. */
  after?: string
  status?: EmailStatus
  /** A tag as `key:value`, e.g. `type:order_confirmation`. */
  tag?: string
  /** A recipient address. */
  to?: string
}

export type RescheduledEmail = { id: string; status: "scheduled"; scheduledAt: string }

export type Usage = {
  /** The current monthly plan, or null without one. */
  plan: {
    key: "starter" | "growth" | "pro" | "scale"
    emailsIncluded: number
    emailsUsed: number
    emailsLeft: number
    termEndsAt: string
  } | null
  /** Pay-as-you-go credits, or null with none. */
  credits: {
    emails: number
    /** One expiry for the whole balance. */
    expiresAt: string
  } | null
  daily: {
    /** Recipients a rolling 24 hours your plan (or credits) gives. */
    cap: number
    /** The most a rush may reach while your sending is healthy; `daily_limit_reached` comes past this. */
    surgeCap: number
    used: number
    resetsAt: string
  }
  rateLimit: { requestsPerSecond: number; burst: number }
  test: { dailyCap: number; used: number }
}

export type Image = {
  id: string
  /** Permanent public URL, for `<img src>`. */
  url: string
  contentType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  /** Bytes. */
  size: number
}

/** The outcomes the `@sim.charchy.krd` magic addresses play out. */
export type SimulatedOutcome = "delivered" | "bounced" | "complained" | "suppressed" | "delayed"

export type WaitForOptions = RequestOptions & {
  /** Resolve once the email has one of these statuses. Default: any status it ends in (delivered, bounced, complained, suppressed, canceled, expired, failed, unknown). */
  until?: EmailStatus[]
  /** Give up after this long (`wait_timeout`). Default 60 000; at most 600 000. */
  timeoutMs?: number
  /** Between reads. Default 1 000; at least 250. */
  intervalMs?: number
}

/** An image's bytes: a `Blob`/`File`, `Uint8Array` (or `Buffer`) or `ArrayBuffer`. */
export type ImageInput = Blob | Uint8Array | ArrayBuffer

export type UploadImageOptions = RequestOptions & {
  /** The file name in the URL. Defaults to the `File`'s name, else `image`. */
  filename?: string
  /** Only labels the upload; the API judges the type by the file's bytes. */
  contentType?: string
}

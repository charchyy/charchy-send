import { camelizeKeys } from "../casing.js"
import { localFailure, localValidationError, type Result } from "../errors.js"
import type { components } from "../generated/openapi.js"
import { INSPECT } from "../runtime.js"
import { callApi, type TransportConfig } from "../transport.js"
import type { Image, ImageInput, RequestOptions, UploadImageOptions, Usage } from "../types.js"
import { mapData } from "./emails.js"

type Schemas = components["schemas"]

export class Images {
  readonly #config: TransportConfig

  constructor(config: TransportConfig) {
    this.#config = config
  }

  /**
   * `POST /v1/images` — host a PNG, JPEG, GIF or WebP (up to 2 MB) on
   * files.charchy.krd and get its permanent URL. Needs a full-permission key.
   */
  async upload(file: ImageInput, options: UploadImageOptions = {}): Promise<Result<Image>> {
    let blob: Blob
    if (typeof Blob !== "undefined" && file instanceof Blob) blob = file
    else if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
      const bytes = file instanceof Uint8Array ? file : new Uint8Array(file)
      blob = new Blob([bytes as Uint8Array<ArrayBuffer>], options.contentType ? { type: options.contentType } : {})
    } else {
      return localFailure(localValidationError("file", "file must be a Blob, File, Uint8Array, Buffer or ArrayBuffer."))
    }
    const fileName = options.filename ?? (blob as { name?: unknown }).name
    const form = new FormData()
    form.append("file", blob, typeof fileName === "string" && fileName.length > 0 ? fileName : "image")

    // No idempotency key on uploads: repeat only answers that say nothing was stored.
    const result = await callApi(this.#config, { method: "POST", path: "/images", form, signal: options.signal, retry: "refusals-only" })
    return mapData(result, (wire: Schemas["Image"]) => camelizeKeys(wire))
  }

  [INSPECT](): object {
    return {}
  }

  toJSON(): object {
    return {}
  }
}

export class UsageResource {
  readonly #config: TransportConfig

  constructor(config: TransportConfig) {
    this.#config = config
  }

  /** `GET /v1/usage` — plan emails, credits, today's cap, the rate limit and test sends. */
  async get(options?: RequestOptions): Promise<Result<Usage>> {
    const result = await callApi(this.#config, { method: "GET", path: "/usage", signal: options?.signal, retry: "repeatable" })
    return mapData(result, (wire: Schemas["Usage"]) => camelizeKeys(wire))
  }

  [INSPECT](): object {
    return {}
  }

  toJSON(): object {
    return {}
  }
}

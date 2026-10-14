import { invalidArguments, CampflareError } from "./errors"
import { normalizeTs } from "./ids"

/**
 * A method's arguments, gathered the ways Slack accepts them: the query
 * string, a form body (urlencoded or multipart) and a JSON body. Values from a
 * form are strings; from JSON they keep their type.
 */
export class Args {
  constructor(readonly values: Record<string, unknown>) {}

  static async from(request: Request): Promise<Args> {
    const values: Record<string, unknown> = {}
    const url = new URL(request.url)
    for (const [k, v] of url.searchParams) values[k] = v
    if (request.method === "POST") {
      const type = request.headers.get("content-type") ?? ""
      if (type.includes("application/json")) {
        const body = await request.json().catch(() => undefined)
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new CampflareError("invalid_json")
        Object.assign(values, body)
      } else if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
        const form = await request.formData().catch(() => undefined)
        if (!form) throw new CampflareError("invalid_form_data")
        for (const [k, v] of form) values[k] = v
      }
    }
    return new Args(values)
  }

  /** Whether the argument was sent at all, empty included: an empty value can mean "clear it". */
  given(name: string): boolean {
    return this.values[name] !== undefined && this.values[name] !== null
  }

  has(name: string): boolean {
    const v = this.values[name]
    return v !== undefined && v !== null && v !== ""
  }

  str(name: string): string | undefined {
    const v = this.values[name]
    if (v === undefined || v === null || v === "") return undefined
    if (typeof v === "string") return v
    if (typeof v === "number" || typeof v === "boolean") return String(v)
    return undefined
  }

  /** A required string; Slack names the error after the argument for the common ones. */
  req(name: string, code = "invalid_arguments"): string {
    const v = this.str(name)
    if (v === undefined)
      throw code === "invalid_arguments"
        ? invalidArguments(`missing required field: ${name}`)
        : new CampflareError(code)
    return v
  }

  int(name: string, fallback: number, { min = -Infinity, max = Infinity } = {}): number {
    const v = this.str(name)
    if (v === undefined) return fallback
    const n = Number.parseInt(v, 10)
    if (!Number.isFinite(n)) throw invalidArguments(`${name} must be an integer`)
    return Math.min(Math.max(n, min), max)
  }

  bool(name: string, fallback = false): boolean {
    const v = this.values[name]
    if (v === undefined || v === null || v === "") return fallback
    if (typeof v === "boolean") return v
    return v === "true" || v === "1" || v === 1
  }

  /** A comma-separated list (or a JSON array). */
  list(name: string): string[] {
    const v = this.values[name]
    if (Array.isArray(v)) return v.map(String)
    const s = this.str(name)
    return s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : []
  }

  /** A JSON value: given as JSON already, or as a JSON string in a form. */
  json<T = unknown>(name: string, code = "invalid_arguments"): T | undefined {
    const v = this.values[name]
    if (v === undefined || v === null || v === "") return undefined
    if (typeof v !== "string") return v as T
    try {
      return JSON.parse(v) as T
    } catch {
      throw code === "invalid_arguments" ? invalidArguments(`${name} must be JSON`) : new CampflareError(code)
    }
  }

  /** A message timestamp in stored form, or undefined if absent. */
  ts(name: string): string | undefined {
    const v = this.str(name)
    if (v === undefined) return undefined
    const ts = normalizeTs(v)
    if (!ts) throw invalidArguments(`${name} must be a timestamp`)
    return ts
  }

  file(name: string): File | undefined {
    const v = this.values[name]
    return v instanceof File ? v : undefined
  }
}

/** Slack cursors are opaque base64; ours wrap a position. */
export function encodeCursor(position: string): string {
  return btoa(`next:${position}`)
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined
  try {
    const raw = atob(cursor)
    if (raw.startsWith("next:")) return raw.slice(5)
  } catch {
    // fall through
  }
  throw new CampflareError("invalid_cursor")
}

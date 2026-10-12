import { SELF } from "cloudflare:test"
import { ORIGIN } from "./helpers"

// What the OAuth tests need of a browser and of a public client: PKCE pairs,
// a cookie jar, and where each response sends the browser next.

export const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  return { verifier, challenge }
}

/** A browser of sorts: follows nothing on its own, but keeps cookies. */
export function browser() {
  const jar = new Map<string, string>()
  return {
    async go(url: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers)
      if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "))
      headers.set("origin", ORIGIN)
      headers.set("sec-fetch-mode", "navigate")
      headers.set("accept", "text/html")
      const res = await SELF.fetch(new URL(url, ORIGIN).toString(), { ...init, headers, redirect: "manual" })
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(";")
        const eq = pair!.indexOf("=")
        jar.set(pair!.slice(0, eq), pair!.slice(eq + 1))
      }
      return res
    },
  }
}

/** Where a response sends the browser next: a redirect, or Better Auth's { url } JSON. */
export async function next(res: Response): Promise<string> {
  const location = res.headers.get("location")
  if (location) return location
  const body = (await res.json().catch(() => ({}))) as { url?: string; redirect?: boolean }
  if (!body.url) throw new Error(`no next step from ${res.status}: ${JSON.stringify(body)}`)
  return body.url
}

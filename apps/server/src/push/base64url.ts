// base64url without padding (RFC 4648 §5), as Web Push and JOSE write keys and signatures.

export function encode(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const b of view) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** The bytes, or undefined when it isn't base64url (or base64: browsers' keys are sometimes padded). */
export function decode(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_\-+/]*={0,2}$/.test(text)) return undefined
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "")
  if (b64.length % 4 === 1) return undefined
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export const utf8 = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * The origin clients reach us at, for URLs we hand back to them (WebSocket
 * links, permalinks, file and upload URLs, OAuth issuers). Behind something
 * that terminates TLS and forwards plain HTTP (a tunnel in development, a
 * reverse proxy), the request URL says http: the scheme the client used comes
 * in X-Forwarded-Proto or Cloudflare's CF-Visitor. Trusting them is safe here:
 * they only shape the URLs answered to the same client.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url)
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
  let visitor: string | undefined
  try {
    visitor = (JSON.parse(request.headers.get("cf-visitor") ?? "{}") as { scheme?: string }).scheme
  } catch {
    visitor = undefined
  }
  if (url.protocol === "http:" && (forwarded === "https" || visitor === "https")) url.protocol = "https:"
  return url.origin
}

// A person in a browser, for OAuth flows over real HTTP: follows redirects
// one at a time with a cookie jar, signs in on /login with their token, and
// allows on /consent. Stops at the first URL outside the server (the app's
// redirect URI) and returns it, without fetching it.

export async function approveInBrowser(
  authorizeUrl: string,
  userToken: string,
  { deny = false }: { deny?: boolean } = {},
): Promise<URL> {
  const origin = new URL(authorizeUrl).origin
  const jar = new Map<string, string>()
  const go = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "))
    headers.set("origin", origin)
    headers.set("accept", "text/html")
    const res = await fetch(new URL(url, origin), { ...init, headers, redirect: "manual" })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";")
      const eq = pair.indexOf("=")
      jar.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    return res
  }
  const post = (path: string, fields: Record<string, string>) =>
    go(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    })
  /** Where a response sends the browser: a redirect, or Better Auth's { url } answer. */
  const nextOf = async (res: Response) => {
    const location = res.headers.get("location")
    if (location) return new URL(location, origin)
    const body = (await res.json().catch(() => ({}))) as { url?: string }
    if (!body.url) throw new Error(`no next step from ${res.url} (${res.status})`)
    return new URL(body.url, origin)
  }

  let url = new URL(authorizeUrl)
  for (let hops = 0; hops < 10; hops++) {
    if (url.origin !== origin) return url
    const query = url.search.slice(1)
    if (url.pathname === "/login") url = await nextOf(await post("/login", { token: userToken, oauth_query: query }))
    else if (url.pathname === "/consent") {
      url = await nextOf(await post("/consent", { accept: deny ? "false" : "true", oauth_query: query }))
    } else url = await nextOf(await go(url.toString()))
  }
  throw new Error("too many redirects")
}

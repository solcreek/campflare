// The two pages the OAuth flow sends a person to. Plain server-rendered HTML
// forms, no scripts: they post back to /login and /consent with the signed
// query (oauth_query), and those routes call Better Auth, which answers with
// the next redirect.

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Campflare</title>
<style>
  :root { color-scheme: light dark; --fg: #1c1b1a; --bg: #faf9f7; --muted: #6b6560; --accent: #d9480f; --line: #e6e1dc; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f1eeeb; --bg: #1b1a19; --muted: #a39d97; --line: #3a3633; } }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 26rem; margin: 12vh auto; padding: 0 16px; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { color: var(--muted); }
  label { display: block; margin: 1.25rem 0 .35rem; font-weight: 600; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem .7rem; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  .row { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  ul { padding-left: 1.2rem; } code { font-size: .9em; }
</style>
</head>
<body><main>${body}</main></body>
</html>`
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // No scripts, no framing: the forms work without either.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
    },
  })
}

/** The signed query Better Auth put on this page's URL, passed back with the form. */
const oauthQuery = (url: URL) => url.search.replace(/^\?/, "")

export function loginPage(url: URL, error?: string): Response {
  return page(
    "Sign in",
    `<h1>Sign in to Campflare</h1>
<p>An app is asking to use Campflare as you. Paste a user token to continue: <code>campflare token create</code> makes one.</p>
${error ? `<p role="alert"><strong>${escape(error)}</strong></p>` : ""}
<form method="post" action="/login">
  <label for="token">Campflare token</label>
  <input id="token" name="token" type="password" autocomplete="off" required placeholder="xoxp-…">
  <input type="hidden" name="oauth_query" value="${escape(oauthQuery(url))}">
  <div class="row"><button class="primary" type="submit">Continue</button></div>
</form>`,
  )
}

export function consentPage(url: URL, client: { name: string; uri?: string | null }): Response {
  const scopes = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean)
  return page(
    "Allow access",
    `<h1>Allow ${escape(client.name)}?</h1>
<p>${escape(client.name)}${client.uri ? ` (${escape(client.uri)})` : ""} wants to use Campflare as you: read the conversations you can read, and post as you.</p>
${scopes.length ? `<ul>${scopes.map((s) => `<li><code>${escape(s)}</code></li>`).join("")}</ul>` : ""}
<form method="post" action="/consent">
  <input type="hidden" name="oauth_query" value="${escape(oauthQuery(url))}">
  <div class="row">
    <button class="primary" type="submit" name="accept" value="true">Allow</button>
    <button type="submit" name="accept" value="false">Deny</button>
  </div>
</form>`,
  )
}

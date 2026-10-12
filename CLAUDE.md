# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Campflare is a team chat server that speaks the Slack Web API, on Cloudflare
Workers + D1 + R2 + Durable Objects. API and CLI first; the app
(web and desktop) is one more client of that API.
Existing Slack clients and SDKs must work against it after a base-URL change.

## Commands

```sh
pnpm ready                 # is the checkout ready (deps, secrets, bundles, migrations)? --fix repairs it, --json
pnpm check                 # oxfmt --check, oxlint, tsc (all packages), every test suite with coverage
pnpm fmt                   # format in place (oxfmt)
pnpm dev:all               # migrations + wrangler dev on :8787 + seed; --port 0, --state <dir>, --fresh, --no-seed
                           # --web: the app too (free port with --port 0); URLs in .wrangler/campflare-dev.run.json
pnpm otui                  # opentui-slack against the dev:all server (reads .wrangler/campflare-dev.env)
pnpm web                   # the app (apps/web) on :5173, signed in to the dev:all server as alex; ?as=vincent
pnpm shot '#/C123'         # screenshot of the dev:all --web app + console errors + accessible outline (--as, --dark, --state)
pnpm e2e                   # the app in Chromium against a fresh stack of its own (needs nothing running)
pnpm desktop               # the Tauri shell around pnpm web (Rust toolchain needed)
pnpm dev                   # just wrangler dev on :8787 (apply migrations first: see below)
pnpm build                 # tsdown bundles for packages/client and apps/cli

cd apps/server
pnpm db:migrate:local      # apply migrations/ to local D1 (.wrangler/state)
npx vitest run test/chat.test.ts            # one file
npx vitest run test/chat.test.ts -t "tombstone"   # one test
```

- `pnpm test` in a package adds `--coverage` with thresholds, so a partial run
  fails the thresholds. Use `npx vitest run <file>` for a subset.
- `pnpm test:live` (`tests/live/`, opt-in, not in `pnpm check`) hits real
  Cloudflare services with the credentials in `apps/server/.dev.vars`:
  werift WebRTC peers and real Chrome (playwright-core, the installed Chrome)
  against the Realtime SFU. `RECORD_FIXTURES=1` refreshes the recorded SFU
  responses that the offline fake SFU (`apps/server/test/fake-sfu.ts`) serves.
  Server tests override the Realtime bindings, so they never reach the real API.
- `apps/cli` and `tests/conformance` tests start a real `wrangler dev` on a free
  port with fresh state (`tests/conformance/global-setup.ts`), so they're slower
  and need nothing running.
- Don't pipe `oxlint` into `tail`/`grep` before `&&`: the pipe hides its exit
  code and lint errors slip through.

## Agent loop

`.claude/settings.json` wires hooks from `scripts/agent/`: SessionStart puts the
Nix flake's toolchain (`.dev/dev-tools/bin`) on PATH via `CLAUDE_ENV_FILE` and
prints what `pnpm ready --quick` finds wrong (nothing when all is well);
PostToolUse formats and lints each edited file, returning lint errors and warnings (exit 2;
warnings fail `pnpm lint` too, so they never pile up);
Stop runs format, lint and typecheck when tracked or untracked code changed.
So: don't run oxfmt by hand after edits, and expect the Stop check. Tests are
not in the hooks: run the affected suite yourself. In a fresh worktree, run
`pnpm ready --fix` first.

Seeing the app: with `pnpm dev:all --port 0 --web` running in the background,
`pnpm shot '#/<channel id>'` finds it through the run file, saves
`apps/web/.shots/shot.png` (Read it to look) and prints console errors, failed requests
and the accessible outline. Several routes give one shot each; `--click 'button:Send'`,
`--type hi`, `--press Enter` act first, in order; a step that fails exits 1. Every screen is a hash route
(`#/C123`, `#/C123/<thread ts>`), so any state you need has a URL. Two people at once: `?as=vincent` in a second window.
UI tests select by role and accessible name, as a person would; keep controls
labelled and the jsx-a11y lint passing so they stay selectable.

## CI

GitHub Actions, every action pinned by commit SHA (Dependabot bumps them weekly).
`.github/workflows/ci.yml` runs on every push and pull request, on Ubuntu:
`pnpm install --frozen-lockfile`, `pnpm build`, Chromium, `pnpm check`, then `pnpm e2e`
(Playwright traces and screenshots are uploaded when it fails). Chromium comes before
the check because `tests/conformance/shot.test.ts` drives `pnpm shot` in it; locally
that test skips, saying so, when `pnpm ready` would report no browsers. A lockfile out
of step with `package.json` fails the install. `.github/workflows/desktop.yml`
builds the Tauri installers (macOS universal, Windows, Linux; unsigned so far)
as run artifacts and runs the desktop end-to-end tests on Linux
(`apps/desktop/e2e/`, tauri-driver under xvfb). It runs only by hand (Actions →
Desktop → Run workflow, or `gh workflow run desktop.yml`) and on `v*` tags,
because macOS and Windows minutes are expensive; `gh workflow run desktop.yml
--ref <branch> -f e2e-only=true` runs just the Linux tests. A failed desktop test
uploads the window's page source (and a screenshot, blank under xvfb so far) as
the `desktop-e2e` artifact. `pnpm --filter @campflare/desktop e2e` can't run on
macOS (no WebDriver for WKWebView).

## Layout

- `apps/server`: the Worker (Hono). Migrations in `migrations/`, tests in `test/`.
  `src/mcp/` is the remote MCP server at `/mcp`.
- `packages/client`: `@campflare/client`, a dependency-free Web API, Socket Mode and RTM client.
- `apps/cli`: the `campflare` CLI, bundled by tsdown into one file with the client inlined.
- `packages/core`: `@campflare/core`, app state on top of the client (see below).
  `@campflare/core/testing` has the fake Web API and WebSocket its tests and the app's use.
- `apps/web`: the app, React + shadcn/ui on Base UI (`components.json` style
  `base-nova`; add components with `npx shadcn@4.21.0 add <name>` in `apps/web`).
  `src/components/ui/` is generated; our components sit beside it.
- `apps/desktop`: `apps/web` in a Tauri 2 shell (`src-tauri/`), for macOS, Windows, Linux.
- `tests/conformance`: the official `@slack/web-api` and `@slack/socket-mode`,
  unmodified, against `wrangler dev`. This is the compatibility oracle. It also
  runs `@campflare/core` against the real Worker.

## Server architecture

**Method registry.** Each file in `src/methods/` calls `method(name, access, handler)`
(`src/api/context.ts`) at import time; `src/index.ts` imports them all for
their side effects. `access` is `user` (xoxp), `bot` (xoxb), `actor` (either),
`app` (xapp) or `none`. One route, `/api/:method`, parses args from query/form/
multipart/JSON (`Args` in `src/api/args.ts`), authenticates, runs the handler,
and wraps the result as `{ ok: true, ...result }`.

**Errors.** Throw `CampflareError(code)` with Slack's error code; it is answered
as HTTP 200 `{ ok: false, error }`, as Slack does. `invalidArguments()` adds
`response_metadata.messages`.

**Shapes.** `src/api/shapes.ts` turns DB rows into Slack's JSON. It sends every
field Slack always sends, with neutral values where Campflare has no concept.
Messages are serialised in batches through `loadExtras()` (reactions, files,
bot apps in one query each).

**Data.** D1 via thin helpers in `src/db/query.ts` (no ORM). Message `ts` is a
fixed-width `"##########.######"` string so text order is time order; it's
unique per channel by primary key, and `postMessage` retries with `nextTs()` on
a clash. Search is FTS5 with the **trigram** tokenizer and `remove_diacritics`
(migration 0002), so CJK substrings match and Latin text matches without case or
accents; terms under 3 characters fall back to LIKE. A thread head with replies is
tombstoned on delete, not removed. Tokens are stored as SHA-256 hashes only.

**Realtime.** After a write, handlers call `publish()` (`src/events.ts`), which
sends the event to the workspace's `TeamHub` Durable Object (`src/hub.ts`) over
RPC inside `waitUntil`. The audience is the conversation's members (or the whole
team). The hub holds hibernating WebSockets of two kinds:

- Socket Mode (`apps.connections.open`): `events_api` envelopes, one connection
  per app per event (round robin), as Slack does. An app sees what its installer
  or its bot user can see.
- RTM (`rtm.connect`): raw events to every connection of the user, including
  `rtmOnly` client-state events (`*_marked`, ephemeral messages).
  WebSocket URLs carry a signed, single-use, 60-second ticket (`src/api/tickets.ts`)
  that the hub checks against its own SQLite storage.

The hub's SQLite also holds:

- `events`: every published event for a week, numbered (`seq`), with its
  audience. `campflare.events.poll` (`src/methods/events.ts` → `TeamHub.poll`)
  reads it from a cursor and long-polls by parking a waiter that `record()`
  wakes. RPC return values must be serialisable, so events cross as JSON strings.
- `unacked`: Socket Mode envelopes until their `envelope_id` is acked; the DO
  `alarm()` resends overdue ones (3 s, up to 3 retries) on the app's next link.

**Files.** `files.getUploadURLExternal` reserves a row and returns a signed
`/upload/v1/:token` URL; bytes go to R2 at `<team>/<file>`;
`files.completeUploadExternal` shares them and posts the message. `url_private`
is served by `handleDownload` with the same Bearer tokens, with range support,
and `content-security-policy: sandbox`. `/files-pri/*` and `/upload/v1/*` answer
CORS (any origin, Authorization allowed, no credentials) so browser apps fetch
with the token; there are no signed download URLs. `/avatars/:id` draws the
user's initials (one query; a CJK name gives its first character).
Thumbnails are a TODO: uploads record an image's `width`/`height` (sent as
`original_w`/`original_h`) but no `thumb_*` are made, since resizing in a Worker
is heavy. Until then the app fetches the whole file for an inline image.

**MCP.** `/mcp` (`src/mcp/`) uses `@modelcontextprotocol/server` v2:
`createMcpHandler` builds a fresh `McpServer` per request (2026-07-28 spec, with
the stateless fallback for 2025 clients). `requireBearerAuth` gates it with a
verifier over `authenticate()`; the verified `Actor` rides in `authInfo.extra`.
Tools call Web API handlers through `invoke()` (`src/mcp/invoke.ts`) rather than
reimplementing them, then shape results compactly (`src/mcp/format.ts`). Tool
errors are `CampflareError` codes returned as `isError` results. Tests use the
official `@modelcontextprotocol/client` in workerd (`test/mcp.test.ts`) and in
Node over HTTP (`tests/conformance/mcp.test.ts`), in both protocol eras.

**OAuth (Better Auth).** `src/auth/` makes the Worker an OAuth 2.1
authorization server for MCP clients. `createAuth()` builds Better Auth per
request (its URLs follow the request's origin) with `jwt()`, `mcp()` (tokens
bound to `<origin>/mcp`, RFC 9728 metadata), `cimd()` (MCP 2026-07-28 profile;
DCR off) and `campflareSignIn()` (`src/auth/sign-in.ts`), a plugin that signs a
person in with an email and password (`/sign-in/campflare-password`) or an xoxp
token (`/sign-in/campflare-token`) and links them as an `account` (providerId
`campflare`, accountId = Campflare user id); both start the same session, so
the OAuth flows don't care which was used.

**Passwords.** Not Better Auth's `emailAndPassword`: its emails are global,
ours unique per workspace only. A password belongs to a Campflare user, in our
`passwords` table (migration 0007): PBKDF2-SHA256 via WebCrypto at 100,000
iterations (the Workers maximum; native, unlike a JS scrypt), salted, NFC
normalized (`src/auth/password.ts`). People set their own with
`campflare.users.setPassword` (xoxp; at least 10 characters; `invalid_password`,
`email_required`) or `campflare password set` (stdin or a hidden prompt, never
argv); an admin may pass `password` to `campflare.users.create`. Sign-in checks
the password of every active user with that email: one match signs in; more
than one answers `workspace_required`, and `/login` then asks for the workspace
(domain or name). An unknown email still costs one hash. The `/login` page
shows email and password first and the token form folded in a `<details>`.
Setting a password deletes the person's Better Auth `session` rows (their
browser sign-ins, found through `account`) and their throttle counters, but
not their xoxp tokens or OAuth grants: those are app installs, revoked one by one.

**Throttling sign-in** (`src/auth/throttle.ts`, table `sign_in_throttle`,
migration 0008). Never per account alone: a lock on the account lets anyone who
knows an email keep its owner out. Counters, by key, keyed on the client's
`CF-Connecting-IP` (Cloudflare sets it; missing in tests and dev, where all
share one): `rate:<ip>` caps attempts at 30 a minute, right ones too, on both
sign-in endpoints (so on `/login` too, which forwards to them; it bounds the
CPU spent on PBKDF2); `ip:<ip>` gives 20 failures (wrong passwords, unknown
emails, bad tokens) then exponential backoff (15 s doubling to 1 h);
`pair:<email>:<ip>` gives 5 wrong passwords per email from one address, then
the same backoff, and is cleared by a right password from that address;
`email:<email>` counts from every address and never blocks: past 50 it cuts
each address's free tries to one, which slows guessing spread over many
addresses while the person, from an address that hasn't guessed, still gets
in at the first right try (someone behind the guesser's own address waits with it). Keyed by email, not user, so an unknown email is
throttled the same and a wait reveals nothing. A throttled attempt answers 429
`too_many_attempts` with `Retry-After` before any hash is checked; `/login`
renders it as a 429 page saying how long to wait. Reads join the sign-in's own
query in one `DB.batch`, failures are one more; failures are forgotten a day
after their wait ends, and each attempt prunes up to 50 expired rows. Better
Auth's own limiter (in memory, per isolate) isn't relied on.

Routes (`src/auth/routes.ts`): `/auth/*` and
`/.well-known/*` go to Better Auth; `/login` and `/consent` render script-free
forms whose POSTs are forwarded to Better Auth as JSON (the only body type it
accepts), turning its `{ url }` answer into a redirect. `/mcp` verifies those
JWTs locally against `auth.api.getJwks()` (issuer `<origin>/auth`), maps `sub`
through `account` to a Campflare user (`actorFor()`), and still accepts
xoxp/xoxb. Better Auth's tables (migration 0003, generated by its
`getMigrations`) are singular camelCase: `user`, `session`, `account`,
`oauthClient`… CIMD fetches go through `src/auth/cimd-fetch.ts`; tests replace
it with `setAuthOverrides()`, which works because tests share the Worker's
isolate.

**Sign-in for apps (Slack's OAuth v2).** Apps get an xoxp user token the way
Slack's do: `GET /oauth/v2/authorize` (`src/auth/oauth-v2.ts`; `client_id`,
`redirect_uri`, `state`, `user_scope`, PKCE S256 required) only translates to
Better Auth's `/auth/oauth2/authorize` (adding `openid`), so sign-in, consent,
redirect matching and codes (single-use, 10 minutes, hashed) are Better
Auth's. `oauth.v2.access` (`src/methods/oauth.ts`) redeems the code at Better
Auth's token endpoint in process, maps the ID token's `sub` through `account`
to the Campflare user, and mints an xoxp labelled `OAuth: <client>`, with the
client id in `tokens.client_id` (migration 0006). Slack would hand the same app
the same token again; we keep only hashes, so every sign-in mints one, and the
person keeps the newest `OAUTH_TOKENS_PER_CLIENT` (5) per client, older ones
revoked in the same batch. Not just one: nothing tells two computers apart, and
revoking every earlier token would sign the CLI out on the other machine; other
clients and hand-made tokens are never touched. The same lookup batch deletes
the access/refresh tokens Better Auth issued for the code (by its
`authorizationCodeId`, the code's SHA-256 in base64url); consent stays. Bot
`scope` is refused (400); `refresh_token` is `invalid_grant_type` (our tokens
don't expire). Clients: our own public apps are rows from migration 0005,
`campflare-cli` and `campflare-desktop` (redirect `http://127.0.0.1:<any
port>/callback`, RFC 8252) and `campflare-web` (`http://localhost:<port>/`, a
web app in development); a web app at its own https origin, or anyone else's
app, uses a Client ID Metadata Document URL as `client_id`, as MCP clients do.
`campflare login --oauth` (`apps/cli/src/oauth.ts`) is the CLI's side of it;
the protocol (PKCE on WebCrypto, `authorizeUrl`, `callbackCode`, `exchangeCode`)
is `@campflare/client`'s (`src/oauth.ts`), shared with the app. Clients revoke
only the tokens they got this way (`via: "oauth"` in the CLI's profile and the
app's session), never a pasted one: `campflare logout`, and a login over such a
profile, call `auth.revoke` (best effort, 5 s) before forgetting it. The `/login` and
`/consent` pages' CSP adds the redirect URI's origin to `form-action`: browsers
check it on the redirects a POST answers with, so `'self'` alone blocks the return.

**Admin.** `campflare.*` methods (`src/methods/admin.ts`) do what Slack's admin
UI and OAuth do: `campflare.bootstrap` (needs `BOOTSTRAP_SECRET`) creates a
workspace, its owner and #general; others add people, tokens and apps (an app is
a bot user + xoxb + xapp).

**Huddles.** `src/huddle/` (`docs/huddles.md`), off unless `REALTIME_APP_ID`/
`REALTIME_APP_SECRET` are set (`huddles_not_configured`). Media never touches
the Worker: browsers send WebRTC to Cloudflare's Realtime SFU, and
`campflare.huddles.*` (`methods.ts`) drives the SFU's Connection API (`sfu.ts`)
with the App Secret, relaying SDP. `TeamHub` holds the seats (`huddle_seats`:
who publishes which tracks) and which user owns each SFU session
(`huddle_sessions`), so only members join and only a session's owner answers on
it; joins, leaves and camera changes go out as RTM events. Transcription: the
SFU's WebSocket adapter streams each speaker's audio (PCM in protobuf) to
`/huddle/scribe/<ticket>` (a signed, reusable ticket naming the speaker), which
lands in the `HuddleScribe` DO (`scribe.ts`, one per call): it segments by
loudness (`audio.ts`), transcribes with Whisper (`speech.ts`) and posts as the
Huddle Scribe bot (`scribe-bot.ts`) with `huddle_transcript` metadata; on stop
it summarises (`summary.ts`). The SFU dials out, so that endpoint must be public
(`HUDDLE_PUBLIC_URL`, or the request's origin through a tunnel). Tests replace
the SFU with `test/fake-sfu.ts`, built from recorded responses, and Workers AI
with recorded answers (`setSpeechFetch`, `setSummaryFetch`); `tests/live/` is
the real thing.

## App architecture

The app is another client of the Web API, like the CLI: it never shells out to
the CLI and never gets an endpoint of its own. Something the app needs that the
API lacks is a new Slack-shaped (or `campflare.*`) method first, with its server
test and CLI command, then UI.

**Core.** `@campflare/core` holds what every UI needs and nothing that renders.
`createWorkspace()` (`src/workspace.ts`) loads `auth.test`, `users.list` and
`conversations.list`, then follows RTM; after a reconnect it re-lists
conversations and reloads every loaded timeline's newest page, which is the
truth for its range. All changes go through one pure `reduce(state, action)`
(`src/state.ts`): Web API answers and RTM events alike, so tests replay actions
with no server. Messages are keyed `channel/ts`; a conversation's timeline holds
top-level messages, a thread's list holds replies. Sends are optimistic: a
pending message with a `~nnnnnnnn` ts (sorts last) becomes the stored one, or
stays with `failed` for Retry or Discard. A stored copy that arrives first (RTM,
a reloaded page) replaces the pending one at once (`pendingTwin`): a send by the
`client_msg_id` the server echoes, an upload by its file ids, which
`client.upload`'s `onUploaded` reports before completion, so uploads need no
API beyond Slack's. `start()` is idempotent (StrictMode).
`src/mrkdwn.ts` parses Slack mrkdwn into a tree; the app renders it as elements,
never HTML, and only links http(s) and mailto. `src/files.ts` decides image vs
card (`fileKind`; SVG is a card) and `workspace.files` turns `url_private` into
shared object URLs via `client.fetchFile` (token sent to the server's origin
only), revoked after a grace period; `workspace.upload` is optimistic like `send`.

**Web.** `useWorkspaceState(select)` is `useSyncExternalStore` over the store;
select slices as they are (`s.messages`, `s.timelines[id]`) and derive in
`useMemo`. Core's selectors take only the slices they read for that reason.
`session.ts` keeps `{url, token, via}` behind an async `SessionStore`: localStorage in
a browser, the OS keychain in the desktop shell. `platformStore()` tells them apart
at runtime by `window.__TAURI__` (`withGlobalTauri`), so the web build never
imports `@tauri-apps/*`. "Sign in with your browser" (`sign-in.ts`,
`platformSignIn()` chosen the same way): on the web the page leaves for
`/oauth/v2/authorize` and comes back to `<origin>/?code&state` (verifier in
sessionStorage under the state; `campflare-web` on loopback, else the CIMD URL
`<origin>/oauth-client.json`, which a build with `CAMPFLARE_WEB_ORIGIN` emits);
on the desktop, see below. A pasted token is the second way in. `via` says
which (`"oauth"` or `"token"`; absent in older sessions, which count as
`"token"`): Sign out calls `auth.revoke` first (`revokeSession`, best effort,
5 s at most, then signs out regardless) only for `"oauth"`, since a pasted
token may be shared with scripts, and never for the dev accounts. In dev,
`?as=none` shows the login screen, and a return from the browser is never
auto-signed-in. The composer ignores Enter while an IME
composes (`isComposing`, or keyCode 229 on Safari), which CJK input depends on.
Inline images (`message-files.tsx`) take their final box from
`original_w`/`original_h` before the bytes come, and fetch them only when they
near the viewport (`useInView`, IntersectionObserver; tests replace it with
`ViewportObserver` in `test/setup.ts`); a click opens the message's images in a
viewer dialog.

**Desktop.** The webview runs the web build and talks to the server itself; the
Rust side opens other origins' links in the system browser and keeps the session
in the OS credential store (`src/session.rs`, the `keyring` crate: Keychain,
Credential Manager, Secret Service), service `com.campflare.desktop`, through
`session_load`/`session_save`/`session_clear`. Browser sign-in can't redirect to
the webview, so `src/oauth.rs` (std only) listens like the CLI: `oauth_listen`
binds `127.0.0.1:0`, `oauth_wait` takes the one `/callback` request (5 minute
timeout), `oauth_cancel` stops it; client `campflare-desktop`, the authorize URL
opens through the opener plugin. `build.rs` declares those commands,
so each needs an `allow-*` grant in `capabilities/default.json`. A session left
in localStorage by an older build moves into the keychain on first load. macOS may
ask for Keychain access the first time (and again after a rebuild changes the
binary's signature). Without a credential store (no Secret Service on a minimal
or headless Linux, CI), the session falls back to `session.json` in the app's
config dir, created 0600 and replaced atomically: keyring errors that mean no
store or a platform failure (`classify()`) pick the file, other errors stay
errors. The keychain is preferred whenever it works: load reads it first, and
once it works again the file's session moves into it and the file goes;
`session_clear` clears both. `session_save` answers `"keychain"` or `"file"`,
and the app shows a one-time notice the first time it's the file. The stores
sit behind a `SecretStore` trait, so `cargo test` fakes the keychain. The CSP in
`tauri.conf.json` allows https/wss anywhere and http/ws on localhost. The
end-to-end tests (`apps/desktop/e2e/`, `run.ts` + W3C WebDriver helpers in
`driver.ts`) start a fresh seeded server (`scripts/dev.ts --port 0`), give the
app its own XDG dirs on Linux, sign in with a pasted token, send a message,
restart the app expecting it signed in, then sign out; CI sets
`CAMPFLARE_E2E_SESSION=file` so they also check the fallback file.

## Conventions

- **Naming:** our own identifiers, files and directories never contain "slack";
  use `campflare` or a neutral name (`CampflareError`, `x-campflare-req-id`,
  `src/api/`). The wire surface stays Slack's: method names, token prefixes
  (`xoxp-`/`xoxb-`/`xapp-`), JSON fields, error codes.
- **Adding a Slack method:** a handler in `src/methods/`, shapes in `shapes.ts`
  if new, events via `publish()` if Slack emits any, a server test in
  `apps/server/test/`, and a conformance case when an official SDK method covers it.
- **D1 round trips:** deployed, every awaited query is a network round trip, and
  they dominate latency. Put independent statements in one `DB.batch` (one trip,
  and atomic for writes) or `Promise.all`; `authenticate()` and
  `getConversation()`/`resolveConversation()` already bring the token's team,
  user and app, and the actor's membership. Pass id lists as one JSON argument,
  `IN (SELECT value FROM json_each(?))`: D1 binds at most 100 parameters.
  `pnpm --filter @campflare/bench bench` (`tests/bench/README.md`) shows
  queries, round trips and rows read per method; use `--compare` against
  `tests/bench/results/`.
- **Commits:** atomic and frequent, one topic each, with the tests for that change.
  Keep the coverage thresholds passing.
- Style is set by oxfmt: no semicolons, double quotes, width 120. Code,
  comments and commit messages are in English.
- **Languages in data and tests:** no single non-English language. When text in
  other languages is needed (seed data, search tests, examples), cover scripts
  evenly: CJK (Chinese, Japanese, Korean) and accented Latin (Spanish, French,
  German) at least.
- `compatibility_date` is 2026-08-15, the newest that the workerd in
  `@cloudflare/vitest-pool-workers` 0.22 supports; vitest stays on 4.x for the same reason.

## Running a Slack client against it

opentui-slack (`~/Projects/solcreek/opentui-slack`) reads `SLACK_API_URL`.
`pnpm otui` (`scripts/otui.sh`) launches it against the `dev:all` server with
its own config dir and daemon socket under `.wrangler/`. Its repo `.env` holds
real Slack tokens, which Bun auto-loads; exported environment variables win
over it, so the script exports the Campflare ones. A daemon started without
them keeps the wrong tokens: `pnpm otui daemon stop`.
`~/.local/bin/campflare` wraps the built CLI (`apps/cli/dist/index.mjs`).

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
                           # --app-url: where permalinks redirect (default: the --web app, else :5173)
pnpm otui                  # opentui-slack against the dev:all server (reads .wrangler/campflare-dev.env)
pnpm web                   # the app (apps/web) on :5173, signed in to the dev:all server as alex; ?as=vincent
pnpm shot '#/C123'         # screenshot of the dev:all --web app + console errors + accessible outline (--as, --dark, --state)
                           # a permalink (http://…/archives/C123/p…) works as a route too
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
  The Images binding too: `images.live.test.ts` starts its own `wrangler dev`
  with it remote (`startServer()` from `tests/conformance/global-setup.ts`).
  A test without its credentials is skipped with a note saying what to set
  (the verbose reporter prints it).
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
  `rtmOnly` client-state events (`*_marked`, ephemeral messages,
  `assistant_thread_status_changed`).
  WebSocket URLs carry a signed, single-use, 60-second ticket (`src/api/tickets.ts`)
  that the hub checks against its own SQLite storage.

The hub's SQLite also holds:

- `events`: every published event for a week, numbered (`seq`), with its
  audience. `campflare.events.poll` (`src/methods/events.ts` → `TeamHub.poll`)
  reads it from a cursor and long-polls by parking a waiter that `record()`
  wakes. RPC return values must be serialisable, so events cross as JSON strings.
- `unacked`: Socket Mode envelopes until their `envelope_id` is acked; the DO
  `alarm()` resends overdue ones (3 s, up to 3 retries) on the app's next link.
  Rows with `transport = 'http'` are Events API POSTs (keyed by `event_id`)
  that failed, with the `reason`; `alarm()` retries them too (below).
- `delivery_minutes` / `delivery_last` (`src/delivery-health.ts`): every Events
  API attempt (retries too; not `url_verification`, not interactivity) counted
  per app in one-minute buckets over a rolling hour, and the last attempt.

Apps get events through `callbacksFor()` in `hub.ts`: the `event_callback`, plus
`app_mention` (`src/app-events.ts`) when a new message mentions the app's bot
user in a conversation the bot is in (not edits, not the bot's own messages).
RTM and the event log never carry `app_mention`.

**Events API over HTTP.** An app with a Request URL (migration 0009:
`apps.signing_secret`, `event_request_url`, `event_types`) and no live Socket
Mode link gets each `event_callback` POSTed by the hub (`src/request-url.ts`),
signed `X-Slack-Signature: v0=HMAC-SHA256(secret, "v0:<ts>:<body>")` with
`X-Slack-Request-Timestamp`, 3 s timeout; a failure is retried after 1 s,
1 min, 5 min (`HTTP_RETRY_DELAYS_MS`) with `X-Slack-Retry-Num`/`-Reason`, and
`X-Slack-No-Retry: 1` stops it. The hub reads the workspace's subscribed apps
from D1 once per lifetime (`subscribersOf()`), so publishing costs no query;
`campflare.apps.setEventSubscriptions` (`src/methods/admin.ts`) verifies a URL
with `url_verification`, saves, and calls `hub.subscriptionsChanged()` to drop
that cache. `event_types` filters Socket Mode as well (`subscribed()`;
`message.channels`/`groups`/`im`/`mpim` by `channel_type`). Tests replace
outbound POSTs with `setRequestUrlFetch()`; `fakeRequestUrls()` and
`validSignature()` in `test/helpers.ts` record them and check signatures.

Failing URLs are turned off, as on Slack: when an attempt leaves more than 95%
of at least 20 attempts in the hour failed (`DISABLE_*` in
`delivery-health.ts`), `TeamHub.turnOff()` sets
`apps.event_delivery_disabled_at`/`_reason` (migration 0015; guarded on the
URL and on not being off yet, so concurrent trips report once), drops the
app's pending HTTP retries and resets its count, and `src/delivery-disabled.ts`
DMs the installer from the app's own bot with the reason and the command that
turns it back on. `subscribersOf()` treats a disabled URL as none; the URL
itself stays so `campflare.apps.info` can show it. Setting a Request URL again
(re-verified) or clearing it clears the flag and the count; changing only
`events` doesn't. The DM's origin is the one `setEventSubscriptions` last
passed to `subscriptionsChanged()` (kept in DO storage). `campflare.apps.info`
(and every `campflare.apps.*` setter) adds `event_subscriptions.disabled` and
`.delivery` (`TeamHub.deliveryHealth()`: last attempt, the hour's attempts and
failures, pending retries). `campflare.apps.rotateSigningSecret` replaces the
secret at once, with no grace window (Slack signs with one secret too; the app
must update), and drops the hub's cache so retries are signed with the new
one. Tests seed `delivery_minutes` with `runInDurableObject` rather than
making twenty failing posts.

**Streaming and app status.** `chat.startStream` / `appendStream` /
`stopStream` (`src/methods/chat-stream.ts`, bot tokens only) store a message
that grows: `text` is all its markdown so far, `blocks` holds it as `markdown`
blocks plus any streamed or closing blocks in order (consecutive markdown
extends the last markdown block), and `messages.stream_state` /
`stream_mode` (migration 0010) give `streaming_state` (`in_progress`,
`completed`) and the `markdown_text`-or-`chunks` mode Slack won't mix. Start
publishes a `message`, each change a `message_changed`. An append is one
batch after the conversation: a guarded UPDATE builds the blocks in SQL
(`json_set`/`json_insert`), and the row read before it in the same batch says
why it changed nothing (`message_not_owned_by_app`,
`message_not_in_streaming_state`, `streaming_mode_mismatch`, the limits).
`task_update`/`plan_update` chunks are checked and accepted but not shown.
Outside DMs, start wants `recipient_user_id`/`recipient_team_id`.
`assistant.threads.setStatus` (`src/methods/assistant.ts`) stores nothing: it
publishes the RTM-only `assistant_thread_status_changed` (`channel`,
`thread_ts`, `status`, `loading_messages`, the bot's `user`, `expires_in` 120) to the members; clients clear it on the bot's next message in the
thread, an empty status, or the timeout. A client that connects later
doesn't see a status already set.

**Files.** `files.getUploadURLExternal` reserves a row and returns a signed
`/upload/v1/:token` URL; bytes go to R2 at `<team>/<file>`;
`files.completeUploadExternal` shares them and posts the message. `url_private`
is served by `handleDownload` with the same Bearer tokens, with range support,
and `content-security-policy: sandbox`. `/files-pri/*` and `/upload/v1/*` answer
CORS (any origin, Authorization allowed, no credentials) so browser apps fetch
with the token; there are no signed download URLs. `/avatars/:id` draws the
user's initials (one query; a CJK name gives its first character).
Thumbnails (`src/api/thumbs.ts`): uploads record an image's `width`/`height`
(sent as `original_w`/`original_h`), and from those alone `fileJson` adds
Slack's `thumb_*` (no query): `thumb_64` (square crop), `thumb_80` (padded
square), `thumb_160`, and `thumb_360` always, `thumb_480`/`720`/`800`/`960`/`1024`
only below the original's longest side, each from 360 up with `_w`/`_h`. PNG,
JPEG, GIF and WebP only (not SVG). They're served at
`/files-tmb/<team>-<file>/<name>_<size>.<png|jpg|gif>` (`handleThumb`) with
`url_private`'s auth, CORS and CSP; the Images binding (`IMAGES`, optional:
without it no `thumb_*` are sent) makes each on its first fetch, and R2 keeps it
at `<team>/<file>/thumb_<size>`; `files.delete` removes them. JPEG stays JPEG,
the rest become PNG: no WebP or AVIF, since clients fetch `thumb_*` without an
`Accept` and older ones can't draw them. Animated images: the upload also records
`files.animated` (migration 0014, `isAnimated` in `src/api/media.ts`: a GIF with
more than one frame, not just a NETSCAPE loop extension; a WebP's VP8X animation
flag; NULL for GIFs from before, which count as animated). They add Slack's
`thumb_360_gif`, `thumb_480_gif` (beside `thumb_480`) and `deanimate_gif` (the
first frame, full size, PNG); the other sizes are stills, as on Slack. Images
writes the GIFs (`anim: true`; stills ask `anim: false`); a GIF that already
fits the box is served as its own `thumb_<n>_gif`, without Images. If Images fails
on a file, the original is served, uncached. Locally (wrangler dev, vitest)
Miniflare runs the binding with sharp, so tests make real thumbnails, except GIFs:
it can't write them, so locally `thumb_*_gif` is the original (`test/gif.ts`
encodes test GIFs). `setImagesOverride()` fakes a failing, GIF-writing or absent
binding; `tests/live/images.live.test.ts` runs the real one (wrangler's remote
binding; needs `CF_ACCOUNT_ID` and `IMAGES_API_TOKEN`). Not sent: `thumb_tiny`
(Slack's tiny base64 preview has no documented format), `thumb_pdf` and
`thumb_video` (Images can't render a PDF page or a video frame, and nothing else
in a Worker can). The app draws an inline image from the smallest thumb that covers
its box at `devicePixelRatio` (`imageSource` in core): from `thumb_*_gif` for an
animated image (the original when they're too small), the original in the viewer.

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
browser sign-ins, found through `account`), their MCP grants (Better Auth's
`oauthAccessToken` and `oauthRefreshToken` rows, in the same batch) and their
throttle counters. Consent (`oauthConsent`) stays, so a client the person trusts
signs in again without asking. JWT access tokens are stored nowhere, so `/mcp`
refuses one whose `iat` is at or before `passwords.updated` (whole seconds: a
token from the second of the change counts as before it). xoxp tokens stay,
including `oauth.v2.access` ones: those are app installs, revoked one by one.

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
through `account` to a Campflare user (`actorFor()`), refuses one issued
before that user's last password change (same query), and still accepts
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
app's session), never a pasted one: `campflare logout`, and a re-login over such a
profile, call `auth.revoke` (best effort, 5 s) before forgetting it. A re-login is the
same server and the same user and workspace (the old token's `auth.test` against the
new one's); a login over it to anywhere else keeps the old token live and says so,
with how to revoke it, in one line on stderr. The `/login` and
`/consent` pages' CSP adds the redirect URI's origin to `form-action`: browsers
check it on the redirects a POST answers with, so `'self'` alone blocks the return.

**Permalinks.** `chat.getPermalink` answers Slack's shape,
`<origin>/archives/<channel>/p<ts without dot>` (`?thread_ts=&cid=` for a reply;
`permalink()` in `shapes.ts`). The Worker doesn't serve the app, so
`/archives/:channel(/:ts)` (`src/permalinks.ts`) redirects (302) to `APP_URL`,
where the app is, at its hash route: `#/<channel>?msg=<ts>`, or
`#/<channel>/<thread>?msg=<ts>` for a reply; `/archives/<channel>` alone opens the
conversation. Nothing is looked up: a browser following a link carries no token,
so existence and access are the app's to find out (its not-found view). Without
`APP_URL` it answers a page naming the route; a malformed channel id is a 404.
`pnpm dev:all` passes `APP_URL` to wrangler (`--var`): the `--web` app, else
`APP_URL` from `.dev.vars`, else `http://localhost:5173/` (`pnpm web`), or
`--app-url`. Deployed, set it as a var or secret. The desktop app's link is the
permalink with its scheme changed, `campflare://<host>/archives/…`
(`desktopLink()`; see **Desktop**). The page without `APP_URL` links to it;
with `OFFER_DESKTOP_APP=true` the redirect becomes a page offering both (desktop
app, browser), opt-in because it costs everyone a click. Neither page launches
the app by itself (no script, no refresh): a scheme nobody registered would
only show the browser's error.

**Interactivity.** A click on a button in an app's message is
`campflare.blocks.action` (`src/methods/blocks.ts`; xoxp, members only): it
finds the element in the stored blocks (`actionOf()` in `src/interactivity.ts`;
`button`, or `feedback_buttons` with `value` naming the button) and sends the
app that posted the message `block_actions` in Slack's shape. Over Socket Mode
first: `TeamHub.interact()` sends an `interactive` envelope on one link and
waits up to 3 s for its ack, in memory, never kept or resent. Else a signed
form POST (`payload=<json>`, `postSigned()` with a content type) to
`apps.interactivity_request_url` (migration 0013,
`campflare.apps.setInteractivity`, not challenged). No retries: a miss is the
clicker's `app_unreachable`, as Slack shows an error. Stored blocks get a
`block_id`, and actions elements an `action_id`, when the poster gave none
(`withBlockIds()` in `methods/chat.ts`), as Slack fills them in. The
`response_url` is `/actions/<signed claims>` (team, channel, ts, thread, app,
clicker; `purpose` sets it apart from WebSocket tickets signed with the same
key), 30 minutes, 5 uses counted in the hub's `response_urls` table.
`handleResponseUrl()` acts as the app's bot through chat's own
`editMessage`/`deleteMessage`/`postMessage`/`sendEphemeral`:
`replace_original`, `delete_original`, `response_type: in_channel`, else
ephemeral to the clicker over RTM. `trigger_id` is generated, but there is no
`views.open`. In the app, `MessageBlocks` (`apps/web/src/components/message-blocks.tsx`)
renders what core's `interactiveBlocks()` finds and calls `workspace.click()`.

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
never HTML, and only links http(s) and mailto. `src/markdown.ts` parses
markdown (`markdown_text`, `markdown` blocks) into the same tree, plus
headings, lists and rules; the app shows a message's blocks instead of its
text when it has a markdown block (`message-body.tsx`). `state.statuses`
holds apps' thread statuses; `threadStatus()` drops expired ones, and the
thread view shows them (`thread-status.tsx`). `src/files.ts` decides image vs
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
auto-signed-in. The web sign-in keeps the page's hash with its pending state
and puts it back on return (the redirect URI is the bare root), so a permalink
opened signed out lands on its message. Routes (`route.ts`) carry `?msg=<ts>` for
a linked message: `ConversationView` pages older history until it's loaded (or
there's nothing older), `MessageList` scrolls it into view and `MessageItem`
marks it `aria-current` (tests find it by that); a reply's link highlights the
reply in `ThreadPanel` and its head in the conversation. An unknown conversation
renders `NotFoundView` (and loads nothing); a missing message, reply or thread
gets a notice. The composer ignores Enter while an IME
composes (`isComposing`, or keyCode 229 on Safari), which CJK input depends on.
Inline images (`message-files.tsx`) take their final box from
`original_w`/`original_h` before the bytes come, and fetch them only when they
near the viewport (`useInView`, IntersectionObserver; tests replace it with
`ViewportObserver` in `test/setup.ts`), from the best-fitting thumbnail
(`imageSource`), falling back to `url_private` if it fails; a click opens the
message's images, as originals, in a viewer dialog.

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
restart the app expecting it signed in, then sign out (`login.test.ts`); then
launch it with a `campflare://` link as its argument (tauri-driver's
`tauri:options.args`), to a message here and to another server, and start a
second instance with a link while it runs (`deep-link.test.ts`; skipped
without a D-Bus session bus, so CI runs them under `dbus-run-session`). CI sets
`CAMPFLARE_E2E_SESSION=file` so they also check the fallback file.

**Deep links.** The app opens `campflare://<host>[:<port>]/archives/<channel>[/p<ts>][?thread_ts=…&cid=…]`:
a permalink with its scheme changed (the server's `desktopLink()`), the host
naming the server. `tauri-plugin-deep-link` registers the scheme
(`plugins.deep-link` in `tauri.conf.json`; installers write it into Info.plist,
the registry and the `.desktop` file, an AppImage registers itself when run) and
hands links to the webview: the one the app started with (`getCurrent`, the
`deep-link:default` grant) and later ones (`onOpenUrl`, an event). Windows and
Linux start a new process per link, with the link as its only argument:
`tauri-plugin-single-instance` (feature `deep-link`; D-Bus on Linux, so without
a session bus a second launch just runs) passes it to the running app, which
comes to the front. The Rust side only forwards: `apps/web/src/deep-link.ts`
maps a link to the hash route (`parseDeepLink`) and `App` keeps it until signed
in, then opens it if the session's host is the link's, or shows a dialog naming
the other server with "Open in your browser" (the https permalink). macOS only
routes the scheme to a bundled `.app`, not `pnpm desktop`; on Linux and Windows a
debug build takes the link as its argument (`campflare-desktop campflare://…`).
https links (Universal Links on macOS, App URI handlers on Windows) are not
claimed: they need signed builds (#3), the domains fixed in the build (an
Associated Domains entitlement, `applinks:<host>`, with a provisioning profile; an
MSIX package on Windows), and each domain serving
`/.well-known/apple-app-site-association` or `windows-app-web-link` naming the
app. A self-hosted server's domain isn't known at build time, so only a hosted
service's domain could ever be claimed; the scheme works for every server.

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

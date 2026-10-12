# Campflare

A team chat server that speaks the Slack Web API, built on Cloudflare
Workers, D1, R2 and Durable Objects. API and CLI first; the app, for the web
and the desktop, is one more client of the same API.

Because the API matches Slack's, existing Slack clients, bots and SDKs work
against Campflare after a base-URL change. The official `@slack/web-api` and
`@slack/socket-mode` packages run unmodified in the conformance suite, and
[opentui-slack](../solcreek/opentui-slack)'s Slack client passes its own
calls against it (verified 2026-10-11).

```
apps/server         the Worker: Hono, D1 schema, TeamHub Durable Object
packages/client     @campflare/client: Web API, Socket Mode and RTM client (no deps)
apps/cli            the `campflare` command line
packages/core       @campflare/core: app state kept live over RTM, mrkdwn parsing
apps/web            the app: React, shadcn/ui on Base UI
apps/desktop        the app in a Tauri shell for macOS, Windows and Linux
tests/conformance   the official Slack SDKs against `wrangler dev`
```

## Quick start (local)

```sh
nix develop                              # optional: the pinned toolchain (Node 24, pnpm, bun, sqlite3, jq)
pnpm ready --fix                         # install, secrets, builds, local migrations: whatever's missing
pnpm dev:all                             # wrangler dev on :8787 and a seeded workspace
```

`pnpm dev:all` seeds a workspace on its first run (you are `@alex`; also
`vincent`, `minjun` and `ada`, with channels, a thread, a bot and a greeting in
seven languages in `#world`), and writes the tokens to
`apps/server/.wrangler/campflare-dev.env` on every run. `--port 0` picks a free
port and `--state <dir>` a separate state, so parallel worktrees each run their
own stack; `--fresh` starts over and `--no-seed` leaves the server empty.

```sh
pnpm otui                                       # opentui-slack against it (from ~/Projects/solcreek/opentui-slack)
set -a; . apps/server/.wrangler/campflare-dev.env; set +a
node apps/cli/dist/index.mjs send '#dev' "hello"  # the CLI, as @alex
```

The app runs against the same server and signs in by itself in development
(`?as=vincent` in the URL to be someone else):

```sh
pnpm web                                        # http://localhost:5173
pnpm dev:all --port 0 --web                     # or server and app together, on free ports
pnpm shot '#/<channel id>'                      # screenshot of that app, its console errors and outline
pnpm desktop                                    # the same app in a desktop window (needs Rust)
pnpm --filter @campflare/desktop bundle         # installers for this platform
pnpm e2e                                        # browser tests against a fresh stack of their own
```

`wrangler dev` runs everything locally in workerd: D1 is SQLite (with FTS5),
R2 is files on disk, and Durable Objects and their WebSockets behave as they do
in production. State lives in `.wrangler/state`.

## Deploy

```sh
cd apps/server
wrangler d1 create campflare             # put the id in wrangler.jsonc
wrangler r2 bucket create campflare-files
wrangler secret put SIGNING_KEY          # any long random string
wrangler secret put BOOTSTRAP_SECRET     # lets campflare.bootstrap create workspaces
pnpm db:migrate:remote
pnpm deploy
```

Delete `BOOTSTRAP_SECRET` once your workspaces exist, to close sign-up.

## Using it from Slack clients

Point the client's API base at `https://<your-host>/api/`:

```ts
import { WebClient } from "@slack/web-api"
import { SocketModeClient } from "@slack/socket-mode"

const web = new WebClient(token, { slackApiUrl: "https://chat.example.com/api/" })
const socket = new SocketModeClient({ appToken, clientOptions: { slackApiUrl: "https://chat.example.com/api/" } })
```

Tokens keep Slack's prefixes, so clients that check them keep working:
`xoxp-` (a person), `xoxb-` (an app's bot), `xapp-` (an app, for Socket Mode).
Get them with `campflare bootstrap`, `campflare admin add-user`,
`campflare admin add-app` and `campflare token create`.

## The API

`https://<host>/api/<method>`, by GET or POST (query string, form,
multipart or JSON), with `Authorization: Bearer <token>` or a `token`
argument. Answers are HTTP 200 with `{ "ok": true, … }` or
`{ "ok": false, "error": "<code>" }`, using Slack's error codes. Lists page with
`cursor` and `response_metadata.next_cursor`.

| Area                  | Methods                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth                  | `api.test`, `auth.test`, `auth.revoke`                                                                                                                                                                   |
| conversations         | `list`, `info`, `history`, `replies`, `create`, `join`, `leave`, `invite`, `kick`, `members`, `open`, `close`, `mark`, `rename`, `setTopic`, `setPurpose`, `archive`, `unarchive`; `users.conversations` |
| chat                  | `postMessage`, `update`, `delete`, `getPermalink`, `meMessage`, `postEphemeral`                                                                                                                          |
| reactions             | `add`, `remove`, `get`                                                                                                                                                                                   |
| files                 | `getUploadURLExternal`, `completeUploadExternal`, `info`, `list`, `delete`; `url_private` downloads with range support                                                                                   |
| search                | `search.messages`: words, `"phrases"`, `-exclusions`, `in:`, `from:`, `before:`, `after:`, `on:`, `during:`, `has:link/reaction/file`, `is:thread/dm`                                                    |
| users                 | `info`, `list`, `lookupByEmail`, `getPresence`, `setPresence`, `profile.get`, `profile.set`                                                                                                              |
| dnd                   | `info`, `teamInfo`, `setSnooze`, `endSnooze`, `endDnd`                                                                                                                                                   |
| realtime              | `apps.connections.open` (Socket Mode), `rtm.connect`                                                                                                                                                     |
| other                 | `team.info`, `emoji.list`, `bots.info`, `apps.list`                                                                                                                                                      |
| admin (`campflare.*`) | `bootstrap`, `users.create`, `users.deactivate`, `tokens.create`, `tokens.list`, `tokens.revoke`, `apps.create`                                                                                          |

The `campflare.*` methods cover what Slack does in its admin UI and OAuth
flow. They're named so they can't collide with Slack's.

Search uses an FTS5 trigram index that ignores case and diacritics. It matches
substrings in any script: words in Chinese, Japanese and Korean, which aren't
separated by spaces, as well as `cafe` for `Café` and `munchen` for `München`.
Terms shorter than three characters fall back to a LIKE scan.

## Realtime

Each workspace has one `TeamHub` Durable Object that holds its WebSockets,
using the hibernation API, so idle connections cost nothing. After a write, the
Worker calls the hub over RPC (after the response, via `waitUntil`), and the
hub sends the event to the connections whose user can see the conversation.

- **Socket Mode** (`apps.connections.open`, `xapp-`): Slack's `events_api`
  envelopes, acknowledged by `envelope_id`. As in Slack, an app with several
  connections gets each event on one of them, not all. An app sees what its
  installer or its bot user can see.
- **RTM** (`rtm.connect`, `xoxp-`/`xoxb-`): the event objects themselves,
  plus client-state events such as `channel_marked`. This is the stream for a
  Campflare UI. A live RTM link counts as active presence.

Measured on local `wrangler dev`: post → Socket Mode event, p50 6.6 ms, p95
9.5 ms (20 round trips, 2026-10-11; the conformance suite prints this on every
run). WebSocket URLs carry a signed, 60-second, single-use ticket.

An envelope that isn't acknowledged within 3 seconds is sent again, up to
three times, on the app's next link, with `retry_attempt` counting up and
`retry_reason: "timeout"`; its `event_id` stays the same.

### The event log

The hub also keeps every event for a week, numbered in order.
`campflare.events.poll` returns the events the token's user can see after a
`cursor`, long-polling up to `wait` seconds (at most 30) when there are none
yet. Without a cursor it answers the current one, to start from. A cursor whose
next event has been dropped answers `cursor_expired`, so a client knows it
missed something. This is live events for clients that can't hold a WebSocket
open: agents, scripts, scheduled jobs. `follow()` in `@campflare/client` and
`campflare events --follow` wrap it.

## MCP

`https://<host>/mcp` is a remote MCP server (Streamable HTTP), built on the
official TypeScript SDK v2. It implements the 2026-07-28 specification
(`server/discover`, no handshake) and still serves 2025-era clients through the
SDK's stateless fallback. Agents use it to work in the workspace as a person
or a bot:

| Tool                                          | What it does                                                 |
| --------------------------------------------- | ------------------------------------------------------------ |
| `read_messages`, `read_thread`                | a conversation's recent messages, or a whole thread          |
| `search_messages`                             | search, with the same syntax as `search.messages`            |
| `send_message`, `add_reaction`                | post (or reply in a thread), react                           |
| `list_conversations`, `list_people`, `whoami` | where you are and who's here                                 |
| `get_events`                                  | the event log since a cursor, long-polling                   |
| `wait_for_reply`                              | block until someone else answers in a conversation or thread |

Conversations are named as people name them: `#channel`, `@handle` (your DM)
or an id. Tools run the same handlers as the Web API, so permissions, events
and error codes are the same; errors come back as tool errors the model can
read.

### Signing in

MCP clients sign in with OAuth 2.1, as the specification asks. Better Auth, at
`/auth`, is the authorization server:

1. An unauthenticated call to `/mcp` answers `401` with
   `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
2. That document names the authorization server; its metadata is at
   `/.well-known/oauth-authorization-server/auth`.
3. The client identifies itself with a Client ID Metadata Document (an HTTPS
   URL as its `client_id`), the MCP 2026-07-28 way; dynamic client
   registration is off. PKCE (S256) is required.
4. The person signs in on `/login` and approves on `/consent`. Until there's
   a UI with passwords or passkeys, signing in takes a Campflare user token
   (`campflare token create`), which also says which workspace and person the
   client acts as.
5. The client gets a JWT access token bound to `/mcp` (and a refresh token
   with `offline_access`).

Agents configured by hand can skip OAuth and send a user or bot token:

```sh
claude mcp add --transport http campflare http://localhost:8787/mcp \
  --header "Authorization: Bearer $CAMPFLARE_TOKEN"
```

Client metadata documents are fetched over an SSRF-guarded transport: https
DNS names only, every DNS answer public (RFC 6890), no redirects. A Worker
can't pin the address it checked, so the gap between that lookup and the fetch
relies on Workers not reaching private networks; under local `wrangler dev`
that guarantee doesn't hold.

## CLI

```sh
campflare login --url https://chat.example.com --token xoxp-…   # or any Slack-compatible server
campflare send '#dev' "build is green"
campflare send @vincent "have a look" -f screenshot.png
make test 2>&1 | tail -5 | campflare send @me                  # text from stdin
campflare history '#dev' -n 50
campflare search 'deploy in:#dev from:@bob after:2026-10-01'
campflare listen --json                                       # RTM; --socket for Socket Mode
campflare events --cursor 120 --follow                        # the event log, resumable
campflare api conversations.list limit=5                      # any method, raw JSON
```

Profiles are kept in `~/.config/campflare/config.json` (mode 0600).
`CAMPFLARE_URL`, `CAMPFLARE_TOKEN` and `CAMPFLARE_APP_TOKEN` override them.
Exit codes: 0 ok, 1 API error, 2 usage error. Run `campflare help` for the full
list.

## Development

```sh
pnpm ready        # is this checkout ready? --fix repairs it; --json for scripts and agents
pnpm check        # oxfmt --check, oxlint, tsc, and every test suite with coverage
pnpm test         # just the tests
nix develop -c pnpm check                # the same, on the pinned toolchain, on any machine with Nix
```

The toolchain comes from `flake.nix`: Node at the major in `.node-version`,
pnpm, bun (for `pnpm otui`), sqlite3 (to look inside local D1 state) and jq.
wrangler and workerd are not in it: they come from the pnpm lockfile, whose
versions must match `@cloudflare/vitest-pool-workers`.

Claude Code sessions get the same setup without asking (`.claude/settings.json`):
the flake's toolchain on every command's PATH, a note at session start if
`pnpm ready` finds something wrong, each edited file formatted and linted on
the spot (lint errors go back to the agent), and format, lint and typecheck
(about 2 s) required to pass before the agent stops whenever code changed.

- `apps/server`: vitest inside workerd (`@cloudflare/vitest-pool-workers`), against
  real local D1, R2 and Durable Objects. Coverage thresholds: 95% lines,
  statements and functions; 85% branches.
- `packages/client`: unit tests with a fake fetch and a fake WebSocket.
- `apps/cli` and `tests/conformance`: start a real `wrangler dev` with fresh
  state, then run CLI commands and the official Slack SDKs against it.

Tooling: TypeScript 7, Hono, oxlint, oxfmt, and tsdown (on rolldown) for the
client and CLI bundles. The Worker is bundled by wrangler.

## Not yet

- OAuth v2 (`oauth.v2.access`) for Slack apps, and per-scope enforcement
  (tokens carry scopes, but no method checks them yet).
- Signing in with a password, passkey or email link, and choosing a workspace
  when one person is in several.
- Events API over HTTP (request URLs); Socket Mode and RTM only so far.
- Periodic Socket Mode `disconnect` refreshes.
- Rate limiting (HTTP 429 with `Retry-After`).
- Pins, bookmarks, stars, reminders, scheduled messages, user groups, custom
  emoji, scheduled DND hours, time zones.
- Sharding a very large workspace's hub across several Durable Objects.

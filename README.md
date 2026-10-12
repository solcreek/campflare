# Campflare

A team chat server that speaks the Slack Web API, built on Cloudflare
Workers, D1, R2 and Durable Objects. API and CLI first; the UI comes later.

Because the API matches Slack's, existing Slack clients, bots and SDKs work
against Campflare after a base-URL change. The official `@slack/web-api` and
`@slack/socket-mode` packages run unmodified in the conformance suite, and
[opentui-slack](../solcreek/opentui-slack)'s Slack client passes its own
calls against it (verified 2026-10-11).

```
apps/server         the Worker: Hono, D1 schema, TeamHub Durable Object
packages/client     @campflare/client: Web API, Socket Mode and RTM client (no deps)
apps/cli            the `campflare` command line
tests/conformance   the official Slack SDKs against `wrangler dev`
```

## Quick start (local)

```sh
pnpm install
cd apps/server
cp .dev.vars.example .dev.vars           # SIGNING_KEY, BOOTSTRAP_SECRET
pnpm db:migrate:local
pnpm dev                                 # http://localhost:8787

# In another terminal: create a workspace and log the CLI in to it.
cd apps/cli && pnpm build
node dist/index.mjs bootstrap --url http://localhost:8787 --secret dev-bootstrap \
  --team "Acme" --user alice
node dist/index.mjs send '#general' "hello"
node dist/index.mjs listen               # live events, in another terminal
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

## CLI

```sh
campflare login --url https://chat.example.com --token xoxp-…   # or any Slack-compatible server
campflare send '#dev' "build is green"
campflare send @vincent "have a look" -f screenshot.png
make test 2>&1 | tail -5 | campflare send @me                  # text from stdin
campflare history '#dev' -n 50
campflare search 'deploy in:#dev from:@bob after:2026-10-01'
campflare listen --json                                       # RTM; --socket for Socket Mode
campflare api conversations.list limit=5                      # any method, raw JSON
```

Profiles are kept in `~/.config/campflare/config.json` (mode 0600).
`CAMPFLARE_URL`, `CAMPFLARE_TOKEN` and `CAMPFLARE_APP_TOKEN` override them.
Exit codes: 0 ok, 1 API error, 2 usage error. Run `campflare help` for the full
list.

## Development

```sh
pnpm check        # oxfmt --check, oxlint, tsc, and every test suite with coverage
pnpm test         # just the tests
```

- `apps/server`: vitest inside workerd (`@cloudflare/vitest-pool-workers`), against
  real local D1, R2 and Durable Objects. Coverage thresholds: 95% lines,
  statements and functions; 85% branches.
- `packages/client`: unit tests with a fake fetch and a fake WebSocket.
- `apps/cli` and `tests/conformance`: start a real `wrangler dev` with fresh
  state, then run CLI commands and the official Slack SDKs against it.

Tooling: TypeScript 7, Hono, oxlint, oxfmt, and tsdown (on rolldown) for the
client and CLI bundles. The Worker is bundled by wrangler.

## Not yet

- OAuth v2 (`oauth.v2.access`) and per-scope enforcement (tokens carry scopes,
  but no method checks them yet).
- Events API over HTTP (request URLs); Socket Mode and RTM only so far.
- Redelivery of unacknowledged Socket Mode envelopes, and periodic `disconnect` refreshes.
- Rate limiting (HTTP 429 with `Retry-After`).
- Pins, bookmarks, stars, reminders, scheduled messages, user groups, custom
  emoji, scheduled DND hours, time zones.
- Sharding a very large workspace's hub across several Durable Objects.

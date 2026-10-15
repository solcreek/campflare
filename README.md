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
CAMPFLARE_TOKEN=$CAMPFLARE_BOT_TOKEN node apps/cli/dist/index.mjs send '#dev' "beep"  # as the seeded app's bot
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

The Worker doesn't serve the app (`apps/web`); host its build anywhere
(`CAMPFLARE_WEB_ORIGIN=https://app.example.com pnpm --filter @campflare/web build`)
and tell the Worker where it is, so the permalinks `chat.getPermalink` hands out
(`/archives/<channel>/p<ts>`) open the message there:

```sh
wrangler secret put APP_URL              # e.g. https://app.example.com/ (a plain var works too)
```

Without it, a permalink answers a page naming the app route to open, with a
link that opens the desktop app. With `OFFER_DESKTOP_APP=true`, a permalink
answers a page offering both, the desktop app and the browser, instead of the
redirect; nothing opens until the person picks one.

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

| Area                  | Methods                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| auth                  | `api.test`, `auth.test`, `auth.revoke`                                                                                                                                                                                                           |
| conversations         | `list`, `info`, `history`, `replies`, `create`, `join`, `leave`, `invite`, `kick`, `members`, `open`, `close`, `mark`, `rename`, `setTopic`, `setPurpose`, `archive`, `unarchive`; `users.conversations`                                         |
| chat                  | `postMessage`, `update`, `delete`, `getPermalink`, `meMessage`, `postEphemeral`                                                                                                                                                                  |
| streaming             | `chat.startStream`, `appendStream`, `stopStream` (markdown, blocks, `task_update`/`plan_update` as `task_card`/`plan` blocks); a person stops one with `campflare.chat.stopStream`; `assistant.threads.setStatus`                                |
| reactions             | `add`, `remove`, `get`                                                                                                                                                                                                                           |
| files                 | `getUploadURLExternal`, `completeUploadExternal`, `info`, `list`, `delete`; `url_private` downloads with range support                                                                                                                           |
| search                | `search.messages`: words, `"phrases"`, `-exclusions`, `in:`, `from:`, `before:`, `after:`, `on:`, `during:`, `has:link/reaction/file`, `is:thread/dm`                                                                                            |
| users                 | `info`, `list`, `lookupByEmail`, `getPresence`, `setPresence`, `profile.get`, `profile.set` (with `status_expiration`), `setPhoto`, `deletePhoto`; `user_change` on every change                                                                 |
| usergroups            | `create`, `list`, `update`, `disable`, `enable`, `users.list`, `users.update`; `subteam_*` events; mentioned as `<!subteam^S…\|@handle>`                                                                                                         |
| dnd                   | `info`, `teamInfo`, `setSnooze`, `endSnooze`, `endDnd`                                                                                                                                                                                           |
| realtime              | `apps.connections.open` (Socket Mode), `rtm.connect`; the Events API over HTTP (signed `event_callback` POSTs to a Request URL)                                                                                                                  |
| interactivity         | `block_actions` for buttons, icon buttons, feedback buttons, select and overflow menus (ephemeral messages' too), over Socket Mode or signed to an Interactivity Request URL; `response_url`; clicks by `campflare.blocks.action`                |
| views (modals)        | `views.open`, `views.push`, `views.update` with the `trigger_id` of an interaction; `view_submission` (with `response_action`) and `view_closed`; the person's side: `campflare.views.list`, `submit`, `close`                                   |
| other                 | `team.info`, `emoji.list`, `bots.info`, `apps.list`                                                                                                                                                                                              |
| admin (`campflare.*`) | `bootstrap`, `methods.list`, `users.create`, `users.deactivate`, `users.setRole`, `tokens.create`, `tokens.list`, `tokens.revoke`, `apps.create`, `apps.info`, `apps.setEventSubscriptions`, `apps.setInteractivity`, `apps.rotateSigningSecret` |

The `campflare.*` methods cover what Slack does in its admin UI and OAuth
flow. They're named so they can't collide with Slack's.

### Scopes, roles and tokens for agents

A token can do only what its scopes allow, checked as Slack checks them:
`chat.postMessage` wants `chat:write`, `conversations.history` on a private
channel wants `groups:history`, and a call without one answers
`{ "ok": false, "error": "missing_scope", "needed": …, "provided": … }`.
`campflare.methods.list` (no token needed) says what each method takes. A
person's own sign-in holds every scope; for an agent, mint a narrower one that
expires:

```sh
campflare token create --preset read --scopes chat:write --expires 8h --label triage-bot
```

Presets are `read`, `write` (read, post, react, upload) and `full`. A token
never gets a scope the token minting it lacks. Roles are Slack's: owners
manage roles (`campflare.users.setRole`), admins manage members, and acting on
someone takes a role above theirs. See
[docs/scopes-and-roles.md](docs/scopes-and-roles.md).

Search uses an FTS5 trigram index that ignores case and diacritics. It matches
substrings in any script: words in Chinese, Japanese and Korean, which aren't
separated by spaces, as well as `cafe` for `Café` and `munchen` for `München`.
Terms shorter than three characters fall back to a LIKE scan.

### Profiles and user groups

`users.setPhoto` takes a PNG, JPEG, WebP or still GIF (optionally cropped
with `crop_x`, `crop_y`, `crop_w`); `image_24` … `image_1024` are squares
made from it by the Images binding (the original without it), at URLs that
change with every photo, so clients refetch. Like the drawn initials people
have without a photo, they need no token. A status past its
`status_expiration` reads as none. User groups are Slack's: a `@handle` (in
one namespace with people's names), members and default channels; anyone in
the workspace may manage them, as on Slack by default, with a token holding
`usergroups:write` (not in the `write` preset).

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

Apps also get `app_mention` alongside `message` when a new message (a post,
a thread reply, a file share; not an edit, not the bot's own) mentions their
bot user in a conversation the bot is in.

### The Events API over HTTP

An app without a live Socket Mode link can have its events POSTed instead, as
Slack's Events API does, so apps built for Request URLs (Bolt's HTTP receiver,
frameworks without a Socket Mode client) work unchanged:

```sh
campflare admin add-app "Helper"     # prints the app's signing secret too
campflare admin app A0123 --request-url https://helper.example/slack/events --events app_mention,message.channels
```

`campflare.apps.setEventSubscriptions` (`app`, `request_url`, `events`) sends
Slack's `url_verification` challenge first and saves the URL only if it is
echoed; an empty `request_url` stops HTTP delivery. `events` limits what the
app receives (over Socket Mode too): event types, with `message.channels`,
`message.groups`, `message.im` and `message.mpim` for messages by kind of
conversation; empty means every event the app can see. `campflare.apps.info`
shows the settings and the signing secret. Request URLs are https, or http on
`localhost` for an app in development.

Each event is an `event_callback` (`event_id`, `event_time`, `team_id`,
`api_app_id`, `authorizations`) signed as Slack signs it: `X-Slack-Signature:
v0=` HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret, with
`X-Slack-Request-Timestamp`. Anything but a 2xx within 3 seconds is retried
after 1 s, 1 min and 5 min, with `X-Slack-Retry-Num` and
`X-Slack-Retry-Reason` (`http_error`, `http_timeout`, `connection_failed`);
an answer with `X-Slack-No-Retry: 1` stops them. An app with a live Socket
Mode link gets its events there instead, as on Slack.

A Request URL that keeps failing is turned off, as Slack does: once more than
95% of the attempts in the last 60 minutes failed (retries count; at least 20
attempts, so a quiet app isn't turned off by a blip), Campflare stops sending
and retrying, records when and why, and the app's bot DMs its installer.
Setting the Request URL again (it is checked with `url_verification` again)
turns delivery back on; clearing it does too. Interactivity POSTs don't count.

`campflare.apps.info` reports how delivery is going, for people and agents
alike: `event_subscriptions.delivery` has the last attempt (`at`, `ok`,
`status`, `reason`), the hour's `attempts` and `failures`, and the events
`pending` a retry; `event_subscriptions.disabled` is `{at, reason}` while
delivery is off. `campflare admin app A0123` prints the same.

To replace a signing secret (`campflare.apps.rotateSigningSecret`, by the
installer or an admin):

```sh
campflare admin app A0123 --rotate-secret
```

The new secret signs everything from then on, retries of earlier events and
clicks included. There is no window where both secrets sign, so update the
app's secret right away; until then it rejects every request.

### Interactivity

Buttons and menus in an app's messages work as on Slack. A person clicks an
`actions` block's `button` or `icon_button`, a `context_actions` block's
`feedback_buttons` (👍/👎), or chooses in a `static_select`, `users_select`,
`conversations_select`, `channels_select` or `overflow` menu (in an actions
block, or a section's accessory), in the app or with
`campflare click <#channel> <ts> [action_id]` (without an action_id it lists
what's clickable and how: `--option <value>`, `--user <@person>`,
`--conversation <#channel>`). Under both is `campflare.blocks.action`
(`channel`, `ts`, `action_id`, `block_id`, and `value`: a feedback button's,
an option's, or the id chosen), Campflare's own method, since Slack's clients
use an internal one. As on Slack, anyone who can read the conversation can
click, public channels included. The action is described from the stored
blocks (`selected_option`, `selected_user`, `selected_conversation`,
`selected_channel`), and a select's choice is in `state.values` too. An app's
ephemeral messages with blocks are kept by the server for a day, so their
buttons click: the payload says `is_ephemeral`, and its `response_url`
replaces or deletes the message for the clicker alone.

The app whose bot posted the message gets `block_actions` in Slack's shape
(`user`, `team`, `channel`, `container`, `message`, `actions[]`,
`response_url`, `trigger_id`): an `interactive` envelope over Socket Mode when
it has a link, else a signed form POST (`payload=<json>`) to its
Interactivity Request URL:

```sh
campflare admin app A0123 --interactivity-url https://helper.example/slack/events
```

(`campflare.apps.setInteractivity`, `app`, `request_url`; not challenged, as
on Slack). Clicks aren't retried: an app that doesn't ack, or answer 2xx,
within 3 seconds gives the clicker `app_unreachable`. The `response_url` takes
the app's answer for 30 minutes, 5 times: `replace_original`,
`delete_original`, `response_type: "in_channel"`, or by default a message only
the clicker sees (ephemeral). Posted as the app's bot, in the clicked message's
thread unless `thread_ts` says otherwise. A replacement isn't marked
"(edited)", as on Slack.

### Modals

The `trigger_id` of a click (or of a submission) opens a modal for the person
who clicked: `views.open` with the app's bot token, once, within 3 seconds
(`expired_trigger_id`, `exchanged_trigger_id`). `views.push` stacks another on
it (3 at most), and `views.update` changes one by `view_id` or `external_id`,
with `hash` to guard against a newer change (`hash_conflict`). Inputs:
`plain_text_input`, `email_text_input`, `url_text_input`, `number_input`,
`static_select`, `users_select`, `conversations_select`, `channels_select`
(and their multi-selects), `checkboxes`, `radio_buttons`, `datepicker`,
`timepicker`. The app shows the top view as a dialog. With the CLI:

```sh
campflare view list                       # your open views, their inputs, how to fill each
campflare view submit V0123 --value note.text="Ship it" --value env.pick=prod --value who.pick=@vincent
campflare view close V0123
```

Under them are `campflare.views.list`, `campflare.views.submit` (`view_id`,
`values`: `{ block_id: { action_id: value } }`, an input left out keeping its
initial value) and `campflare.views.close`. A submission with required inputs
left empty answers `errors` without bothering the app, as Slack's client does.
Else the app gets `view_submission` with the view's `state.values` in Slack's
shape, and its answer (the Socket Mode ack's payload, or the Request URL's JSON
body) decides: `response_action` `errors` (shown under the inputs), `update`,
`push`, `clear`, or nothing, which closes the view. Closing one sends
`view_closed` when it has `notify_on_close`. A click in a modal is
`block_actions` with `container.type: "view"` and the view's state so far.

### The event log

The hub also keeps every event for a week, numbered in order.
`campflare.events.poll` returns the events the token's user can see after a
`cursor`, long-polling up to `wait` seconds (at most 30) when there are none
yet. Without a cursor it answers the current one, to start from. A cursor whose
next event has been dropped answers `cursor_expired`, so a client knows it
missed something. This is live events for clients that can't hold a WebSocket
open: agents, scripts, scheduled jobs. `follow()` in `@campflare/client` and
`campflare events --follow` wrap it.

## Huddles

A conversation can have a call: audio, video for several people (simulcast,
with the layer chosen per viewer), and optionally a live transcript with a
summary at the end, posted in a thread by a Huddle Scribe bot. Media goes
through Cloudflare's Realtime SFU; signalling is `campflare.huddles.*` (`join`,
`subscribe`, `answer`, `layer`, `publish`, `unpublish`, `leave`, `info`, `ice_servers`,
`transcribe`) and RTM events (`huddle_joined`, `huddle_left`, `huddle_tracks`, `huddle_transcription`).
Speech is transcribed by Whisper and summarised by Llama 3.3 on Workers AI.

Huddles are off until the Worker has a Realtime SFU app (`REALTIME_*`;
transcription also needs `CF_ACCOUNT_ID` and `WORKERS_AI_TOKEN`); see
`apps/server/.dev.vars.example`. There's no UI yet: `/huddle` is a test page.
How it works, how it's tested and what it measured: [docs/huddles.md](docs/huddles.md).

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
| `list_groups`                                 | user groups, their members, and how to mention each          |
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
campflare login --url https://chat.example.com --oauth          # Campflare: sign in in the browser
campflare send '#dev' "build is green"
campflare send @vincent "have a look" -f screenshot.png
make test 2>&1 | tail -5 | campflare send @me                  # text from stdin
campflare history '#dev' -n 50
campflare search 'deploy in:#dev from:@bob after:2026-10-01'
llm "summarise" | CAMPFLARE_TOKEN=xoxb-… campflare stream '#dev' --thread 1791990000.000100 --status "is thinking…"
                                                              # as a bot: one message that grows as stdin arrives
campflare stop '#dev' 1791990000.000200                       # as a person: stop an app's reply mid-stream
campflare listen --json                                       # RTM; --socket for Socket Mode
campflare events --cursor 120 --follow                        # the event log, resumable
campflare api conversations.list limit=5                      # any method, raw JSON
campflare profile --status 'En réunion' --emoji :calendar: --until 1h --photo me.png
campflare group create oncall --name 'On call' --members @ana,@kenji   # then mention @oncall
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

CI (GitHub Actions) runs `pnpm check` and `pnpm e2e` on every push and pull
request; the desktop installers and the desktop end-to-end tests run by hand
or on a `v*` tag (`.github/workflows/desktop.yml`).

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

- Guests (multi- and single-channel), and filtering the live event feeds by a
  token's scopes ([docs/scopes-and-roles.md](docs/scopes-and-roles.md)).
- Signing in with a password, passkey or email link, and choosing a workspace
  when one person is in several.
- Periodic Socket Mode `disconnect` refreshes.
- Rate limiting (HTTP 429 with `Retry-After`).
- Pins, bookmarks, stars, reminders, scheduled messages, custom
  emoji, an admin setting restricting who may manage user groups, scheduled DND hours, time zones.
- A `user_change` when a status expires (it reads as cleared at once, but
  clients holding the profile learn only on their next read).
- Sharding a very large workspace's hub across several Durable Objects.
- Huddles: expiring the seat of a browser that died without leaving, and
  Slack's `calls.*` API (see [docs/huddles.md](docs/huddles.md)).

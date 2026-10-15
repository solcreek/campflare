# Scopes and roles

Status: implemented, 2026-10-15 (the `scopes-and-roles` branch).

Campflare is meant to be driven by agents as much as by people. An agent should
get a token that can do exactly what its job needs, and a person should be able
to hand one out without handing over their account. Today every token carries a
list of scopes, but nothing checks them: an `xoxp` is the whole person. This
document makes scopes binding and pins down what each role may do.

Two independent checks decide every call:

- **Scopes** say what a _token_ may do. They are fixed when the token is minted.
- **Roles** say what a _person_ may do. They are read with the token on every
  request (`authenticate()` already loads the user), so a demotion takes effect
  at once, on every token the person holds.

A call succeeds only if both allow it. An admin's read-only token can't
deactivate anyone; a member's full token can't either.

## Scopes

### Declared per method, in one table

`src/api/scopes.ts` maps every method name to what it needs. A unit test fails
if a registered method has no entry, so a new method can't ship unguarded. The
same table answers `campflare.methods.list` (below), so agents can discover what
a token needs before calling.

An entry is one of:

- `[]`: no scope (`api.test`, `auth.test`, `chat.getPermalink`, `views.open`…,
  as on Slack).
- `["a", "b"]`: any one of these.
- `{ conversation: "read" | "history" | "write" }`: a conversation method. Up
  front the token needs that verb for at least one conversation type; then, once
  the conversation is fetched, it needs the scope for _that_ conversation's
  type: `channels:` for a public channel, `groups:` for a private one, `im:`,
  `mpim:`. This is what Slack does (`conversations.history` on a private channel
  with only `channels:history` answers `missing_scope`, `needed: groups:history`).
  `channels:manage` counts as `channels:write`, and `channels:join` as
  `channels:write` for `conversations.join`, as Slack's newer scopes do.

The per-type check runs where every conversation is fetched
(`findWithMembership()` in `src/db/conversations.ts`), and only for a
conversation the caller can see: a private conversation they aren't in still
answers `channel_not_found`, so a missing scope never reveals that it exists.
`conversations.list` and `users.conversations` want the `:read` scope of each
type asked for (`types`, by default `public_channel`), as Slack does:
`types=public_channel,im` without `im:read` is `missing_scope`.

### The error

As Slack answers it, so the official SDKs surface it unchanged:

```json
{ "ok": false, "error": "missing_scope", "needed": "groups:history", "provided": "channels:history,chat:write" }
```

Every answer to an authenticated call carries `x-oauth-scopes` (the token's)
and, when the method asks for any, `x-accepted-oauth-scopes`. The official
`@slack/web-api` reads both into `response_metadata.scopes` and
`.acceptedScopes`.

### Slack's scopes, as Slack documents them

| methods                                                                                                                                           | scope                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `conversations.info`, `.list`, `.members`, `users.conversations`                                                                                  | `*:read` per type                            |
| `conversations.history`, `.replies`                                                                                                               | `*:history` per type                         |
| `conversations.create`, `.archive`, `.unarchive`, `.rename`, `.setTopic`, `.setPurpose`, `.invite`, `.kick`, `.leave`, `.mark`, `.open`, `.close` | `*:write` per type                           |
| `conversations.join`                                                                                                                              | `channels:join` or `channels:write`          |
| `chat.postMessage`, `.update`, `.delete`, `.meMessage`, `.postEphemeral`, `.startStream`, `.appendStream`, `.stopStream`                          | `chat:write`                                 |
| `reactions.add`, `.remove` / `reactions.get`                                                                                                      | `reactions:write` / `reactions:read`         |
| `files.getUploadURLExternal`, `.completeUploadExternal`, `.delete` / `files.info`, `.list`                                                        | `files:write` / `files:read`                 |
| `search.messages`                                                                                                                                 | `search:read`                                |
| `users.info`, `.list`, `.getPresence`, `bots.info`                                                                                                | `users:read`                                 |
| `users.lookupByEmail`                                                                                                                             | `users:read.email`                           |
| `users.setPresence`                                                                                                                               | `users:write`                                |
| `users.profile.get` / `.set`, `users.setPhoto`, `.deletePhoto`                                                                                    | `users.profile:read` / `users.profile:write` |
| `usergroups.list`, `.users.list` / `usergroups.create`, `.update`, `.disable`, `.enable`, `.users.update`                                         | `usergroups:read` / `usergroups:write`       |
| `pins.add`, `.remove` / `pins.list`                                                                                                               | `pins:write` / `pins:read`                   |
| `bookmarks.add`, `.edit`, `.remove` / `bookmarks.list`                                                                                            | `bookmarks:write` / `bookmarks:read`         |
| `stars.add`, `.remove` / `stars.list` (user tokens)                                                                                               | `stars:write` / `stars:read`                 |
| `team.info`                                                                                                                                       | `team:read`                                  |
| `emoji.list`                                                                                                                                      | `emoji:read`                                 |
| `dnd.info`, `.teamInfo` / `dnd.setSnooze`, `.endSnooze`, `.endDnd`                                                                                | `dnd:read` / `dnd:write`                     |
| `chat.scheduleMessage`, `.scheduledMessages.list`, `.deleteScheduledMessage`                                                                      | `chat:write`                                 |
| `reminders.info`, `.list` / `reminders.add`, `.complete`, `.delete`                                                                               | `reminders:read` / `reminders:write`         |
| `assistant.threads.setStatus`                                                                                                                     | `assistant:write` or `chat:write`            |
| `apps.connections.open`                                                                                                                           | `connections:write`                          |
| `api.test`, `auth.test`, `auth.revoke`, `chat.getPermalink`, `views.open`, `.push`, `.update`, `oauth.v2.access`                                  | none                                         |

`chat:write.public` stays a bot scope that lets a bot post in a public channel
it isn't in (`requireWritable()`); without it a bot must be a member.

### Campflare's own scopes

For `campflare.*` methods, named in Slack's `noun:verb` style:

| scope                              | methods                                                       | why it's separate                                         |
| ---------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `rtm:stream`                       | `rtm.connect`                                                 | a live feed of everything the person sees                 |
| `events:read`                      | `campflare.events.poll`                                       | the same, by cursor                                       |
| `views:read` / `views:write`       | `campflare.views.list` / `.submit`, `.close`                  | acting in an app's modal as the person                    |
| `chat:write`                       | `campflare.blocks.action`, `campflare.chat.stopStream`        | a click or a stop acts in the conversation                |
| `apps:read` / `apps:write`         | `apps.list` / `campflare.apps.*`                              | `apps.info` reveals signing secrets, so it's `apps:write` |
| `tokens:read` / `tokens:write`     | `campflare.tokens.list` / `.create`, `.revoke`                | minting tokens is how a token would escalate              |
| `users.password:write`             | `campflare.users.setPassword`                                 | a password is the whole account                           |
| `admin.users:write`                | `campflare.users.create`, `.deactivate`, `.setRole`           | plus the admin or owner role                              |
| `admin.users:write`                | `campflare.users.createPasswordReset`                         | a role above the person's ([invites.md](invites.md))      |
| `admin.invites:write`              | `campflare.invites.create`, `.revoke`                         | plus the admin role; an admin invite, owner               |
| `admin.invites:read`               | `campflare.invites.list`                                      | plus the admin role                                       |
| `calls:read` / `calls:write`       | `campflare.huddles.info`, `.ice_servers` / the rest           | Slack's names for calls                                   |
| `activity:read` / `activity:write` | `campflare.activity.list` / `.mark`                           | a person's inbox ([activity.md](activity.md))             |
| `prefs:read` / `prefs:write`       | `campflare.prefs.get` / `.set`                                | notification levels                                       |
| `push:read` / `push:write`         | `campflare.push.list` / `.subscribe`, `.unsubscribe`, `.test` | where a person's notifications go ([push.md](push.md))    |

The live feeds (`rtm:stream`, `events:read`) deliver every event the person
could see, not only those their other scopes allow. Until events are filtered
by scope, each feed wants its own scope **and** every type's `:history`
(`{ all: […] }` in `NEEDS`; `scopes_required: "all"` in
`campflare.methods.list`), so a token can't read live what
`conversations.history` would refuse it.

### No escalation

`campflare.tokens.create` mints at most the caller's own scopes: asking for one
the calling token lacks is `missing_scope`, with `needed` listing them. Without
`scopes` or `preset` it copies the caller's. So an agent holding a read-only
token can hand a sub-agent a read-only token, and never more. The same holds
for an admin minting a token for someone else. An unknown scope or preset is
`invalid_arguments`.

### Presets

Scope lists are long, so `campflare.tokens.create` also takes `preset`
(combined with `scopes` by union). Presets live on the server, in
`scopes.ts`, so the CLI, MCP and anyone calling the API share one meaning:

- `read`: every `:read` and `:history`, `search:read`, `files:read`,
  `reactions:read`, `pins:read`, `bookmarks:read`, `stars:read`, `emoji:read`,
  `dnd:read`, `reminders:read`, `team:read`, `users:read`, `usergroups:read`,
  `rtm:stream`, `events:read`, `views:read`, `activity:read`, `prefs:read`,
  `push:read`.
- `write`: `read` plus `chat:write`, `reactions:write`, `pins:write`,
  `bookmarks:write`, `stars:write`, `files:write`, `reminders:write`, the
  conversation `:write` scopes, `views:write`, `activity:write`,
  `prefs:write`. What a chat agent needs.
- `full`: every user scope (`usergroups:write` is here only: changing who a
  `@handle` reaches is rarely a chat agent's job; so is `push:write`: where a
  person's notifications go is their own client's business). What a person's own sign-in gets.

A token stores presets by name (`tokens.scopes` holds `full`, or
`read,chat:write`), and they are expanded on every call (`expandScopes()`), so
a token made from a preset gains the scopes later features add to it without a
migration; app bots store `bot`, which expands to `DEFAULT_BOT_SCOPES`. Slack's
scopes always contain a colon, so a bare word is unambiguous. A preset can only
grow, though, so a token is minted with presets by name only when the caller
holds every user scope; a narrower caller's token stores the expanded list, and
can't outgrow its maker.

### Expiry

Tokens get an optional `expires` (migration 0018). `campflare.tokens.create`
takes `expires_in` (seconds, at least 60); an expired token answers
`token_expired`, Slack's code. A token for a one-off agent run should expire with it. Tokens made
without it never expire, as before.

### Which tokens get what

- `campflare.bootstrap`, `campflare.users.create`, a password or token sign-in:
  `full`.
- `campflare.apps.create`: the bot gets `bot` (`DEFAULT_BOT_SCOPES`, now with
  `assistant:write`, `mpim:write`, `channels:manage`, `rtm:stream`,
  `events:read`, `activity:read` and `activity:write`), the app token
  `connections:write`.
- `oauth.v2.access`: what the person consented to, out of the known user
  scopes and presets. The CLI, the web app and the desktop app ask for
  `user_scope=full`, since they expose everything; the consent page says in
  words what a preset grants.
- MCP over an OAuth JWT: the JWT's `scope`, out of the known user scopes and
  presets; a client that asked for none of ours (most ask for `openid` alone)
  gets `write`, which is what the consent page describes. MCP over an
  `xoxp`/`xoxb`: the token's.
- The server acting as a bot itself (interactivity responses, Huddle Scribe,
  delivery notices) builds its own `Auth` and is not checked.

`invoke()` (MCP tools) checks scopes exactly as `/api/:method` does: the check
lives in one function both call.

### Migrating existing tokens (0018)

Nothing checked scopes before, so stored lists are whatever the code wrote. The
migration keeps what each token could actually do: every user token becomes
`full` (narrowing old OAuth grants would break clients signed in now, such as
the web app at its own origin, whose old list lacks `rtm:stream`), and bot
tokens become `bot`. Only tokens made from now on are narrow. Then it adds
`tokens.expires`.

## Roles

Slack's roles, as Campflare's `users` columns already hold them:

- **owner** (`is_owner`, which also sets `is_admin`): everything an admin can,
  plus managing roles. The workspace always keeps at least one.
- **admin** (`is_admin`): manages people and other people's content.
- **member**: everything about their own account and content.
- **bot** (`is_bot`): an app's user; acts only through its app's tokens.

Guests (`is_restricted`, `is_ultra_restricted`) are left for later: the shapes
send `false` today, and adding them is a new role here plus a channel check.

| action                                                          | member | admin | owner |
| --------------------------------------------------------------- | ------ | ----- | ----- |
| their own messages, files, profile, tokens, password, apps      | ✓      | ✓     | ✓     |
| create and manage any user group (Slack's default)              | ✓      | ✓     | ✓     |
| delete anyone's message or file                                 |        | ✓     | ✓     |
| manage anyone's app                                             |        | ✓     | ✓     |
| add a person (`campflare.users.create`), mint a token for one   |        | ✓     | ✓     |
| invite a member; list or revoke invitations                     |        | ✓     | ✓     |
| reset a member's password (a link)                              |        | ✓     | ✓     |
| invite an admin, reset an admin's password                      |        |       | ✓     |
| deactivate a member                                             |        | ✓     | ✓     |
| deactivate an admin                                             |        |       | ✓     |
| make someone member, admin or owner (`campflare.users.setRole`) |        |       | ✓     |

Acting for someone else (deactivating them, minting a token for them) takes a
role above theirs, so an admin can't become an owner by minting the owner's
token. A non-admin gets `not_an_admin`, a non-owner `not_an_owner` (before,
`not_allowed_token_type`, which was the wrong code: the token type is right,
the person isn't), and anyone acting on an owner `cant_act_on_owner`: an owner
can't be deactivated, nor given a token by someone else. Only owners add an
admin (`campflare.users.create` with `is_admin`). The last owner can't be
demoted (`last_owner`): first make someone else owner; the check and the change
are one statement, so two owners demoting each other at once can't both
succeed. A bot user has no role to set (`user_is_bot`), but an admin may
deactivate one.

`campflare.users.setRole` (`user`, `role`: `member` | `admin` | `owner`)
answers the user and publishes `user_change` to the workspace, as do
deactivations, so clients and agents learn it without polling.

## Discovery: `campflare.methods.list`

No token needed. Answers every method with its token types and scopes:

```json
{ "ok": true, "methods": [{ "name": "chat.postMessage", "tokens": ["user", "bot"], "scopes": ["chat:write"] }, …],
  "presets": { "read": […], "write": […], "full": […] } }
```

An agent can check a plan against its token (`auth.test` answers its scopes in
`x-oauth-scopes`) before acting, and the CLI's `campflare api --list` prints
it.

## CLI

- `campflare whoami` adds the role and the token's scopes (`client.authTest()`
  in `@campflare/client` answers auth.test with its `x-oauth-scopes`).
- `campflare token create [--preset read|write|full] [--scopes a,b] [--expires 30m|12h|7d|<seconds>] [--label l] [--json]`
  prints the token alone on stdout (`TOKEN=$(campflare token create …)`) and
  what it holds on stderr.
- `campflare token list` shows each token's scopes, label and expiry.
- `campflare admin role <@person> member|admin|owner`.
- `campflare api --list [prefix]` prints `campflare.methods.list`.
- A `missing_scope` error says which scopes would do and how to mint a token
  with them; with `--json`, any API error goes to stderr as JSON.

## Later

- Filtering the live feeds (`rtm:stream`, `events:read`) by the token's other
  scopes, so a narrow token can stream what it may read (today a feed wants
  every type's `:history`).
- Guests (`is_restricted`, `is_ultra_restricted`).
- A primary owner, distinct from the other owners, with ownership transfer.
- `last_used` on tokens, so stale agent tokens can be found and revoked.

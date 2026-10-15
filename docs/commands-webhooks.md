# Slash commands and incoming webhooks

Status: implemented, 2026-10-15 (the `commands-webhooks` branch).

Most internal tools and agents plug into a team chat one of two ways: a URL
they POST to when something happens (an incoming webhook: CI, alerts, cron
jobs), or a `/command` people type to ask them for something (`/deploy
staging`). Both are Slack features with official SDK support, so tools that
already speak them should work after a base-URL change, and both reuse what
interactivity built: request signing, Socket Mode envelopes, `response_url`
and `trigger_id`.

## Incoming webhooks

### Creating one

`campflare.apps.createWebhook` (`app`, `channel`, optional `label`; user
token, `apps:write`; the app's installer or an admin, as every
`campflare.apps.*` setter) answers `webhook.url`,
`<origin>/services/<secret>`, once. Only the secret's SHA-256 is stored
(`webhooks.hash`, migration 0025), as for tokens. A webhook belongs to an app,
not a person: it posts as the app's bot, and a person who wants a simple
integration makes an app for it first (`campflare admin add-app`), which is
what Slack does too since legacy webhooks went away.

The conversation must be one the caller can see, not archived, and one the
bot can post in: any public channel (the bot has `chat:write.public`), else
one it is a member of (`not_in_channel` otherwise). The same is checked again
on every POST, since the bot may have been removed since.

`campflare.apps.webhooks.list` (`app`) lists the live ones with their
conversation, label, creator and `last_used`, never the URL;
`campflare.apps.webhooks.revoke` (`webhook`) stops one at once.

### Posting

`POST /services/<secret>` takes Slack's incoming-webhook body as JSON (with
any content type, as Slack does, since many tools send it as `text/plain`),
or as a form with `payload=<json>`: `text`, `blocks`, `attachments`,
`thread_ts`, `username`. `unfurl_links`, `unfurl_media`, `mrkdwn`, `icon_*`
and `channel` are accepted and ignored: app webhooks are bound to their
conversation, and the app's icon is its bot's. `username` is honoured because
`chat.postMessage` honours it for bots here. The message goes through the same
`postMessage()` as `chat.postMessage` (activity, events, thread summaries).

Answers are Slack's: `200 ok` as text, or the error code as text with Slack's
status:

| answer                | status | when                                                    |
| --------------------- | ------ | ------------------------------------------------------- |
| `invalid_payload`     | 400    | not a JSON object, or a form without `payload`          |
| `no_text`             | 400    | no `text`, `blocks` or `attachments`                    |
| `invalid_blocks`, …   | 400    | what `chat.postMessage` would refuse, by the same code  |
| `no_service`          | 404    | an unknown or revoked URL                               |
| `channel_not_found`   | 404    | the conversation is gone, or the bot can no longer post |
| `channel_is_archived` | 410    | archived                                                |
| `action_prohibited`   | 403    | the app's bot was deactivated                           |
| `rate_limited`        | 429    | with `Retry-After` in seconds                           |

`posting_to_general_channel_denied` needs a workspace setting restricting who
posts in #general, which Campflare doesn't have yet; it will apply here when
it does.

### Rate limit

Slack allows about one message a second per webhook, with short bursts. Each
webhook holds a token bucket in its own row (`bucket`, `bucket_at` in
milliseconds): 10 tokens, one back per second. The take is a guarded `UPDATE
… WHERE <tokens now> >= 1 RETURNING`, batched with the reads of the webhook,
its app, team, bot, conversation and the bot's membership: the lookup and the
limit cost one D1 round trip together, and two concurrent POSTs can't both
spend the last token. A POST that finds no token answers 429 with
`Retry-After` (how long until one is back, at least a second). A refused
request (bad payload, no text) still spends its token: the limit is on
requests, as on Slack.

## Slash commands

### Registering

`campflare.apps.setCommands` (`app`, `commands`: a JSON array of `{ command,
description, usage_hint, url }`) replaces an app's commands, Slack's manifest
`features.slash_commands`. The installer or an admin calls it with a user
token (`apps:write`), or the app itself with its bot token, for its own app
only: `commands`, Slack's bot scope for apps with commands, now in
`DEFAULT_BOT_SCOPES`. An agent can register its own commands when it starts.

A name is a slash and up to 31 lower-case letters (any script, so `/部署` and
`/café` work), digits, `-` or `_`. A name is the workspace's: the table's key
is `(team_id, name)`. Setting a name another live app holds is
`command_taken`, naming it, and nothing of the list is kept (the deletes and
inserts are one batch). A deactivated app's commands give way: the same batch
first deletes the clashing names of apps whose bot user is deactivated, and
`campflare.commands.list` and `.invoke` never see them.

`url` is where the command is POSTed when the app has no Socket Mode link;
https, or http on localhost, as Request URLs. It isn't challenged (Slack
doesn't challenge command URLs either). Every change publishes Slack's
`commands_changed` RTM event to the workspace, so clients reload their lists.

### Running one

`campflare.commands.invoke` (`channel`, `command`, `text`; user token,
`chat:write`) is what typing `/deploy staging` in the composer does. The
person must be able to post in the conversation (`requireWritable`: a member,
not archived). `campflare.commands.list` lists the workspace's commands with
their app, for autocompletion. Bots don't run commands, as on Slack.

The app gets Slack's fields: `token` (empty: requests are signed instead),
`team_id`, `team_domain`, `channel_id`, `channel_name` (`directmessage` for a
DM), `user_id`, `user_name`, `command`, `text`, `api_app_id`,
`is_enterprise_install`, `response_url`, `trigger_id`. Delivery is
interactivity's, through `TeamHub.interact()` with a `type`:

- With a Socket Mode link: a `slash_commands` envelope with
  `accepts_response_payload: true` on one link, waited for 3 seconds. The
  ack's `payload` is the immediate answer (`ack({ text })` in Bolt or
  `SocketModeClient`); a string is shown as text.
- Else a form POST of the fields, signed like events, to the command's `url`.
  The body is the answer: JSON, or plain text shown as text, or empty.

Not retried, as on Slack. Errors to the person: `command_not_found` (no such
command, or its app's bot is deactivated), `app_unreachable` (no link and no
URL, no ack within 3 seconds, no answer from the URL), `dispatch_failed` (the
URL answered non-2xx or broken JSON). Each carries a `response_metadata`
message saying which.

The immediate answer is shown as the app's bot: `response_type: in_channel`
posts it in the conversation, anything else is an ephemeral message to the
invoker over RTM. The method answers it too (`response: { response_type,
text, blocks, ts }`), so the CLI and agents, which have no RTM link, see it.
Slack also shows the invoker's own `/command` line above an `in_channel`
answer; Campflare doesn't post it (yet).

The `response_url` is interactivity's (30 minutes, 5 uses, signed claims, the
hub counting uses), without a message `ts`: `response_type: in_channel` posts,
anything else is ephemeral to the invoker, `replace_original` posts a new
message (there is no original), `delete_original` answers
`message_not_found`. The `trigger_id` is granted to the app for 3 seconds
before delivery, whichever way it goes, so `views.open` opens a modal for the
invoker.

Commands run in a conversation, not a thread: `thread_ts` isn't taken, and the
app's thread composer sends a `/word` as text, as Slack's does for most
commands.

### Clients

Core keeps `state.commands` (loaded after start, after a reconnect, and on
`commands_changed`) and `workspace.invokeCommand()`. `commandIn(draft,
commands)` says whether a draft is a registered command and its text;
`commandSuggestions(draft, commands)` the commands to offer while the name is
typed. In the app, a conversation's composer runs a matching draft instead of
sending it (anything else, `/shrug` included, is sent as before) and shows a
listbox of matches (role `listbox` named "Commands", options by role; arrows
move, Tab or Enter picks, Escape hides). A failure is a toast; the answer
arrives as a message.

## CLI

```sh
campflare admin app A0123 --command '/deploy:Deploy a branch:[branch]' --command-url https://ci.example/commands
campflare admin app A0123 --clear-commands
campflare commands [--json]
campflare command '#ops' /deploy staging      # prints the app's answer; stderr says who sees it
URL=$(campflare admin webhook create A0123 '#alerts' --label CI)
campflare admin webhooks A0123
campflare admin webhook revoke H0123
```

## MCP

`list_commands` and `run_command` (`conversation`, `command`, `text`): an
agent can ask another tool for something the way a person would, and read
its answer.

## Later

- Showing the invoker's `/command` line with an `in_channel` answer.
- `replace_original` and `delete_original` on a command's `response_url`
  acting on the previous ephemeral answer.
- Slack's built-in commands (`/remind`, `/invite`, `/topic`…) as Campflare
  commands.
- Webhook `channel` overrides for an app with `incoming-webhook` on several
  conversations, and per-workspace webhook limits.

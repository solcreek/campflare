# Importing a Slack export

Status: implemented, 2026-10-15 (the `import` branch).

A team switching to Campflare needs its history. Slack's workspace export is a
zip; this imports one through the API, so the CLI, an agent or any other client
can drive it. The server never sees the zip: the client reads it and sends the
contents in chunks, and the server maps, checks and writes them.

## The export

A Slack export zip holds:

- `users.json`: everyone, with `profile.email` (bots have none).
- `channels.json`: public channels, with `members`, `topic`, `purpose`,
  `is_general`, `is_archived`. Business+ exports add `groups.json` (private
  channels), `mpims.json` (group DMs) and `dms.json` (DMs, `members` only).
- One folder per conversation (a channel's name; a DM's id), with one
  `YYYY-MM-DD.json` file per day: an array of messages (`ts`, `user`, `text`,
  `thread_ts`, `parent_user_id`, `reply_count`, `reactions`, `files`,
  `edited`, `pinned_to`, `subtype` such as `channel_join`, `bot_message`…).
- `integration_logs.json` and others, which the import ignores.

## Flow

```
campflare import slack export.zip
  → campflare.import.start          a job (or the running one for this export: resume)
  → campflare.import.users          users.json, in chunks: map or make placeholders
  → campflare.import.conversations  channels/groups/mpims/dms: map, merge or create
  → campflare.import.messages       per conversation, per day file, in chunks
  → campflare.import.files          only with --files download: attach uploaded bytes
  → campflare.import.finish         per conversation: orphan threads, read markers… until done
```

Every method is idempotent, and the job records progress, so re-running the
same command after a failure continues where it stopped.

### Reading the zip (the CLI)

`apps/cli/src/zip.ts` is a small reader on Node's own `zlib`, no dependency:
it reads the end-of-central-directory record (ZIP64 too) from the end of the
file, lists the entries from the central directory, and inflates one entry at a
time from its offset (`inflateRaw`). The file is opened, not read: memory holds
the central directory and one entry, and a Slack export's entries are small
(one day of one channel). Streaming the zip front to back instead would need
the data descriptors that zip writers put after an entry, which a central
directory reader doesn't; random access is simpler and as cheap. Stored and
deflated entries are supported, which is what Slack writes.

The export is identified by a fingerprint: the SHA-256 of its central
directory. `campflare.import.start` with a fingerprint that a running job of
the workspace already has answers that job (`resumed: true`) instead of
starting another, and one whose job finished answers `already_imported` (undo
it first to import again).

### Methods

All are `campflare.*`, xoxp only, for **admins** (`not_an_admin`), and want
`admin.import:write` (`campflare.import.status` and `.list`: `admin.import:read`).
Both scopes are in the `full` preset only.

| method                           | arguments                                                                                                    | answers                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `campflare.import.start`         | `format` (`slack-export`), `fingerprint`, `merge_into_existing`, `files` (`skip`, `download`), `source_name` | `job`, `resumed`                                 |
| `campflare.import.users`         | `job`, `users` (users.json entries, ≤ 500)                                                                   | `mapped`, `created`, `users` (source → id)       |
| `campflare.import.conversations` | `job`, `conversations` (≤ 200; each with `type`: `channel`, `group`, `mpim`, `im`)                           | `conversations` (source → id, `action`)          |
| `campflare.import.messages`      | `job`, `conversation` (source id), `messages` (≤ 1000, ≤ 4 MB), `cursor`                                     | `channel`, `imported`, `skipped`, `files_needed` |
| `campflare.import.files`         | `job`, `conversation`, `ts`, `files` (≤ 10, `[{source_id, file_id, title}]`)                                 | `attached`, `skipped`, `files`                   |
| `campflare.import.finish`        | `job`                                                                                                        | `done`, `remaining`, `job`                       |
| `campflare.import.undo`          | `job`                                                                                                        | `done`, `removed`, `job`                         |
| `campflare.import.status`        | `job`                                                                                                        | `job`, `conversations` (with `cursor`)           |
| `campflare.import.list`          | none                                                                                                         | `jobs`, newest first                             |

A job (`import_jobs`, migration 0026) is `{ id: "J…", state, format, options,
counts, created_by, created, updated, finished }`. `state` is `running`,
`finished`, `undoing` or `undone`. `counts` add up what was written (inserted
rows only, so a re-sent chunk adds nothing): `users_mapped`,
`users_created`, `conversations_created`, `conversations_merged`,
`conversations_renamed`, `conversations_skipped`, `messages`,
`messages_skipped`, `reactions`, `pins`, `files` (files the messages carry),
`files_attached`, `files_skipped` (the difference), and `unmapped_users` (ids
referenced but not in `users.json`, at most 100). The counts after an insert
are bumped in the same batch with SQLite's `changes()`, so they count what
that statement wrote. A job that isn't running refuses writes
(`import_not_running`).

`campflare.import.messages` answers `imported` (how many of the chunk's
messages are the job's now, re-sent ones included), `skipped` (those that
clashed with a message that was already there) and `files_needed` (the chunk's
files not yet attached). Its `cursor` (the day file, for the CLI) is stored on
the conversation's mapping and answered by `campflare.import.status`, so a
re-run starts after the last day that went in whole.

The mappings live in `import_users`, `import_conversations` and
`import_files` (an export file per row, `file_id` NULL until attached), keyed
by job and the export's id.

### Limits

One call takes at most 500 users, 200 conversations or 1000 messages, and a
`messages` argument of at most 4 MB (`limit_exceeded`, with `max`). D1 binds a
JSON argument of at most 2 MB, so the server writes a chunk in several
statements of one batch when it is bigger. The CLI sends 500 messages or 1 MB
per call, whichever comes first.

## Mapping

**People.** By email, case-insensitive, against every user of the workspace
(deactivated ones too). An export user without a match becomes a
**placeholder**: a deactivated user (`deleted = 1`) with the export's handle,
names, title and time zone, no email and no token, tagged with the job. Its
handle is the export's (made a valid handle), or `<name>-imported`,
`-imported-2`… when taken by a person or a user group. Bots in `users.json`
become deactivated bot users the same way. `USLACKBOT` stays `USLACKBOT` (what
Campflare's tombstones already use).

Why deactivated placeholders and not invitable users: an import must not hand
out accounts, and a placeholder can't sign in or be messaged. To have someone's
history under their own account, add or invite them **before** importing; the
email matches and their messages are theirs. Claiming a placeholder afterwards
(rewriting the job's rows to a real account) is later work: the job's
`import_users` table already says which rows to rewrite.

**Conversations.** A public channel stays public, `groups.json` becomes private
channels, `mpims.json` group DMs and `dms.json` DMs. A channel whose name is
taken in the workspace is **renamed** `<name>-imported` (then
`-imported-2`…) unless `merge_into_existing` is given, in which case the
messages go into the existing channel. A DM or group DM always goes into the
existing one with the same people, if there is one (there can't be two).
Channel members come from the export's `members`; every mapped user is added
(placeholders too: a deactivated person stays a member in Campflare, as on
deactivation). A conversation with someone who isn't in `users.json` (a DM with
an external person) is `skipped`: there's no one to give it to. Topic, purpose, archived state and creation time are kept for
created conversations; a merged one keeps its own.

**Messages.** Slack's `ts` stays the Campflare `ts` (the fixed-width format
holds it). Rows are keyed `(channel, ts)` and inserted with `INSERT OR IGNORE`,
so re-sending a chunk changes nothing, and a non-imported message at the same
`ts` (only possible when merging) is never touched: it is counted in
`messages_skipped`. In the text, `<@U…>` and `<@U…|name>` become the mapped
user (`<@Uxxx|name>` of an unmapped one becomes `@name`), and `<#C…|name>` the
mapped conversation.

- **Threads**: `thread_ts` is kept. Heads and replies may arrive in any order
  and in any chunk: each chunk recounts the threads it touches (`reply_count`,
  `latest_reply`, `reply_users`, the head's `thread_ts`) from what is stored,
  so the last chunk leaves them right. A thread whose head never comes (Slack
  drops deleted heads from exports) gets a tombstone head at finish, as
  `chat.delete` leaves one, so its replies stay reachable.
- **Edits**: `edited.ts` and the mapped `edited.user`.
- **Reactions**: each `users` entry that maps (exports truncate long lists, so
  a count can come out lower).
- **Pins**: `pinned_to` containing the conversation pins it: `pinned_by` from
  `pinned_info` when present, else the author; `pinned_at` from `pinned_info`,
  else the message's time.
- **Bots**: a `bot_message` keeps its subtype and shows `username` (or
  `bot_profile.name`); it has no Campflare app (`bot_id` is dropped: Slack's
  bot ids mean nothing here), and a `user` only when the export gives one.
- **Joins and leaves** (`channel_join`, `channel_leave`) are kept as messages,
  as Campflare posts them itself; membership comes from `members`.
- **Blocks** are dropped when there is text (Slack's `rich_text` blocks repeat
  the text with Slack's ids inside); kept when the text is empty.
- **Files**: by default not imported: each file becomes a line in the
  message, `[file not imported: <name>]`, and is counted in `files_skipped`.
  With `--files download --slack-token xoxp-…`, the CLI downloads each
  `url_private_download` with that token, uploads it through
  `files.getUploadURLExternal` (the same path as any upload), and
  `campflare.import.files` attaches it: the file becomes the author's, shared in
  the conversation, tagged with the job, and the placeholder line goes.
  `campflare.import.messages` answers `files_needed` (the chunk's files not yet
  attached), so a re-run downloads only what is missing. Files Slack hid
  (`hidden_by_limit`, tombstones) have no URL and stay placeholders.

### No events

Imported rows are written directly in batches, never through `postMessage` or
`addMember`: an import publishes **no** events (RTM, Socket Mode, the event
log), records no activity items, sends no notifications and delivers nothing to
apps. Ten years of history must not ring anyone's phone. Clients see imported
conversations and messages on their next load or reconnect, which re-lists.

### Finish

`campflare.import.finish` handles up to 10 of the job's conversations per call
and answers `done: false` with `remaining` until all are: it adds tombstone
heads for orphan threads, sets each reply's `parent_user_id`, fills
`thread_participants` (so a later reply notifies the thread's people),
moves every member's `last_read` up to the newest imported message (history
arrives read) and the conversation's `updated` to it. Then the job is
`finished`. Search needs nothing: the FTS index follows `messages` by trigger.

## Undo

Everything the import writes carries its job id (`import_job` on `messages`,
`reactions`, `members`, `files`, `users`, `conversations`; migration 0026), so
`campflare.import.undo` can take it back: while running, and up to 7 days after
finishing (`undo_window_passed` after). It deletes up to 2000 messages per call,
with their reactions, stars and activity, answering `done: false` until none are
left; then the memberships, files (and their R2 objects), the conversations the
job created (with their bookmarks, stars, notification levels and activity) and
the placeholder users. The job ends `undone`. Undo refuses (before it starts) with
`import_in_use` when a conversation the job created holds messages that didn't
come from it: people have used it since, and removing it would take their
messages too.

## CLI

```
campflare import slack <export.zip> [--dry-run] [--files skip|download --slack-token xoxp-…]
                                    [--merge-into-existing] [--json]
campflare import status [<job>] [--json]     the job, or every job
campflare import undo <job> [--json]
```

Progress goes to stderr; the summary (counts, unmapped users, skipped files) to
stdout, or as JSON with `--json`. `--dry-run` reads the whole export and the
workspace's people and conversations, and says what would happen (who maps by
email, which channels would be renamed or merged, how many messages and files)
without writing anything.

## Custom emoji (a seam)

An export has no emoji images, and custom emoji storage is another feature.
With `--slack-token`, the CLI reads Slack's `emoji.list` and hands it to
`importCustomEmoji()` in `apps/cli/src/import.ts`, which today only counts
them as skipped (`emoji` in the summary). `--slack-api` points it at another
Slack API base (the tests' stand-in). Wiring it is one function:
call the emoji feature's add method per entry (an alias as an alias), with the
image downloaded from Slack.

## Later

- Claiming a placeholder for a real account (above).
- Slack's Enterprise Grid exports (one folder per workspace) and shared
  channels' external users.
- Importing other formats: the methods take Slack's shapes, but `format` is
  there for others.

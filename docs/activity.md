# Activity inbox and notification preferences

Status: implemented, 2026-10-15 (the `activity-inbox` branch).

People and agents need to learn "what needs my attention" without reading every
channel. Slack has an Activity view for this; its API doesn't expose it. This is
the server-side model: what is recorded, who may list it, and whether each item
should notify. Push delivery and the app's UI come later and consume it as is.

## What is recorded

An **activity item** is one thing that happened to one person (`activity`,
migration 0019): its recipient, `kind`, the conversation and message `ts`, the
message's thread, who did it (`actor_id`), the reaction for a reaction, when, and
whether it is read and should notify.

| kind           | when                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `mention`      | a new message names the recipient (`<@U…>`), or says `<!here>`, `<!channel>` or `<!everyone>` in a conversation they are in |
| `dm`           | a new message in an im or mpim they are in                                                                                  |
| `thread_reply` | a new reply in a thread they take part in: they wrote its first message, or replied before                                  |
| `reaction`     | someone reacts to their message (one item per person and emoji: two emoji from one person are two items)                    |

Rules:

- **Never your own.** The author of a message, or the person reacting, gets no item.
- **One item per message per person**, the strongest kind: `mention`, then `dm`,
  then `thread_reply`. A DM that names you is one `mention`, not two items.
- **Members only.** Recipients are the conversation's members when the message
  is posted. Naming someone who isn't in the conversation records nothing for
  them (Slack offers the author to invite them instead). `<!here>` reaches every
  member, whatever their presence.
- **New messages that say something**: no subtype, `thread_broadcast`,
  `file_share`, `bot_message`, `me_message` (as `app_mention` picks them, plus
  `/me`). Joins, renames, topic changes and huddle notices never make items.
- **Bots count** both ways: a bot's message mentions, DMs and replies like a
  person's, and a bot user gets items too (an agent with a bot token has an
  inbox).
- **Edits record nothing**, add or remove nothing: Slack doesn't notify on an edit
  either. A stream (`chat.startStream`) counts with the text it starts with;
  text appended later doesn't mention anyone.
- Mentions are read from `text`, which is what every Slack client writes them
  in. Mentions only inside blocks aren't found.

### On the write path

The items are written by one `INSERT … SELECT … RETURNING` in the same batch as
the message (`messageActivity()` in `src/activity.ts`): the recipients come from
`members` in SQL, the thread's participants from `messages`, the preferences and
snooze from `notification_prefs` and `users`, so posting costs no extra round
trip. A reaction's item is one more statement in `reactions.add`'s batch. The
returned rows go out as `activity_added` RTM events (`rtmOnly`), one per
recipient, in one RPC to the hub (`publishEach()`), after the response.

### Deletes and leaving

- Deleting a message (or tombstoning a thread head) deletes its items, the
  reactions to it included, in the delete's batch; removing a reaction deletes
  its item. Each recipient gets `activity_removed` with the ids.
- Leaving a conversation (or being removed) **hides** its items rather than
  deleting them: listing joins `members`, so an item is listed only while its
  recipient is still in the conversation. Rejoining brings them back. This also
  covers a private conversation one can no longer see, with nothing to keep in
  step on the membership paths.
- Listing also joins the message, so anything the delete path missed never shows.
- A token sees the items of the conversation types it holds `:history` for
  (`channels:`, `groups:`, `im:`, `mpim:`), as `conversations.history` would
  refuse it the rest: an item carries the message.

Items are kept until their message goes. Pruning old read items is left for later.

## Methods

| method                    | access | scope            |
| ------------------------- | ------ | ---------------- |
| `campflare.activity.list` | actor  | `activity:read`  |
| `campflare.activity.mark` | actor  | `activity:write` |
| `campflare.prefs.get`     | user   | `prefs:read`     |
| `campflare.prefs.set`     | user   | `prefs:write`    |

`activity:read` and `prefs:read` are in the `read` preset; `activity:write` and
`prefs:write` in `write` (muting a noisy channel is something a chat agent may
well do for its person, and it only changes the person's own notifications).
App bots get `activity:read` and `activity:write`.

**`campflare.activity.list`** (`limit` 1–200, default 50; `cursor`;
`unread_only`; `types`, a list of kinds) answers the newest first:

```json
{
  "ok": true,
  "items": [
    {
      "id": "42",
      "type": "mention",
      "channel": "C…",
      "ts": "1760000000.000100",
      "thread_ts": "1759999000.000200",
      "actor": "U…",
      "created": 1760000000,
      "is_read": false,
      "notify": true,
      "message": { "type": "message", "user": "U…", "text": "…", "ts": "…" },
      "permalink": "https://…/archives/C…/p1760000000000100"
    }
  ],
  "unread": { "total": 3, "mention": 1, "dm": 1, "thread_reply": 0, "reaction": 1 },
  "response_metadata": { "next_cursor": "…" }
}
```

A reaction item adds `"reaction": "tada"`. `unread` counts what the token can
list, ignoring `types` and the page: it is the badge. `limit=1` is a cheap way
to read only the counts. Items, messages, their reactions and the counts are one
batch.

**`campflare.activity.mark`** marks read: `ids` (a list), or `up_to` (an id:
that item and every older one), or `all=true`; exactly one of them. It answers
`{ marked, unread }` and sends the person's clients `activity_marked` (`ids`,
`up_to` or `all`, and `unread`) so every client clears the same badge.

## Notification preferences

A person sets a level per conversation, and a default for the rest:

- `all`: every item notifies.
- `mentions`: `mention` and `dm` items notify; thread replies and reactions are
  recorded quietly.
- `none`: nothing from there notifies (muted).

The level is the conversation's, else the person's default, else `all`: items
are already the things worth attention, so the built-in default lets them all
through. Snoozed (`dnd.setSnooze`, until `users.snooze_until`) nothing notifies.

Activity is **recorded regardless of preferences**: Slack's Activity view shows
mentions in muted channels too, and a level only says whether to interrupt. So
preferences decide `notify` on each item, never whether it exists. `notify` is
decided when the item is recorded and stored: a push sender reading it later
must act on what held then, and a snooze that ends later shouldn't make old
items ring.

`campflare.prefs.get` answers `{ prefs: { notifications: { default, conversations: { "C…": "mentions" } } } }`.
`campflare.prefs.set` takes `level` (`all`, `mentions`, `none`, or `default`
to clear) and an optional `channel` (without it, the person's default). It answers
the same shape and sends the person's clients `prefs_changed` with it. Named
`prefs` rather than `notifications.*` so later per-person settings (the ones
Slack keeps in `users.prefs`) join them under one scope pair.

## CLI and MCP

- `campflare inbox [--unread] [--type mention,dm] [-n N] [--json] [--follow]`:
  the newest items, then the unread counts on stderr; `--follow` keeps printing
  new ones as they arrive (RTM `activity_added`).
- `campflare inbox read <id…> | --all | --up-to <id>`.
- `campflare notify <#channel|@person> all|mentions|none|default`, `campflare
notify --default <level>`, and `campflare notify` alone to show them.
- MCP: `get_activity` (unread only by default), the tool an agent asked "what
  needs my attention" should reach for, and `mark_activity_read`.

## Where user group mentions plug in

`<!subteam^S…>` mentions (user groups, another branch) are one more source of
mentioned users. `mentionsOf()` returns the user ids a text names; the INSERT
takes them as one JSON list (`json_each`). A group's members join that set in
SQL, `UNION SELECT user_id FROM <group members> WHERE group_id IN (…)`, in the
same statement, so a group mention costs no round trip and still reaches only
the conversation's members.

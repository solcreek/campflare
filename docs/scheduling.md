# Scheduling: scheduled messages and reminders

Status: implemented, 2026-10-15 (the `scheduled-reminders` branch).

Two features need something to happen at a time nobody is calling the API:

- **Scheduled messages**: Slack's `chat.scheduleMessage`,
  `chat.scheduledMessages.list` and `chat.deleteScheduledMessage`. At `post_at`
  the message is posted exactly as `chat.postMessage` would post it, as the same
  person or bot.
- **Reminders**: Slack's `reminders.add`, `.complete`, `.delete`, `.info` and
  `.list`. At `time` the person gets a DM, "Reminder: …", from a built-in bot.

## Where the timers live

D1 is the truth: `scheduled_messages` and `reminders` (migration 0023) hold
every pending item with its due time. The timer is a Durable Object alarm in a
new class, **`Scheduler`**, one per workspace (`idFromName(teamId)`), which
holds nothing but the workspace id and its alarm.

- Scheduling writes the row, then `await`s `Scheduler.arm(teamId, at)`, which
  moves the alarm earlier if `at` is earlier than it. The method answers only
  after both, so an `ok` means the alarm is set.
- `alarm()` reads what is due from D1 (up to 50 of each kind, oldest first)
  and fires it, five at a time: reminders side by side, scheduled messages
  side by side across conversations but in due order within one. The built-in
  bot is looked up once per run. A row that fails is logged and left to its
  claim; it never stops the others.
- Then, whatever the run hit, it re-arms at the earliest due time left in D1,
  unless the alarm is already set sooner (an `arm()` that came in while the run
  awaited D1). It never trusts its own memory of what is pending: an item
  scheduled while an arm call failed is still found by the next alarm in the
  workspace. Only when D1 can't say what's next does `alarm()` throw, and
  Cloudflare retries it.

Why a separate class and not `TeamHub`'s alarm: a Durable Object has one alarm,
and `TeamHub.alarm()` already multiplexes Socket Mode resends and Events API
retries, which come every few seconds and must stay cheap (they read only the
hub's own SQLite). Folding a D1 read into each of those runs, or keeping a copy
of the schedule in the hub to avoid it, couples two unrelated retry loops and
puts a second source of truth next to D1. Firing also posts messages, and
posting calls `publish()`, which is an RPC to `TeamHub`: from inside the hub
that is a call to itself. A separate class costs one wrangler migration (`v3`)
and one binding (`SCHEDULER`), and keeps both alarms simple. An idle workspace
costs nothing: no alarm is set when nothing is pending.

## Delivery: at least once, posted once

Cloudflare runs a Durable Object's alarm at least once: an alarm that throws is
retried with backoff, and an alarm set survives eviction and restarts. On top
of that, each item is posted at most once:

1. **Claim**: `UPDATE … SET claimed_until = now + 60, claim = <random token>,
attempts = attempts + 1 WHERE id = ? AND due <= now AND (claimed_until IS
NULL OR claimed_until <= now) RETURNING *`. Only one runner gets the row; a
   second run of the same alarm (or two runs at once) finds it claimed and
   skips it.
2. **Post and finish in one batch, while the claim holds**: `postMessage()`
   takes extra statements to run in its own `DB.batch`: a guard, then the
   `DELETE … WHERE claim = <token>` of the scheduled message (or the reminder's
   `fired = 1`). The guard inserts a NULL into `claim_guards.lost` (NOT NULL)
   when the row no longer holds the token, which fails the statement and rolls
   back the whole batch, message included. A crash before the batch leaves the
   claim to expire, and the item is tried again after 60 s; a crash after it
   leaves nothing pending.
3. **Deleting** a scheduled message is refused while it is claimed
   (`invalid_scheduled_message_id`). Once a claim has run out it may be
   deleted, and the runner that held it then posts nothing.

So a runner that stalls past its 60 s lease can't post twice: the run that
took the row over holds a new token, and the stalled runner's batch fails on
the guard. `isUniqueViolation()` matches only UNIQUE and PRIMARY KEY clashes,
so `postMessage` doesn't retry that failure with another ts.

An item that fails with an unexpected error (D1 down) keeps its claim and is
tried again when the lease ends, up to 5 attempts; then it is given up as a
failure (below).

## When the poster lost access meanwhile

Scheduling checks what posting would: the conversation exists, the poster may
write to it (member, not archived; a bot with `chat:write.public` in a public
channel), the thread exists. At fire time the same checks run again, as the
poster, with what is true then:

- **Left the channel, removed, channel archived, thread deleted**: the message
  is not posted. It is dropped, and the poster (a person, still active) gets a
  DM from the built-in bot: "Your scheduled message to #x couldn't be sent
  (not_in_channel): …". Slack does the same through Slackbot.
- **Deactivated** person or bot user: dropped silently; nobody to tell.
- **The token's scopes, as they were**: the row keeps the scopes the
  scheduling token held, and the fire-time check uses them. So a bot whose
  token lacks `chat:write.public` and that was removed from the channel is
  dropped like a person who left; one with it may still post to a public
  channel, as it could have when scheduling.
- **The token itself no longer matters**: the scheduled message belongs to the
  person or bot, as on Slack. Revoking or expiring the token doesn't cancel it;
  `chat.deleteScheduledMessage` does (any of the poster's tokens with
  `chat:write`). Deactivating a person cancels theirs, as above.

Reminders for a deactivated person are dropped at fire time without a DM.

## The built-in bot

Reminders and failure notices come from a per-workspace bot user named
**Campflare** (handle `campflare`, another if a person has it), made on first
use as an ordinary app with a bot user and no tokens: only the server acts as
it. It is found by `apps.built_in = 'campflare'` (migration 0023), never by
name, so an app someone creates and names "Campflare" can't stand in for it
and read people's reminders.

## Scheduled messages

- `chat.scheduleMessage` (`chat:write`, user or bot): `channel`, `post_at`
  (Unix seconds), `text`/`blocks`/`attachments`, `thread_ts`,
  `reply_broadcast`, `metadata`, `username` (bots). Errors as Slack's:
  `invalid_time` (not a number), `time_in_past`, `time_too_far` (over 120
  days), `restricted_too_many` (30 already due within five minutes of it in
  that channel), plus `chat.postMessage`'s. Answers `scheduled_message_id`
  (`Q…`), `post_at`, `channel` and the `message`.
- `chat.scheduledMessages.list` (`chat:write`): the caller's own (the bot's,
  for a bot token), by `post_at`; `channel`, `oldest`, `latest`, `limit`
  (default 100, at most 1000), `cursor`.
- `chat.deleteScheduledMessage` (`chat:write`): `channel` and
  `scheduled_message_id`; `invalid_scheduled_message_id` for one that isn't
  the caller's, isn't in that channel, was posted, or is being posted.

## Reminders

- `reminders.add` (`reminders:write`, user tokens, as on Slack): `text`, `time`,
  `user` (only yourself: someone else is `cannot_add_others`). Answers the
  `reminder`: `id` (`Rm…`), `creator`, `user`, `text`, `recurring: false`,
  `time`, `complete_ts` (0 until completed).
- `reminders.info`, `.complete`, `.delete` (`reminder`), `.list`
  (`reminders:read` for info and list). `not_found` for one that isn't yours.
  Completing one before it fires means it won't.
- `recurring` is always false: recurring reminders are not supported yet. A
  phrase like `every Thursday` answers `cannot_parse`, a `recurrence` argument
  `invalid_recurrence`.

### `time`

In the person's `tz` (`users.tz`; UTC if unknown, and no method sets it yet), case-insensitive:

| form                                                    | means                                                   |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `1700000000`                                            | a Unix timestamp                                        |
| `900` (at most 86400)                                   | seconds from now, as Slack reads a small number         |
| `in 15 minutes`, `in an hour`, `in 2 days`, `in 1 week` | from now; units second, minute, hour, day, week (+ `s`) |
| `15m`, `2h`, `1d`, `1w`, `30s`                          | from now                                                |
| `at 9am`, `at 5:30pm`, `at 17:30`                       | today, or tomorrow if that time has passed              |
| `today at 5pm`                                          | today (past: `time_in_past`)                            |
| `tomorrow`, `tomorrow at 9:15am`                        | tomorrow, 9:00 unless a time is given                   |
| `monday`, `on friday at 4pm`                            | the next such day (a week on if it is today), 9:00      |
| `2026-12-24 18:00`, `2026-12-24`                        | that date (9:00 without a time)                         |
| `2026-12-24T18:00:00Z`, `…+02:00`                       | ISO 8601 with an offset                                 |

Anything else is `cannot_parse`; a time already past is `time_in_past`; more
than five years ahead is `time_too_far`.

## Events

Nothing on Slack announces these, so they are Campflare's, RTM-only (and in the
event log), to the poster's or the reminded person's own clients, so a second
device or an agent following `campflare.events.poll` sees changes:

- `scheduled_message_added` (`scheduled_message`), `scheduled_message_removed`
  (`scheduled_message_id`, `channel`, `reason`: `deleted` | `posted` |
  `failed`, with `ts` when posted, `error` when failed).
- `reminder_added`, `reminder_changed` (fired or completed; the `reminder`),
  `reminder_deleted` (`reminder_id`).

The posted message itself goes out as any message does (`message`,
`app_mention` for a bot mentioned in it, Events API).

## Failure modes

| what fails                               | what happens                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Scheduler.arm` after the row is written | the method errors; the row stays and fires at the next alarm in the workspace (any later schedule sets one) |
| the run fails (D1 errors)                | logged; the alarm re-arms from D1; claimed items wait for their lease                                       |
| D1 can't say what's next                 | `alarm()` throws and Cloudflare retries it                                                                  |
| the runner dies mid-post                 | the batch didn't commit: the claim expires, tried again in 60 s                                             |
| the runner dies after the post           | the row is gone with the post: nothing repeats                                                              |
| the runner stalls past its lease         | the run that takes over posts; the stalled one's batch fails on the guard                                   |
| D1 errors on one item, 5 times           | given up as failed: dropped, the poster told                                                                |
| more than 50 items due at once           | the run fires 50 of each and re-arms for now                                                                |

## Later

- Recurring reminders (`every weekday at 9am`), with their own next-time rule.
- Reminders for others (`user` someone else), with the check Slack does.
- A "Mark as complete" button on the reminder DM.
- Editing a scheduled message (Slack has no method for it either).

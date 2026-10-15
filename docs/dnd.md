# Time zones, status expiry and do-not-disturb hours

Status: implemented, 2026-10-15 (the `time-and-dnd` branch).

Three things that depend on the person's clock: their time zone, a status that
ends at a time, and hours when nothing should interrupt them.

## Time zones

`users.tz` (an IANA name, `UTC` until set) is what reminders' times
(`docs/scheduling.md`) and DND hours are read in. Slack has no method that sets
it (its clients send it through settings), so:

- **`campflare.users.setTimezone`** (xoxp, `users.profile:write`): `tz`, an
  IANA zone (`Europe/Paris`, any case). A fixed offset (`+02:00`) or an
  unknown name is `invalid_timezone`: a person's zone follows its DST rules,
  an offset doesn't. A name the runtime knows by an older one
  (`Asia/Kolkata`, which ICU calls `Asia/Calcutta`) keeps the name given.
  Answers the `user` and sends `user_change`; with DND hours set, the stored
  window moves to the same wall-clock hours in the new zone (`dnd_updated`,
  `dnd_updated_user`), keeping a window skipped with `dnd.endDnd` skipped. The
  zone it already has changes nothing and sends nothing.
- Users carry Slack's `tz`, `tz_label` (`Central European Summer Time`) and
  `tz_offset` (seconds east of UTC, `7200`) for the instant they're read, so
  they change at DST transitions with no write. Both come from `Intl`
  (`zoneLabel()`, `zoneOffset()` in `src/api/when.ts`).
- CLI: `campflare profile --tz Europe/Paris` (or `--tz local`, this machine's
  zone); `campflare profile` shows it.

## Status expiry

A status past `status_expiration` already reads as empty. Now clients are told
when it expires, as Slack tells them:

- `users.profile.set` with a future `status_expiration` arms the workspace's
  `Scheduler` (`docs/scheduling.md`) at that time before it answers.
- The alarm clears every status due in one statement:
  `UPDATE users SET status_text = '', status_emoji = '', status_expiration = 0
… WHERE id IN (… due, LIMIT 50) AND status_expiration > 0 AND
status_expiration <= now RETURNING *`, then sends `user_change` for each row
  it returned.
- **Races.** The UPDATE checks the row as it is when it runs, so a status set
  again before the alarm (a later expiration, or none) isn't due and isn't
  touched; the alarm then re-arms for the new expiration from D1. Two runs at
  once can't both clear a status: the second's UPDATE matches nothing and
  announces nothing. No claim is needed: clearing is the whole action.
- A crash after the UPDATE and before the event loses the `user_change` (the
  status still reads as cleared everywhere). Deactivated people are skipped.
- `user_change` carries URLs (avatars), and an alarm has no request: the
  Scheduler keeps the origin of the last `arm()` that passed one in its storage.

## DND hours

### Choosing the method

Slack keeps DND hours in its (undocumented) `users.prefs` and reports them
through `dnd.info`. Two places could set them here: `campflare.prefs.set`
(the activity inbox's notification levels) or a `dnd` method. They're a
**`campflare.dnd.setSchedule`**, because:

- what they change is what the `dnd.*` methods report, and `dnd:write` is the
  scope that already guards silencing a person (`dnd.setSnooze`); a token
  allowed to change notification levels (`prefs:write`, in the `write`
  preset) shouldn't silence someone's nights without `dnd:write`;
- the arguments are a schedule, not a level per conversation;
- their changes are announced with Slack's `dnd_updated` events, like
  snoozing.

### Methods

- **`campflare.dnd.setSchedule`** (xoxp, `dnd:write`): `start` and `end`
  (`HH:MM`, 24-hour; an end at or before the start is the next morning, so
  `22:00`–`08:00` is overnight; equal is refused), `days` (the days a window
  _starts_ on: `mon,wed,fri`, `mon-fri`, `fri-mon`, full names,
  `every_day` (default), `weekdays`, `weekends`), or `enabled=false` to
  clear them. Times are in the person's `tz`. Errors are `invalid_arguments`
  saying which. Answers `dnd.info`'s shape with `dnd_schedule`.
- **`dnd.info`** (`dnd:read`): Slack's `dnd_enabled`, `next_dnd_start_ts`,
  `next_dnd_end_ts` (the window in progress, else the next one; `1` and `1`
  without hours, as Slack) and `snooze_enabled`, `snooze_endtime`,
  `snooze_remaining`, `snooze_is_indefinite`. For the caller only, Campflare
  adds `dnd_schedule: { start, end, days: ["mon", …] } | null`; others see
  the window, not the hours.
- **`dnd.teamInfo`**: the same per person, without `dnd_schedule`.
- **`dnd.endDnd`**: ends do-not-disturb now: the window in progress is skipped
  (the next comes as usual) and a snooze ends. With nothing to end it changes
  nothing. The skip is kept as `users.dnd_skipped_at` (when it was called):
  whichever window holds that instant is skipped, so it stays skipped when the
  zone changes; new hours forget it. The write is guarded on the hours, the
  zone and the skip it computed from; if any changed meanwhile it reads the row
  again and redoes it (up to three times, then `internal_error`), so it never
  answers `ok` without having ended DND. `campflare.dnd.setSchedule` and
  `campflare.users.setTimezone` are guarded and retried the same way.
- **`dnd.setSnooze`**, **`dnd.endSnooze`**: as before; `endSnooze` is one
  guarded UPDATE (`snooze_not_active` when there was none).

### Windows and DST

A window is computed from the wall-clock hours on a date through the zone's
rules (`windowAt()` in `src/api/dnd-hours.ts`, using `zonedTime()`), so
`22:00`–`08:00` stays 22:00 to 08:00 local across DST: in Paris the night of
the autumn change lasts 11 hours and the spring one 9. A window belongs to the
day it starts on: `22:00`–`08:00` on `mon-fri` runs Friday night into Saturday
morning and not Sunday night.

### Notify in SQL

The activity inbox decides `notify` in the INSERT that records items
(`docs/activity.md`); "is now within this person's hours in their zone" isn't
something SQL can say. So the row stores the window in progress or next,
`users.dnd_window_start`/`dnd_window_end` (migration 0027), and `notify()`
adds `NOT (u.dnd_window_start <= now AND now < u.dnd_window_end)`, with no
extra round trip.

The stored window must move on when it ends: setting hours (or the zone, or
`dnd.endDnd` skipping a window) arms the `Scheduler` at the window's end, and
the alarm moves every ended window (`dnd_window_end <= now`) to the person's
next, guarded on the row as read (the window, the hours, the zone), so a change
made meanwhile keeps its own window and two runs move a window once. Each move
sends `dnd_updated` and `dnd_updated_user`, since `next_dnd_*` changed.

Every write of a window (hours, zone, `dnd.endDnd`) arms the Scheduler at its
end, and `nextDue()` always includes the soonest window end of the
workspace's active people, so any arm (a reminder, a status) also finds a
window left behind. Should a window still go stale (the arm call failed, or
the alarm is late), the stored window has ended and items notify until it
moves: a stale window only lets things through, never silences, which is why
`notify()` doesn't guess at "ended but hours set". `dnd.info` and
`dnd.teamInfo` compute the next window themselves when the stored one is over,
so they never report a stale one, and arm the Scheduler (after the response)
so it heals. There is no reactivation path for a deactivated person yet; one
must arm the Scheduler when it writes their row.

### Events

Slack's shapes, sent on every change (hours, zone, snooze, endDnd, a window
moving on):

- `dnd_updated` to the person: `{ user, dnd_status }` with the snooze.
- `dnd_updated_user` to the workspace: `{ user, dnd_status: { dnd_enabled,
next_dnd_start_ts, next_dnd_end_ts } }`, no snooze.

### CLI

- `campflare dnd [--json]`: the hours, whether DND holds now or when next, the
  snooze.
- `campflare dnd hours 22:00-08:00 [--days mon-fri]`, `campflare dnd hours
off` (or `dnd off`), `campflare dnd snooze 30m`, `campflare dnd end`.

## Later

- The app showing a person's DND (a moon on their avatar) and offering to set
  the browser's time zone.
- Recurring snoozes and DND hours that differ by day.

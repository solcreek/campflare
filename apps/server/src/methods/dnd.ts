import { all, run } from "../db/query"
import type { UserRow } from "../db/rows"
import { publish } from "../events"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError } from "../api/errors"
import { nowSeconds } from "../api/ids"

// Do Not Disturb: snoozing only. Scheduled DND hours aren't modelled yet, so
// dnd_enabled reads false and the next window is empty.

function snoozeState(user: Pick<UserRow, "snooze_until">) {
  const now = nowSeconds()
  const snoozed = user.snooze_until > now
  return {
    snooze_enabled: snoozed,
    ...(snoozed
      ? { snooze_endtime: user.snooze_until, snooze_remaining: user.snooze_until - now, snooze_is_indefinite: false }
      : {}),
  }
}

const schedule = { dnd_enabled: false, next_dnd_start_ts: 1, next_dnd_end_ts: 1 }

async function changed(ctx: Ctx<Actor>, user: UserRow) {
  publish(ctx, {
    teamId: ctx.auth.team.id,
    audience: "team",
    event: { type: "dnd_updated_user", user: user.id, dnd_status: { ...schedule, ...snoozeState(user) } },
  })
}

method("dnd.info", "actor", async (ctx) => {
  const id = ctx.args.str("user") ?? ctx.auth.user.id
  const [user] = await all<UserRow>(
    ctx.env.DB,
    "SELECT * FROM users WHERE id = ? AND team_id = ?",
    id,
    ctx.auth.team.id,
  )
  if (!user) throw new CampflareError("user_not_found")
  return { ...schedule, ...snoozeState(user) }
})

method("dnd.teamInfo", "actor", async (ctx) => {
  const ids = ctx.args.list("users")
  const rows = await all<UserRow>(ctx.env.DB, "SELECT * FROM users WHERE team_id = ? AND deleted = 0", ctx.auth.team.id)
  const users = Object.fromEntries(
    rows.filter((u) => ids.length === 0 || ids.includes(u.id)).map((u) => [u.id, { ...schedule, ...snoozeState(u) }]),
  )
  return { users }
})

method("dnd.setSnooze", "user", async (ctx) => {
  const minutes = ctx.args.int("num_minutes", 0, { min: 0 })
  if (minutes <= 0) throw new CampflareError("invalid_num_minutes")
  const until = nowSeconds() + minutes * 60
  await run(ctx.env.DB, "UPDATE users SET snooze_until = ? WHERE id = ?", until, ctx.auth.user.id)
  const user = { ...ctx.auth.user, snooze_until: until }
  await changed(ctx, user)
  return snoozeState(user)
})

method("dnd.endSnooze", "user", async (ctx) => {
  if (ctx.auth.user.snooze_until <= nowSeconds()) throw new CampflareError("snooze_not_active")
  await run(ctx.env.DB, "UPDATE users SET snooze_until = 0 WHERE id = ?", ctx.auth.user.id)
  const user = { ...ctx.auth.user, snooze_until: 0 }
  await changed(ctx, user)
  return { ...schedule, ...snoozeState(user) }
})

method("dnd.endDnd", "user", async () => ({}))

import { all, stmt } from "../db/query"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { nowSeconds, randomId } from "../api/ids"
import { decode } from "../push/base64url"
import { importPublic, isPoint } from "../push/keys"
import { sendPush, vapidOf } from "../push/send"

// Web Push subscriptions (docs/push.md): the browsers a person gets
// notifications in. Delivery is the hub's (src/hub.ts); these only keep the list.

/** A person's devices at most: a 21st replaces their oldest. */
export const MAX_SUBSCRIPTIONS = 20
const MAX_LABEL = 100
const MAX_ENDPOINT = 2048

export interface PushSubscriptionRow {
  id: string
  team_id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  label: string
  created: number
  last_used: number
}

/** The server's VAPID keys, or push_not_configured. */
function requireVapid(ctx: Pick<Ctx, "env" | "origin">) {
  const vapid = vapidOf(ctx.env, ctx.origin)
  if (!vapid) throw new CampflareError("push_not_configured")
  return vapid
}

/** A subscription as the API answers it: never the endpoint, a capability; its push service's host instead. */
function subscriptionJson(row: PushSubscriptionRow) {
  return {
    id: row.id,
    label: row.label,
    service: new URL(row.endpoint).host,
    created: row.created,
    last_used: row.last_used,
  }
}

/** The workspace's hub drops the subscriptions it keeps, to read them again for the next item. */
async function subscriptionsChanged(ctx: Pick<Ctx, "env">, teamIds: string[]) {
  await Promise.all(
    [...new Set(teamIds)].map((t) => ctx.env.HUB.get(ctx.env.HUB.idFromName(t)).pushSubscriptionsChanged()),
  )
}

method("campflare.push.vapidKey", "none", async (ctx) => {
  requireVapid(ctx)
  return { key: ctx.env.VAPID_PUBLIC_KEY!.trim() }
})

/** The endpoint and keys, from `subscription` (PushSubscription.toJSON()) or given one by one. */
async function subscriptionArgs(ctx: Ctx<Actor>) {
  const sub = ctx.args.json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>("subscription")
  const pick = (given: unknown, name: string) => (typeof given === "string" && given ? given : ctx.args.str(name))
  const endpoint = pick(sub?.endpoint, "endpoint")
  const p256dh = pick(sub?.keys?.p256dh, "p256dh")
  const auth = pick(sub?.keys?.auth, "auth")
  if (!endpoint || !p256dh || !auth) throw invalidArguments("subscription needs an endpoint and keys p256dh and auth")
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw invalidArguments("endpoint must be an absolute URL")
  }
  if (url.protocol !== "https:" || endpoint.length > MAX_ENDPOINT) {
    throw invalidArguments("endpoint must be an https URL")
  }
  const point = decode(p256dh)
  const ok =
    isPoint(point) &&
    (await importPublic(point, "ECDH").then(
      () => true,
      () => false,
    ))
  if (!ok) throw invalidArguments("p256dh must be a P-256 public key, uncompressed, base64url")
  if (decode(auth)?.length !== 16) throw invalidArguments("auth must be 16 bytes, base64url")
  return { endpoint, p256dh, auth }
}

method("campflare.push.subscribe", "user", async (ctx) => {
  requireVapid(ctx)
  const { endpoint, p256dh, auth } = await subscriptionArgs(ctx)
  const label = [...(ctx.args.str("label") ?? "").trim()].slice(0, MAX_LABEL).join("")
  const user = ctx.auth.user.id
  const team = ctx.auth.team.id
  const db = ctx.env.DB
  const [before, saved] = await db.batch([
    stmt(db, "SELECT team_id FROM push_subscriptions WHERE endpoint = ?", endpoint),
    // One browser is one row: subscribing it again replaces it (keeping its id, and making it the newest),
    // for whoever is signed in there now.
    stmt(
      db,
      `INSERT OR REPLACE INTO push_subscriptions (id, team_id, user_id, endpoint, p256dh, auth, label, created)
       VALUES (COALESCE((SELECT id FROM push_subscriptions WHERE endpoint = ?4), ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       RETURNING *`,
      randomId("P"),
      team,
      user,
      endpoint,
      p256dh,
      auth,
      label,
      nowSeconds(),
    ),
    stmt(
      db,
      `DELETE FROM push_subscriptions WHERE user_id = ?1 AND id NOT IN
         (SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY created DESC, rowid DESC LIMIT ?2)`,
      user,
      MAX_SUBSCRIPTIONS,
    ),
  ])
  const previous = (before!.results as { team_id: string }[]).map((r) => r.team_id)
  await subscriptionsChanged(ctx, [team, ...previous])
  return { subscription: subscriptionJson(saved!.results[0] as PushSubscriptionRow) }
})

method("campflare.push.unsubscribe", "user", async (ctx) => {
  const id = ctx.args.str("id")
  const endpoint = ctx.args.str("endpoint")
  if (!id && !endpoint) throw invalidArguments("id or endpoint is required")
  const gone = await all<{ id: string }>(
    ctx.env.DB,
    "DELETE FROM push_subscriptions WHERE user_id = ? AND (id = ? OR endpoint = ?) RETURNING id",
    ctx.auth.user.id,
    id ?? null,
    endpoint ?? null,
  )
  if (gone.length === 0) throw new CampflareError("subscription_not_found")
  await subscriptionsChanged(ctx, [ctx.auth.team.id])
  return { removed: gone.map((r) => r.id) }
})

const ownSubscriptions = (ctx: Ctx<Actor>) =>
  all<PushSubscriptionRow>(
    ctx.env.DB,
    "SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created DESC, rowid DESC",
    ctx.auth.user.id,
  )

method("campflare.push.list", "user", async (ctx) => ({
  subscriptions: (await ownSubscriptions(ctx)).map(subscriptionJson),
}))

method("campflare.push.test", "user", async (ctx) => {
  const vapid = requireVapid(ctx)
  const id = ctx.args.str("id")
  const rows = (await ownSubscriptions(ctx)).filter((r) => !id || r.id === id)
  if (id && rows.length === 0) throw new CampflareError("subscription_not_found")
  const outcomes = await Promise.all(
    rows.map((row) =>
      sendPush(vapid, row, {
        payload: {
          title: "Campflare",
          body: row.label ? `Notifications work on ${row.label}.` : "Notifications work on this device.",
          tag: "campflare-test",
          route: "#/",
          type: "test",
        },
        urgency: "high",
      }),
    ),
  )
  const sent = rows.filter((_, i) => outcomes[i]!.ok).map((r) => r.id)
  const removed = rows.filter((_, i) => outcomes[i]!.gone).map((r) => r.id)
  const db = ctx.env.DB
  const writes = [
    ...(sent.length
      ? [
          stmt(
            db,
            "UPDATE push_subscriptions SET last_used = ? WHERE id IN (SELECT value FROM json_each(?))",
            nowSeconds(),
            JSON.stringify(sent),
          ),
        ]
      : []),
    ...(removed.length
      ? [
          stmt(
            db,
            "DELETE FROM push_subscriptions WHERE id IN (SELECT value FROM json_each(?))",
            JSON.stringify(removed),
          ),
        ]
      : []),
  ]
  if (writes.length) await db.batch(writes)
  if (removed.length) await subscriptionsChanged(ctx, [ctx.auth.team.id])
  return {
    sent: sent.length,
    failed: rows.length - sent.length - removed.length,
    removed: removed.length,
    results: rows.map((r, i) => ({
      id: r.id,
      ok: outcomes[i]!.ok,
      status: outcomes[i]!.status,
      ...(outcomes[i]!.gone ? { removed: true } : {}),
    })),
  }
})

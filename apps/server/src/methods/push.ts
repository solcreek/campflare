import { all, first, isUniqueViolation, stmt } from "../db/query"
import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { nowSeconds, randomId } from "../api/ids"
import { decode } from "../push/base64url"
import { importPublic, isPoint } from "../push/keys"
import { sendPush } from "../push/send"
import { loadVapid } from "../push/vapid"

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

/**
 * The push services browsers use: Chrome, Edge and Opera (FCM), Firefox
 * (Mozilla's), Safari (Apple's), and Windows' own. Endpoints elsewhere are
 * refused, so the server can't be pointed at any URL; PUSH_SERVICE_HOSTS adds
 * more (a self-hosted push service), comma-separated, `*.` for subdomains.
 */
export const KNOWN_PUSH_SERVICES = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "*.push.apple.com",
  "*.notify.windows.com",
]

/** Whether a host is a push service we send to: a known one, or one PUSH_SERVICE_HOSTS adds. */
export function isPushService(hostname: string, extra = ""): boolean {
  const host = hostname.toLowerCase()
  const patterns = [
    ...KNOWN_PUSH_SERVICES,
    ...extra
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  ]
  return patterns.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p))
}

/** The server's VAPID keys (checked: the pair must match), or push_not_configured. */
async function requireVapid(ctx: Pick<Ctx, "env" | "origin">) {
  const vapid = await loadVapid(ctx.env, ctx.origin)
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

/**
 * The workspace's hub drops the subscriptions it keeps, to read them again for
 * the next item, and the pending retries of those `removed`.
 */
async function subscriptionsChanged(ctx: Pick<Ctx, "env">, teamIds: string[], removed: string[] = []) {
  await Promise.all(
    [...new Set(teamIds)].map((t) => ctx.env.HUB.get(ctx.env.HUB.idFromName(t)).pushSubscriptionsChanged(removed)),
  )
}

method("campflare.push.vapidKey", "none", async (ctx) => {
  await requireVapid(ctx)
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
  if (!isPushService(url.hostname, ctx.env.PUSH_SERVICE_HOSTS)) {
    throw invalidArguments(`endpoint isn't at a known push service: ${url.hostname}`)
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
  await requireVapid(ctx)
  const { endpoint, p256dh, auth } = await subscriptionArgs(ctx)
  const label = [...(ctx.args.str("label") ?? "").trim()].slice(0, MAX_LABEL).join("")
  const user = ctx.auth.user.id
  const team = ctx.auth.team.id
  const db = ctx.env.DB
  const existing = await first<PushSubscriptionRow>(db, "SELECT * FROM push_subscriptions WHERE endpoint = ?", endpoint)
  if (existing) {
    // One browser is one row, and someone else's isn't taken over: whoever signs out there
    // unsubscribes it (the app does), which deletes the row, and then it's free.
    if (existing.user_id !== user || existing.team_id !== team) throw new CampflareError("endpoint_in_use")
    // The app says it again on every load: unchanged, nothing is written and the hub keeps what it has.
    if (existing.p256dh === p256dh && existing.auth === auth && existing.label === label) {
      return { subscription: subscriptionJson(existing) }
    }
    // New keys or label; created and last_used stay.
    const [updated] = await all<PushSubscriptionRow>(
      db,
      "UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ? WHERE id = ? RETURNING *",
      p256dh,
      auth,
      label,
      existing.id,
    )
    await subscriptionsChanged(ctx, [team])
    return { subscription: subscriptionJson(updated!) }
  }
  let results: D1Result[]
  try {
    results = await db.batch([
      stmt(
        db,
        `INSERT INTO push_subscriptions (id, team_id, user_id, endpoint, p256dh, auth, label, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        randomId("P"),
        team,
        user,
        endpoint,
        p256dh,
        auth,
        label,
        nowSeconds(),
      ),
      // A 21st device replaces the person's oldest.
      stmt(
        db,
        `DELETE FROM push_subscriptions WHERE user_id = ?1 AND id NOT IN
           (SELECT id FROM push_subscriptions WHERE user_id = ?1 ORDER BY created DESC, rowid DESC LIMIT ?2)
         RETURNING id`,
        user,
        MAX_SUBSCRIPTIONS,
      ),
    ])
  } catch (error) {
    // Subscribed meanwhile, by another request.
    if (isUniqueViolation(error)) throw new CampflareError("endpoint_in_use")
    throw error
  }
  const [saved, pruned] = results
  await subscriptionsChanged(
    ctx,
    [team],
    (pruned!.results as { id: string }[]).map((r) => r.id),
  )
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
  await subscriptionsChanged(
    ctx,
    [ctx.auth.team.id],
    gone.map((r) => r.id),
  )
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
  const vapid = await requireVapid(ctx)
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
  // The server's own key failing is its configuration, not the devices'.
  if (outcomes.some((o) => o.misconfigured)) throw new CampflareError("push_not_configured")
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
  if (removed.length) await subscriptionsChanged(ctx, [ctx.auth.team.id], removed)
  return {
    sent: sent.length,
    failed: rows.length - sent.length - removed.length,
    removed: removed.length,
    // What happened, not the push service's status: the answer isn't a probe of other servers.
    results: rows.map((r, i) => ({
      id: r.id,
      result: outcomes[i]!.ok ? "delivered" : outcomes[i]!.gone ? "gone" : "failed",
    })),
  }
})

// Seeds a workspace with people, channels, a thread, reactions, a bot and DMs,
// so a client has something to show. Plain fetch: no build step needed.

export interface Seeded {
  teamId: string
  /** The owner's user token (xoxp-). */
  owner: string
  /** An app installed by the owner: its Socket Mode token (xapp-) and bot token (xoxb-). */
  appToken: string
  botToken: string
  /** Everyone else's user tokens, by handle. */
  people: Record<string, string>
  channels: Record<string, string>
}

type Body = Record<string, unknown> & { ok: boolean; error?: string }

export async function seed(baseUrl: string, secret: string, teamName = "Campflare Dev"): Promise<Seeded> {
  async function call<T = Body>(method: string, args: Record<string, unknown> = {}, token?: string): Promise<T & Body> {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v))
    }
    const res = await fetch(`${baseUrl}/api/${method}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body,
    })
    const data = (await res.json()) as T & Body
    if (!data.ok) throw new Error(`${method} failed: ${data.error}`)
    return data
  }

  const boot = await call<{ token: string; team: { id: string }; general_channel: string }>("campflare.bootstrap", {
    secret,
    team_name: teamName,
    user_name: "alex",
    real_name: "Alex Rivera",
    email: "alex@campflare.test",
  })
  const me = boot.token
  const people: Record<string, { id: string; token: string }> = {}
  for (const [name, real] of [
    ["vincent", "Vincent Vega"],
    ["minjun", "Minjun Park"],
    ["ada", "Ada Lovelace"],
  ] as const) {
    const r = await call<{ user: { id: string }; token: string }>(
      "campflare.users.create",
      { name, real_name: real, email: `${name}@campflare.test` },
      me,
    )
    people[name] = { id: r.user.id, token: r.token }
  }
  const { vincent, minjun, ada } = people as Record<"vincent" | "minjun" | "ada", { id: string; token: string }>
  const app = await call<{ app_token: string; bot_token: string }>(
    "campflare.apps.create",
    { name: "Campflare Dev App" },
    me,
  )
  const ci = await call<{ bot_token: string }>("campflare.apps.create", { name: "CI Bot", bot_name: "ci" }, me)

  const general = boot.general_channel
  const create = async (name: string) =>
    (await call<{ channel: { id: string } }>("conversations.create", { name }, me)).channel.id
  const dev = await create("dev")
  const random = await create("random")
  await call("conversations.setTopic", { channel: dev, topic: "Campflare: the Slack API on Cloudflare" }, me)
  for (const p of [vincent, minjun, ada]) {
    await call("conversations.join", { channel: dev }, p.token)
    await call("conversations.join", { channel: random }, p.token)
  }

  const post = async (token: string, channel: string, text: string, extra: Record<string, unknown> = {}) =>
    (await call<{ ts: string }>("chat.postMessage", { channel, text, ...extra }, token)).ts
  await post(
    me,
    general,
    "Welcome to Campflare 🔥 This workspace runs on Cloudflare Workers, D1, R2 and Durable Objects.",
  )
  await post(vincent.token, general, "Is this really talking to the Slack API?")
  await post(me, general, "Same API, different server. Slack clients only change their base URL.")
  const question = await post(minjun.token, dev, "The deploy to staging failed again, anyone looking?")
  await post(ada.token, dev, "Looking now: the D1 migration ran twice.", { thread_ts: question })
  await post(me, dev, "I'll add a guard to the migration script.", { thread_ts: question })
  await call("reactions.add", { channel: dev, timestamp: question, name: "eyes" }, me)
  await call("reactions.add", { channel: dev, timestamp: question, name: "eyes" }, vincent.token)
  await post(ci.bot_token, dev, "✅ build #128 passed on main (2m 14s)")
  await post(minjun.token, dev, "部署失敗的原因找到了，是 migration 重複執行")
  await post(vincent.token, random, "Anyone up for lunch? 🍜")
  const lunch = await post(ada.token, random, "Count me in")
  await call("reactions.add", { channel: random, timestamp: lunch, name: "raised_hands" }, minjun.token)
  const owner = await call<{ user_id: string }>("auth.test", {}, me)
  await post(vincent.token, owner.user_id, "Hey, can you review my PR when you get a chance?")
  const group = await call<{ channel: { id: string } }>("conversations.open", { users: `${vincent.id},${ada.id}` }, me)
  await post(ada.token, group.channel.id, "Group DMs work too 👋")

  return {
    teamId: boot.team.id,
    owner: me,
    appToken: app.app_token,
    botToken: app.bot_token,
    people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.token])),
    channels: { general, dev, random },
  }
}

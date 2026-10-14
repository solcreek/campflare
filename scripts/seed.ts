// Seeds a workspace with people, channels, a thread, reactions, a bot and DMs,
// so a client has something to show. Plain fetch: no build step needed.

export interface Seeded {
  teamId: string
  /** The owner's user token (xoxp-). */
  owner: string
  /** An app installed by the owner: its Socket Mode token (xapp-) and bot token (xoxb-). */
  appToken: string
  botToken: string
  /** That app's id and signing secret, for the Events API over HTTP (absent in seeds from before it). */
  appId?: string
  signingSecret?: string
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
  const app = await call<{ app: { id: string }; app_token: string; bot_token: string; signing_secret: string }>(
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
  const world = await create("world")
  await call("conversations.setTopic", { channel: dev, topic: "Campflare: the Slack API on Cloudflare" }, me)
  for (const p of [vincent, minjun, ada]) {
    await call("conversations.join", { channel: dev }, p.token)
    await call("conversations.join", { channel: random }, p.token)
    await call("conversations.join", { channel: world }, p.token)
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
  // A message with an image, so clients show files: a PNG drawn here, not a binary in the repo.
  const sunset = await sunsetPng(192, 128)
  const reserved = await call<{ upload_url: string; file_id: string }>(
    "files.getUploadURLExternal",
    { filename: "sunset.png", length: sunset.byteLength, alt_txt: "An orange sunset fading into purple" },
    ada.token,
  )
  const uploaded = await fetch(reserved.upload_url, { method: "POST", body: sunset })
  if (!uploaded.ok) throw new Error(`uploading sunset.png failed: HTTP ${uploaded.status}`)
  await call(
    "files.completeUploadExternal",
    {
      files: [{ id: reserved.file_id, title: "Sunset from the campsite" }],
      channel_id: general,
      initial_comment: "Last night's sunset from the campsite 🌅",
    },
    ada.token,
  )
  await post(vincent.token, random, "Anyone up for lunch? 🍜")
  const lunch = await post(ada.token, random, "Count me in")
  await call("reactions.add", { channel: random, timestamp: lunch, name: "raised_hands" }, minjun.token)
  // One greeting per language, so clients and search get exercised across scripts.
  await call("conversations.setPurpose", { channel: world, purpose: "Messages in many languages" }, me)
  const greetings: [string, string][] = [
    [me, "Good morning, everyone"],
    [minjun.token, "좋은 아침입니다, 여러분"],
    [ada.token, "皆さん、おはようございます"],
    [vincent.token, "大家早安"],
    [minjun.token, "Buenos días a todos"],
    [ada.token, "Bonjour à tous"],
    [vincent.token, "Guten Morgen zusammen"],
  ]
  for (const [token, text] of greetings) await post(token, world, text)
  const owner = await call<{ user_id: string }>("auth.test", {}, me)
  await post(vincent.token, owner.user_id, "Hey, can you review my PR when you get a chance?")
  const group = await call<{ channel: { id: string } }>("conversations.open", { users: `${vincent.id},${ada.id}` }, me)
  await post(ada.token, group.channel.id, "Group DMs work too 👋")

  return {
    teamId: boot.team.id,
    owner: me,
    appToken: app.app_token,
    botToken: app.bot_token,
    appId: app.app.id,
    signingSecret: app.signing_secret,
    people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.token])),
    channels: { general, dev, random, world },
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** A sky going from orange to purple with a low sun: an RGB PNG, deflated with CompressionStream. */
export async function sunsetPng(width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array((width * 3 + 1) * height)
  const sun = { x: width / 2, y: height * 0.7, r: height * 0.18 }
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1) // each row starts with filter type 0
    const t = y / (height - 1)
    for (let x = 0; x < width; x++) {
      const inSun = (x - sun.x) ** 2 + (y - sun.y) ** 2 < sun.r ** 2
      const rgb = inSun ? [255, 214, 102] : [255 - 150 * t, 140 - 90 * t, 60 + 80 * t]
      raw.set(rgb.map(Math.round), row + 1 + x * 3)
    }
  }
  const compressed = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  )
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB, deflate, no filter, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array()),
  ]
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    png.set(p, at)
    at += p.length
  }
  return png
}

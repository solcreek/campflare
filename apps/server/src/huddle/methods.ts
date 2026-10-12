import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { getConversation, requireMember } from "../db/conversations"
import { audienceOf, publish } from "../events"
import type { HuddleParticipant } from "../hub"
import { createSfu, iceServers, SfuError, type SessionDescription, type Sfu } from "./sfu"

// campflare.huddles.* (experiment): audio calls in a conversation, with media
// through Cloudflare Realtime SFU and signalling through our own API and
// events. Each browser keeps two PeerConnections: one publishes its
// microphone (join), one receives everyone else (subscribe/answer).

let sfuFetch: typeof fetch | undefined

/** For tests, which run in the Worker's isolate: answer SFU API calls without the network. */
export function setSfuFetch(fetcher: typeof fetch | undefined) {
  sfuFetch = fetcher
}

function sfuFor(ctx: Ctx<Actor>): Sfu {
  const { REALTIME_APP_ID: appId, REALTIME_APP_SECRET: appSecret } = ctx.env
  if (!appId || !appSecret) throw new CampflareError("huddles_not_configured")
  return createSfu({ appId, appSecret, fetch: sfuFetch })
}

const hub = (ctx: Ctx<Actor>) => ctx.env.HUB.get(ctx.env.HUB.idFromName(ctx.auth.team.id))

/** An SFU failure, as an API error the client can act on. */
async function sfuCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof SfuError) throw new CampflareError("huddle_media_error", { detail: error.code })
    throw error
  }
}

function description(ctx: Ctx<Actor>, type: "offer" | "answer"): SessionDescription {
  const sdp = ctx.args.str("sdp")
  if (!sdp || !sdp.startsWith("v=0")) throw invalidArguments(`sdp must be an SDP ${type}`)
  return { type, sdp }
}

const participantJson = (p: HuddleParticipant) => ({
  user: p.user_id,
  session_id: p.session_id,
  track_name: p.track_name,
  joined: p.joined,
})

async function memberConversation(ctx: Ctx<Actor>) {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireMember(ctx, c)
  return c
}

/** A session the caller owns, in this conversation, of this kind. */
async function ownedSession(ctx: Ctx<Actor>, sessionId: string, kind?: "publish" | "receive") {
  const owner = await hub(ctx).huddleSession(sessionId)
  if (!owner || owner.user_id !== ctx.auth.user.id || (kind && owner.kind !== kind)) {
    throw new CampflareError("huddle_session_not_found")
  }
  return owner
}

method("campflare.huddles.ice_servers", "actor", async (ctx) => {
  return { ice_servers: await iceServers(ctx.env, sfuFetch) }
})

method("campflare.huddles.info", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  return { channel: c.id, participants: (await hub(ctx).huddleList(c.id)).map(participantJson) }
})

/** Publishes the caller's microphone into the conversation's call: their offer in, the SFU's answer out. */
method("campflare.huddles.join", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  const offer = description(ctx, "offer")
  const mid = ctx.args.req("mid")
  const trackName = ctx.args.str("track_name") ?? "audio"
  const sfu = sfuFor(ctx)
  const sessionId = await sfuCall(() => sfu.newSession())
  const published = await sfuCall(() => sfu.publish(sessionId, offer, [{ mid, trackName }]))
  const seat: HuddleParticipant = {
    channel_id: c.id,
    user_id: ctx.auth.user.id,
    session_id: sessionId,
    track_name: trackName,
    mid,
    joined: Date.now(),
  }
  const { previous, others } = await hub(ctx).huddleJoin(seat)
  // Joining again (a reload, another tab) replaces the earlier seat: stop forwarding it.
  if (previous) ctx.waitUntil(sfu.forceClose(previous.session_id, [previous.mid]).catch(() => undefined))
  publish(ctx, {
    teamId: c.team_id,
    audience: await audienceOf(ctx, c.id),
    rtmOnly: true,
    event: { type: "huddle_joined", channel: c.id, ...participantJson(seat) },
  })
  return {
    channel: c.id,
    session_id: sessionId,
    sdp: published.sessionDescription?.sdp,
    participants: others.map(participantJson),
  }
})

/**
 * Receives others' audio. The first call creates the caller's receiving
 * session; later calls add to it. The SFU answers with an offer, which the
 * browser answers through campflare.huddles.answer.
 */
method("campflare.huddles.subscribe", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  const wanted = ctx.args.json<{ session_id?: string; track_name?: string }[]>("publications")
  if (!Array.isArray(wanted) || wanted.length === 0)
    throw invalidArguments("publications must list session_id and track_name")
  const seats = await hub(ctx).huddleList(c.id)
  // Only what is published in this conversation's call, and not your own.
  for (const p of wanted) {
    const seat = seats.find((s) => s.session_id === p.session_id && s.track_name === p.track_name)
    if (!seat || seat.user_id === ctx.auth.user.id) throw new CampflareError("huddle_publication_not_found")
  }
  const sfu = sfuFor(ctx)
  let sessionId = ctx.args.str("session_id")
  if (sessionId) {
    await ownedSession(ctx, sessionId, "receive")
  } else {
    sessionId = await sfuCall(() => sfu.newSession())
    await hub(ctx).huddleOwn(sessionId, ctx.auth.user.id, c.id, "receive")
  }
  const receiving = sessionId
  const res = await sfuCall(() =>
    sfu.subscribe(
      receiving,
      wanted.map((p) => ({ sessionId: p.session_id!, trackName: p.track_name! })),
    ),
  )
  return {
    session_id: receiving,
    sdp: res.sessionDescription?.sdp,
    tracks: (res.tracks ?? []).map((t) => ({ mid: t.mid, session_id: t.sessionId, track_name: t.trackName })),
  }
})

/** The browser's answer to the SFU's offer from subscribe. */
method("campflare.huddles.answer", "actor", async (ctx) => {
  const sessionId = ctx.args.req("session_id")
  await ownedSession(ctx, sessionId, "receive")
  const answer = description(ctx, "answer")
  await sfuCall(() => sfuFor(ctx).renegotiate(sessionId, answer))
  return {}
})

method("campflare.huddles.leave", "actor", async (ctx) => {
  const c = await getConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  const seat = await hub(ctx).huddleLeave(c.id, ctx.auth.user.id)
  if (!seat) return { left: false }
  const sfu = sfuFor(ctx)
  ctx.waitUntil(sfu.forceClose(seat.session_id, [seat.mid]).catch(() => undefined))
  publish(ctx, {
    teamId: c.team_id,
    audience: await audienceOf(ctx, c.id),
    rtmOnly: true,
    event: { type: "huddle_left", channel: c.id, user: seat.user_id, session_id: seat.session_id },
  })
  return { left: true }
})

import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { requireMember, resolveConversation } from "../db/conversations"
import type { ConversationRow } from "../db/rows"
import { audienceOf, publish } from "../events"
import type { HuddleSeat, HuddleTrack } from "../hub"
import { postMessage } from "../db/messages"
import { scribeTicket } from "./ticket"
import { scribeActor, seatScribe } from "./scribe-bot"
import { createSfu, iceServers, SfuError, type Publication, type SessionDescription, type Sfu } from "./sfu"

// campflare.huddles.*: calls in a conversation, with media through
// Cloudflare Realtime SFU and signalling through our own API and events. Each
// browser keeps two PeerConnections: one publishes its microphone and camera
// (join, publish, unpublish), one receives everyone else (subscribe, answer,
// layer). Video is simulcast; each subscriber picks a layer per publication.

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

/**
 * The tracks a browser offers: `tracks` as [{ mid, track_name, kind, rids? }],
 * or, for a single microphone, `mid` (and `track_name`).
 */
function offeredTracks(ctx: Ctx<Actor>): HuddleTrack[] {
  const given = ctx.args.json<{ mid?: unknown; track_name?: unknown; kind?: unknown; rids?: unknown }[]>("tracks")
  if (given === undefined) {
    return [{ name: ctx.args.str("track_name") ?? "audio", kind: "audio", mid: ctx.args.req("mid") }]
  }
  if (!Array.isArray(given) || given.length === 0) throw invalidArguments("tracks must list mid, track_name and kind")
  const tracks = given.map((t) => {
    const ok =
      typeof t.mid === "string" &&
      typeof t.track_name === "string" &&
      /^[\w.-]{1,64}$/.test(t.track_name) &&
      (t.kind === "audio" || t.kind === "video") &&
      (t.rids === undefined ||
        (Array.isArray(t.rids) && t.rids.every((r) => typeof r === "string" && /^[\w-]{1,16}$/.test(r))))
    if (!ok) throw invalidArguments("each track needs mid, track_name (letters, digits, . _ -) and kind audio or video")
    return {
      name: t.track_name as string,
      kind: t.kind as "audio" | "video",
      mid: t.mid as string,
      ...(Array.isArray(t.rids) && t.rids.length ? { rids: t.rids as string[] } : {}),
    }
  })
  if (new Set(tracks.map((t) => t.name)).size !== tracks.length) throw invalidArguments("track names must differ")
  return tracks
}

/** A seat as others see it: what they can subscribe to, not the publisher's transceiver ids. */
const seatJson = (s: HuddleSeat) => ({
  user: s.user_id,
  session_id: s.session_id,
  tracks: s.tracks.map((t) => ({ name: t.name, kind: t.kind, ...(t.rids ? { rids: t.rids } : {}) })),
  joined: s.joined,
})

/** The conversation a `channel` argument names, as chat.postMessage takes it: "#name", an id, or a user id (your DM with them). */
async function memberConversation(ctx: Ctx<Actor>) {
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireMember(ctx, c)
  return c
}

/** A session the caller owns, of this kind. */
async function ownedSession(ctx: Ctx<Actor>, sessionId: string, kind: "publish" | "receive") {
  const owner = await hub(ctx).huddleSession(sessionId)
  if (!owner || owner.user_id !== ctx.auth.user.id || owner.kind !== kind)
    throw new CampflareError("huddle_session_not_found")
  return owner
}

async function seatOrThrow(ctx: Ctx<Actor>, c: ConversationRow) {
  const seat = await hub(ctx).huddleSeat(c.id, ctx.auth.user.id)
  if (!seat) throw new CampflareError("huddle_not_joined")
  return seat
}

async function announce(ctx: Ctx<Actor>, c: ConversationRow, event: Record<string, unknown> & { type: string }) {
  publish(ctx, {
    teamId: c.team_id,
    audience: await audienceOf(ctx, c.id),
    rtmOnly: true,
    event: { channel: c.id, ...event },
  })
}

/**
 * What a subscriber may ask for: publications in this call, not their own,
 * at a layer the track offers. A layer comes with the SFU's fallback to the
 * next one by name if it disappears, and no automatic step-down.
 */
function publications(
  ctx: Ctx<Actor>,
  seats: HuddleSeat[],
  wanted: { session_id?: unknown; track_name?: unknown; rid?: unknown }[],
): Publication[] {
  return wanted.map((p) => {
    const seat = seats.find((s) => s.session_id === p.session_id)
    const track = seat?.tracks.find((t) => t.name === p.track_name)
    if (!seat || !track || seat.user_id === ctx.auth.user.id) throw new CampflareError("huddle_publication_not_found")
    if (p.rid !== undefined && (typeof p.rid !== "string" || !track.rids?.includes(p.rid))) {
      throw new CampflareError("huddle_layer_not_found")
    }
    return {
      sessionId: seat.session_id,
      trackName: track.name,
      ...(typeof p.rid === "string"
        ? { simulcast: { preferredRid: p.rid, priorityOrdering: "none", ridNotAvailable: "asciibetical" } }
        : {}),
    } satisfies Publication
  })
}

method("campflare.huddles.ice_servers", "actor", async (ctx) => {
  return { ice_servers: await iceServers(ctx.env, sfuFetch) }
})

method("campflare.huddles.info", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  return { channel: c.id, participants: (await hub(ctx).huddleList(c.id)).map(seatJson) }
})

/** Publishes the caller's microphone (and camera) into the conversation's call: their offer in, the SFU's answer out. */
method("campflare.huddles.join", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  const offer = description(ctx, "offer")
  const tracks = offeredTracks(ctx)
  const sfu = sfuFor(ctx)
  const sessionId = await sfuCall(() => sfu.newSession())
  const published = await sfuCall(() =>
    sfu.publish(
      sessionId,
      offer,
      tracks.map((t) => ({ mid: t.mid, trackName: t.name })),
    ),
  )
  const seat: HuddleSeat = {
    channel_id: c.id,
    user_id: ctx.auth.user.id,
    session_id: sessionId,
    tracks,
    joined: Date.now(),
  }
  const { previous, others } = await hub(ctx).huddleJoin(seat)
  // Joining again (a reload, another tab) replaces the earlier seat: stop forwarding it.
  if (previous) {
    ctx.waitUntil(
      sfu
        .forceClose(
          previous.session_id,
          previous.tracks.map((t) => t.mid),
        )
        .catch(() => undefined),
    )
  }
  await announce(ctx, c, { type: "huddle_joined", ...seatJson(seat) })
  // Already being transcribed: stream this newcomer too (once their connection is up).
  if ((await scribe(ctx, c).status()).config) ctx.waitUntil(transcribeSeats(ctx, c, sfu, [seat]).catch(() => 0))
  return {
    channel: c.id,
    session_id: sessionId,
    sdp: published.sessionDescription?.sdp,
    participants: others.map(seatJson),
  }
})

/** Adds tracks to the caller's seat (turning a camera on): a fresh offer from their publishing connection. */
method("campflare.huddles.publish", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  const seat = await seatOrThrow(ctx, c)
  const offer = description(ctx, "offer")
  const added = offeredTracks(ctx)
  if (added.some((t) => seat.tracks.some((s) => s.name === t.name)))
    throw invalidArguments("a track by that name is already published")
  const res = await sfuCall(() =>
    sfuFor(ctx).publish(
      seat.session_id,
      offer,
      added.map((t) => ({ mid: t.mid, trackName: t.name })),
    ),
  )
  const updated = (await hub(ctx).huddleSetTracks(c.id, ctx.auth.user.id, [...seat.tracks, ...added]))!
  await announce(ctx, c, { type: "huddle_tracks", ...seatJson(updated) })
  return { sdp: res.sessionDescription?.sdp, tracks: updated.tracks.map((t) => t.name) }
})

/** Stops publishing some tracks (a camera turned off), without renegotiating: the SFU just stops forwarding. */
method("campflare.huddles.unpublish", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  const seat = await seatOrThrow(ctx, c)
  const names = ctx.args.list("track_names")
  const gone = seat.tracks.filter((t) => names.includes(t.name))
  if (gone.length !== names.length || names.length === 0) throw new CampflareError("huddle_track_not_found")
  await sfuCall(() =>
    sfuFor(ctx).forceClose(
      seat.session_id,
      gone.map((t) => t.mid),
    ),
  )
  const updated = (await hub(ctx).huddleSetTracks(
    c.id,
    ctx.auth.user.id,
    seat.tracks.filter((t) => !names.includes(t.name)),
  ))!
  await announce(ctx, c, { type: "huddle_tracks", ...seatJson(updated) })
  return { tracks: updated.tracks.map((t) => t.name) }
})

/**
 * Receives others' tracks, each optionally at a simulcast layer (`rid`). The
 * first call creates the caller's receiving session; later calls add to it.
 * The SFU answers with an offer, which the browser answers through answer.
 */
method("campflare.huddles.subscribe", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  const wanted = ctx.args.json<{ session_id?: unknown; track_name?: unknown; rid?: unknown }[]>("publications")
  if (!Array.isArray(wanted) || wanted.length === 0)
    throw invalidArguments("publications must list session_id and track_name")
  const requested = publications(ctx, await hub(ctx).huddleList(c.id), wanted)
  const sfu = sfuFor(ctx)
  let sessionId = ctx.args.str("session_id")
  if (sessionId) {
    await ownedSession(ctx, sessionId, "receive")
  } else {
    sessionId = await sfuCall(() => sfu.newSession())
    await hub(ctx).huddleOwn(sessionId, ctx.auth.user.id, c.id, "receive")
  }
  const receiving = sessionId
  const res = await sfuCall(() => sfu.subscribe(receiving, requested))
  return {
    session_id: receiving,
    sdp: res.sessionDescription?.sdp,
    tracks: (res.tracks ?? []).map((t) => ({ mid: t.mid, session_id: t.sessionId, track_name: t.trackName })),
  }
})

/** Another simulcast layer for one subscription (by its receiving mid), in place. */
method("campflare.huddles.layer", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  const sessionId = ctx.args.req("session_id")
  await ownedSession(ctx, sessionId, "receive")
  const mid = ctx.args.req("mid")
  const rid = ctx.args.req("rid")
  const [publication] = publications(ctx, await hub(ctx).huddleList(c.id), [
    { session_id: ctx.args.str("publisher_session_id"), track_name: ctx.args.str("track_name"), rid },
  ])
  await sfuCall(() => sfuFor(ctx).update(sessionId, [{ ...publication!, mid }]))
  return {}
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
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  const seat = await hub(ctx).huddleLeave(c.id, ctx.auth.user.id)
  if (!seat) return { left: false }
  const sfu = sfuFor(ctx)
  ctx.waitUntil(
    sfu
      .forceClose(
        seat.session_id,
        seat.tracks.map((t) => t.mid),
      )
      .catch(() => undefined),
  )
  await announce(ctx, c, { type: "huddle_left", user: seat.user_id, session_id: seat.session_id })
  // Transcription follows the call: the leaver's stream ends, and the last one out ends it all.
  const s = scribe(ctx, c)
  if ((await s.status()).config) {
    const adapterId = await s.removeAdapter(seat.user_id)
    if (adapterId) ctx.waitUntil(sfu.closeAdapters([adapterId]).catch(() => undefined))
    if ((await hub(ctx).huddleList(c.id)).length === 0) await stopTranscription(ctx, c, sfu)
  }
  return { left: true }
})

// --- Transcription ---

const scribe = (ctx: Ctx<Actor>, c: ConversationRow) =>
  ctx.env.SCRIBE.get(ctx.env.SCRIBE.idFromName(`${c.team_id}/${c.id}`))

/** Where the SFU connects to stream a speaker: public, since the SFU dials out. */
async function scribeEndpoint(ctx: Ctx<Actor>, c: ConversationRow, user: string) {
  const base = (ctx.env.HUDDLE_PUBLIC_URL || ctx.origin).replace(/\/+$/, "").replace(/^http/, "ws")
  return `${base}/huddle/scribe/${await scribeTicket(ctx.env.SIGNING_KEY, { teamId: c.team_id, channelId: c.id, user })}`
}

/**
 * Streams seats' microphones to the scribe. A seat that just joined may not be
 * connected to the SFU yet, so failed entries are retried a few times, a little
 * later each time, while the request's waitUntil allows.
 */
async function transcribeSeats(
  ctx: Ctx<Actor>,
  c: ConversationRow,
  sfu: Sfu,
  seats: HuddleSeat[],
  attempt = 0,
): Promise<number> {
  const wanted = seats.flatMap((seat) => {
    const mic = seat.tracks.find((t) => t.kind === "audio")
    return mic ? [{ seat, mic }] : []
  })
  let made = 0
  const failed: HuddleSeat[] = []
  // Four entries per request, as the API allows.
  for (let i = 0; i < wanted.length; i += 4) {
    const batch = wanted.slice(i, i + 4)
    const entries = await Promise.all(
      batch.map(async ({ seat, mic }) => ({
        sessionId: seat.session_id,
        trackName: mic.name,
        endpoint: await scribeEndpoint(ctx, c, seat.user_id),
      })),
    )
    const results = await sfu.streamToWebSocket(entries).catch(() => entries.map(() => ({ adapterId: undefined })))
    for (const [k, result] of results.entries()) {
      const seat = batch[k]!.seat
      if (result.adapterId) {
        await scribe(ctx, c).addAdapter(seat.user_id, result.adapterId)
        made++
      } else {
        failed.push(seat)
      }
    }
  }
  if (failed.length && attempt < 5) {
    ctx.waitUntil(
      new Promise((r) => setTimeout(r, 500 * 2 ** attempt)).then(async () => {
        // Still being transcribed, and still in the call?
        if (!(await scribe(ctx, c).status()).config) return
        const present = await hub(ctx).huddleList(c.id)
        await transcribeSeats(
          ctx,
          c,
          sfu,
          present.filter((p) => failed.some((f) => f.user_id === p.user_id)),
          attempt + 1,
        )
      }),
    )
  }
  return made
}

async function stopTranscription(ctx: Ctx<Actor>, c: ConversationRow, sfu: Sfu) {
  const ids = Object.values(await scribe(ctx, c).stop())
  for (let i = 0; i < ids.length; i += 4) ctx.waitUntil(sfu.closeAdapters(ids.slice(i, i + 4)).catch(() => []))
  await announce(ctx, c, { type: "huddle_transcription", active: false })
}

/**
 * Turns transcription of the conversation's call on or off. On: the Huddle
 * Scribe opens a thread, and every microphone in the call (and any that joins
 * later) streams to it; each line it hears is posted there. Off: the streams
 * close. The call's last leaver turns it off too.
 */
method("campflare.huddles.transcribe", "actor", async (ctx) => {
  const c = await memberConversation(ctx)
  if (!ctx.env.CF_ACCOUNT_ID || !ctx.env.WORKERS_AI_TOKEN) throw new CampflareError("transcription_not_configured")
  const enabled = ctx.args.bool("enabled", true)
  const sfu = sfuFor(ctx)
  const s = scribe(ctx, c)
  const { config } = await s.status()
  if (!enabled) {
    if (config) await stopTranscription(ctx, c, sfu)
    return { active: false }
  }
  if (config) return { active: true, thread_ts: config.threadTs }
  const seats = await hub(ctx).huddleList(c.id)
  if (seats.length === 0) throw new CampflareError("huddle_empty")

  const bot = await scribeActor(ctx.env, ctx.auth.team)
  await seatScribe(ctx.env, c.id, bot.user.id)
  const who = ctx.auth.user.display_name || ctx.auth.user.real_name || ctx.auth.user.name
  const parent = await postMessage({ ...ctx, auth: bot }, c, {
    user_id: bot.user.id,
    bot_id: bot.app!.bot_id,
    app_id: bot.app!.id,
    text: `:studio_microphone: Transcript of this call, turned on by ${who}. Each line below is one person speaking.`,
  })
  await s.start({
    teamId: c.team_id,
    channelId: c.id,
    threadTs: parent.row.ts,
    origin: ctx.env.HUDDLE_PUBLIC_URL || ctx.origin,
  })
  const streaming = await transcribeSeats(ctx, c, sfu, seats)
  await announce(ctx, c, { type: "huddle_transcription", active: true, thread_ts: parent.row.ts })
  return { active: true, thread_ts: parent.row.ts, streaming }
})

// /huddle: the experiment's test page. A person pastes a user token, picks a
// conversation, and joins its call: microphone (and camera, simulcast) are
// published through the SFU, and everyone else in the call is received. RTM
// brings joins, leaves and cameras turning on and off. Video layers follow
// the number of tiles and who is speaking.

export const HUDDLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Huddle · Campflare</title>
<style>
  :root { color-scheme: light dark; --fg: #1c1b1a; --bg: #faf9f7; --muted: #6b6560; --accent: #d9480f; --line: #e6e1dc; --ok: #2f9e44; --tile: #2b2926; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f1eeeb; --bg: #1b1a19; --muted: #a39d97; --line: #3a3633; --tile: #0f0e0d; } }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 64rem; margin: 4vh auto; padding: 0 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  .form { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem 1rem; max-width: 40rem; }
  @media (max-width: 40rem) { .form { grid-template-columns: 1fr; } }
  label { display: block; font-weight: 600; margin-bottom: .3rem; }
  input[type=password], input[type=text] { width: 100%; box-sizing: border-box; padding: .5rem .6rem; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  .row { display: flex; gap: .6rem; margin: 1rem 0; flex-wrap: wrap; align-items: center; }
  button { font: inherit; padding: .5rem 1rem; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: var(--muted); margin: 0; }
  #tiles { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); }
  .tile { position: relative; aspect-ratio: 16 / 9; background: var(--tile); border-radius: 10px; overflow: hidden; outline: 3px solid transparent; }
  .tile.speaking { outline-color: var(--ok); }
  .tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tile .name { position: absolute; left: 8px; bottom: 8px; color: #fff; background: rgb(0 0 0 / .55); padding: 1px 8px; border-radius: 6px; font-size: .85rem; }
  .tile .layer { position: absolute; right: 8px; top: 8px; color: #fff; background: rgb(0 0 0 / .55); padding: 0 6px; border-radius: 6px; font-size: .75rem; }
  pre { font-size: .8rem; color: var(--muted); white-space: pre-wrap; }
  #transcript { padding-left: 1.2rem; max-height: 14rem; overflow-y: auto; }
  #transcript li { margin: .2rem 0; } #transcript .lang { color: var(--muted); font-size: .8rem; margin-left: .4rem; }
</style>
</head>
<body><main>
  <h1>Huddle (experiment)</h1>
  <div class="form">
    <div><label for="token">User token</label><input id="token" type="password" autocomplete="off" placeholder="xoxp-…"></div>
    <div><label for="channel">Conversation</label><input id="channel" type="text" placeholder="#general, an id, or a user id for a 1:1 call"></div>
  </div>
  <div class="row">
    <label><input id="with-camera" type="checkbox" checked> Camera</label>
    <button id="join" class="primary">Join</button>
    <button id="mute" disabled>Mute</button>
    <button id="camera" disabled>Camera off</button>
    <button id="transcribe" disabled>Transcribe</button>
    <button id="leave" disabled>Leave</button>
    <p id="status">Not in a call.</p>
  </div>
  <div id="tiles"></div>
  <ol id="transcript" aria-live="polite"></ol>
  <pre id="stats"></pre>
</main>
<script src="/huddle.js" type="module"></script>
</body>
</html>`

export const HUDDLE_JS = `
const $ = (id) => document.getElementById(id)
const ICE_GATHER_MS = 2500
const SIMULCAST = [
  { rid: "f", scaleResolutionDownBy: 1 },
  { rid: "h", scaleResolutionDownBy: 2 },
  { rid: "q", scaleResolutionDownBy: 4 },
]
const state = {
  token: "", channel: "", me: "", names: new Map(), ice: [],
  pub: null, recv: null, recvSession: null, mic: null, camera: null, cameraTx: null, cameraCount: 0,
  rtm: null, seats: new Map(), subs: new Map(), speaker: "", queue: Promise.resolve(), transcriptThread: null,
}
try { $("token").value = sessionStorage.getItem("huddle-token") || "" } catch {}

async function api(method, args = {}) {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(args)) if (v !== undefined) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v))
  const res = await fetch("/api/" + method, { method: "POST", headers: { authorization: "Bearer " + state.token }, body })
  const data = await res.json()
  if (!data.ok) throw new Error(method + ": " + data.error + (data.detail ? " (" + data.detail + ")" : ""))
  return data
}

const status = (text) => ($("status").textContent = text)
const nameOf = (user) => state.names.get(user) || user

/** Waits for ICE gathering (no trickle: the SFU API takes complete SDP), bounded. */
function gathered(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve()
  return new Promise((done) => {
    const timer = setTimeout(done, ICE_GATHER_MS)
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && (clearTimeout(timer), done()))
  })
}

/** One SDP exchange or layer change at a time, as the SFU requires per session. */
const serially = (work) => (state.queue = state.queue.then(work, work))

// --- Tiles ---

function tile(user) {
  let el = document.querySelector('.tile[data-user="' + user + '"]')
  if (el) return el
  el = document.createElement("div")
  el.className = "tile"
  el.dataset.user = user
  el.innerHTML = '<video autoplay playsinline muted></video><span class="name"></span><span class="layer"></span>'
  el.querySelector(".name").textContent = nameOf(user) + (user === state.me ? " (you)" : "")
  $("tiles").append(el)
  return el
}

function dropTile(user) {
  document.querySelector('.tile[data-user="' + user + '"]')?.remove()
  document.querySelectorAll('audio[data-user="' + user + '"]').forEach((a) => a.remove())
}

// --- Layers: the more tiles, the smaller each; the speaker gets a step more. ---

function wantedRid(user) {
  const videos = [...state.subs.values()].filter((s) => s.kind === "video").length
  const base = videos <= 2 ? "f" : videos <= 4 ? "h" : "q"
  if (user !== state.speaker) return base
  return base === "q" ? "h" : "f"
}

async function relayer() {
  for (const sub of state.subs.values()) {
    if (sub.kind !== "video" || !sub.mid) continue
    const rid = wantedRid(sub.user)
    if (rid === sub.rid) continue
    sub.rid = rid
    await serially(() =>
      api("campflare.huddles.layer", {
        channel: state.channel, session_id: state.recvSession, mid: sub.mid,
        publisher_session_id: sub.session_id, track_name: sub.track_name, rid,
      }).catch((e) => console.warn(e.message)),
    )
  }
}

// --- Receiving ---

/**
 * Subscribes to every track of these seats we don't receive yet. A newcomer's
 * tracks only exist at the SFU once their connection is up, which can be just
 * after we hear huddle_joined: the SFU then answers not_found_track_error, and
 * we try again shortly.
 */
async function receive(seats, attempt = 0) {
  const fresh = []
  for (const seat of seats) {
    if (seat.user === state.me) continue
    for (const t of seat.tracks) {
      const key = seat.session_id + "/" + t.name
      if (state.subs.has(key)) continue
      const sub = { key, user: seat.user, session_id: seat.session_id, track_name: t.name, kind: t.kind, mid: null, rid: t.rids ? "q" : undefined }
      state.subs.set(key, sub)
      fresh.push(sub)
    }
  }
  if (!fresh.length) return
  for (const sub of fresh) if (sub.rid) sub.rid = wantedRid(sub.user)
  try {
    await serially(async () => {
      const res = await api("campflare.huddles.subscribe", {
        channel: state.channel, session_id: state.recvSession ?? undefined,
        publications: fresh.map((s) => ({ session_id: s.session_id, track_name: s.track_name, ...(s.rid ? { rid: s.rid } : {}) })),
      })
      state.recvSession = res.session_id
      for (const t of res.tracks) {
        const sub = state.subs.get(t.session_id + "/" + t.track_name)
        if (sub) sub.mid = t.mid
      }
      await state.recv.setRemoteDescription({ type: "offer", sdp: res.sdp })
      await state.recv.setLocalDescription(await state.recv.createAnswer())
      await gathered(state.recv)
      await api("campflare.huddles.answer", { session_id: res.session_id, sdp: state.recv.localDescription.sdp })
    })
  } catch (error) {
    for (const sub of fresh) state.subs.delete(sub.key)
    const notYet = String(error.message).includes("not_found_track_error")
    if (!notYet || attempt >= 12 || !state.recv) return console.warn(error.message)
    // The publisher is still connecting: 250 ms, 500 ms… up to a second apart, about 10 s in all.
    const later = seats.filter((seat) => fresh.some((sub) => sub.user === seat.user)).map((seat) => state.seats.get(seat.user) ?? seat)
    setTimeout(() => receive(later, attempt + 1), Math.min(1000, 250 * 2 ** attempt))
    return
  }
  relayer()
}

/** A seat changed (cameras on or off): drop what it no longer publishes, receive what's new. */
function seatChanged(seat) {
  state.seats.set(seat.user, seat)
  const published = new Set(seat.tracks.map((t) => seat.session_id + "/" + t.name))
  for (const [key, sub] of state.subs) {
    if (sub.user !== seat.user || published.has(key)) continue
    state.subs.delete(key)
    if (sub.kind === "video") tile(seat.user).querySelector("video").srcObject = null
  }
  tile(seat.user)
  receive([seat])
}

function onTrack(e) {
  const sub = [...state.subs.values()].find((s) => s.mid === e.transceiver.mid)
  if (!sub) return
  if (sub.kind === "video") {
    tile(sub.user).querySelector("video").srcObject = new MediaStream([e.track])
  } else {
    // One audio element per person: a later track for them (a retry, a renegotiation) replaces it.
    let audio = document.querySelector('audio[data-user="' + sub.user + '"]')
    if (!audio) {
      audio = new Audio()
      audio.autoplay = true
      audio.dataset.user = sub.user
      document.body.append(audio)
    }
    audio.srcObject = new MediaStream([e.track])
  }
}

// --- Publishing ---

function cameraTrackInfo(tx, name) {
  return { mid: tx.mid, track_name: name, kind: "video", rids: SIMULCAST.map((e) => e.rid) }
}

async function startCamera() {
  state.camera = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } })
  tile(state.me).querySelector("video").srcObject = state.camera
  // A fresh transceiver and name each time: a force-closed track is not reused.
  state.cameraCount++
  state.cameraName = "camera-" + state.cameraCount
  state.cameraTx = state.pub.addTransceiver(state.camera.getVideoTracks()[0], { direction: "sendonly", sendEncodings: SIMULCAST })
  return state.cameraTx
}

async function join() {
  state.token = $("token").value.trim()
  try { sessionStorage.setItem("huddle-token", state.token) } catch {}
  $("join").disabled = true
  try {
    status("Joining…")
    state.me = (await api("auth.test")).user_id
    // The API takes "#name", an id or a user id; events name the conversation by id, so learn it first.
    state.channel = (await api("campflare.huddles.info", { channel: $("channel").value.trim() })).channel
    const { members } = await api("users.list", { limit: 1000 })
    state.names = new Map(members.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name]))
    state.ice = (await api("campflare.huddles.ice_servers")).ice_servers

    // Events first, so no join between ours and our subscribe is missed.
    const { url } = await api("rtm.connect")
    state.rtm = new WebSocket(url)
    state.rtm.onmessage = (e) => {
      const ev = JSON.parse(e.data)
      if (ev.channel !== state.channel) return
      if (ev.type === "huddle_transcription") return transcribing(ev.active ? ev.thread_ts : null)
      if (ev.type === "message" && ev.metadata?.event_type === "huddle_transcript") return transcriptLine(ev.metadata.event_payload)
      if (ev.user === state.me) return
      if (ev.type === "huddle_joined" || ev.type === "huddle_tracks") seatChanged(ev)
      else if (ev.type === "huddle_left") {
        state.seats.delete(ev.user)
        for (const [key, sub] of state.subs) if (sub.user === ev.user) state.subs.delete(key)
        dropTile(ev.user)
        relayer()
      }
    }

    state.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    state.pub = new RTCPeerConnection({ iceServers: state.ice, bundlePolicy: "max-bundle" })
    const micTx = state.pub.addTransceiver(state.mic.getAudioTracks()[0], { direction: "sendonly" })
    const tracks = [{ mid: null, track_name: "audio", kind: "audio" }]
    const camTx = $("with-camera").checked ? await startCamera() : null
    await state.pub.setLocalDescription(await state.pub.createOffer())
    await gathered(state.pub)
    tracks[0].mid = micTx.mid
    if (camTx) tracks.push(cameraTrackInfo(camTx, state.cameraName))
    const joined = await api("campflare.huddles.join", { channel: state.channel, sdp: state.pub.localDescription.sdp, tracks })
    await state.pub.setRemoteDescription({ type: "answer", sdp: joined.sdp })

    state.recv = new RTCPeerConnection({ iceServers: state.ice, bundlePolicy: "max-bundle" })
    state.recv.ontrack = onTrack
    tile(state.me)
    for (const seat of joined.participants) { state.seats.set(seat.user, seat); tile(seat.user) }
    await receive(joined.participants)
    status("In the call.")
    for (const id of ["leave", "mute", "camera", "transcribe"]) $(id).disabled = false
    $("camera").textContent = state.camera ? "Camera off" : "Camera on"
    window.huddle = state // for tests and poking around
  } catch (error) {
    status(String(error.message || error))
    $("join").disabled = false
  }
}

async function toggleCamera() {
  $("camera").disabled = true
  try {
    if (state.camera) {
      await api("campflare.huddles.unpublish", { channel: state.channel, track_names: state.cameraName })
      await state.cameraTx.sender.replaceTrack(null)
      state.camera.getTracks().forEach((t) => t.stop())
      state.camera = null
      tile(state.me).querySelector("video").srcObject = null
    } else {
      const tx = await startCamera()
      await state.pub.setLocalDescription(await state.pub.createOffer())
      await gathered(state.pub)
      const res = await api("campflare.huddles.publish", { channel: state.channel, sdp: state.pub.localDescription.sdp, tracks: [cameraTrackInfo(tx, state.cameraName)] })
      await state.pub.setRemoteDescription({ type: "answer", sdp: res.sdp })
    }
    $("camera").textContent = state.camera ? "Camera off" : "Camera on"
  } catch (error) {
    status(String(error.message || error))
  } finally {
    $("camera").disabled = false
  }
}

function toggleMute() {
  const track = state.mic?.getAudioTracks()[0]
  if (!track) return
  track.enabled = !track.enabled
  $("mute").textContent = track.enabled ? "Mute" : "Unmute"
}

// --- Transcription: the Huddle Scribe posts each line in a thread; we show them as they come. ---

function transcribing(threadTs) {
  state.transcriptThread = threadTs
  $("transcribe").textContent = threadTs ? "Stop transcribing" : "Transcribe"
}

function transcriptLine(line) {
  const li = document.createElement("li")
  const who = document.createElement("strong")
  who.textContent = nameOf(line.user) + ": "
  const lang = document.createElement("span")
  lang.className = "lang"
  lang.textContent = line.language || ""
  li.append(who, document.createTextNode(line.text), lang)
  $("transcript").append(li)
  li.scrollIntoView({ block: "nearest" })
}

async function toggleTranscription() {
  $("transcribe").disabled = true
  try {
    const res = await api("campflare.huddles.transcribe", { channel: state.channel, enabled: !state.transcriptThread })
    transcribing(res.active ? res.thread_ts : null)
  } catch (error) {
    status(String(error.message || error))
  } finally {
    $("transcribe").disabled = false
  }
}

async function leave() {
  $("leave").disabled = true
  await api("campflare.huddles.leave", { channel: state.channel }).catch(() => {})
  for (const pc of [state.pub, state.recv]) pc?.close()
  for (const stream of [state.mic, state.camera]) stream?.getTracks().forEach((t) => t.stop())
  state.rtm?.close()
  $("tiles").replaceChildren()
  document.querySelectorAll("audio").forEach((a) => a.remove())
  Object.assign(state, { pub: null, recv: null, recvSession: null, mic: null, camera: null, cameraTx: null, rtm: null, speaker: "", queue: Promise.resolve() })
  state.seats.clear(); state.subs.clear()
  status("Not in a call.")
  for (const id of ["mute", "camera", "transcribe"]) $(id).disabled = true
  transcribing(null)
  $("transcript").replaceChildren()
  $("join").disabled = false
}

// Closing the tab leaves too: sendBeacon can't set headers, so the token rides in the form.
addEventListener("pagehide", () => {
  if (!state.pub) return
  const form = new FormData(); form.set("token", state.token); form.set("channel", state.channel)
  navigator.sendBeacon("/api/campflare.huddles.leave", form)
})

/** Once a second: connection health, who is speaking (and so the layers), and what each tile receives. */
setInterval(async () => {
  if (!state.pub) return
  const lines = []
  const video = []
  let loudest = { user: "", level: 0.02 }
  for (const [name, pc] of [["send", state.pub], ["receive", state.recv]]) {
    if (!pc) continue
    let rtt = "", packets = 0
    for (const s of (await pc.getStats()).values()) {
      if (s.type === "candidate-pair" && s.nominated && s.currentRoundTripTime !== undefined) rtt = Math.round(s.currentRoundTripTime * 1000) + " ms RTT"
      if (s.type === "outbound-rtp") packets += s.packetsSent || 0
      if (s.type !== "inbound-rtp") continue
      packets += s.packetsReceived || 0
      const sub = [...state.subs.values()].find((x) => x.mid === s.mid)
      if (!sub) continue
      if (s.kind === "audio" && (s.audioLevel || 0) > loudest.level) loudest = { user: sub.user, level: s.audioLevel }
      if (s.kind === "video") {
        video.push({ user: sub.user, rid: sub.rid, width: s.frameWidth || 0, frames: s.framesDecoded || 0 })
        const label = document.querySelector('.tile[data-user="' + sub.user + '"] .layer')
        if (label) label.textContent = (s.frameWidth ? s.frameWidth + "p" : "") + (sub.rid ? " " + sub.rid : "")
      }
    }
    lines.push(name + ": " + pc.connectionState + (rtt ? ", " + rtt : "") + ", " + packets + " packets")
  }
  if (loudest.user && loudest.user !== state.speaker) {
    state.speaker = loudest.user
    document.querySelectorAll(".tile").forEach((t) => t.classList.toggle("speaking", t.dataset.user === state.speaker))
    relayer()
  }
  $("stats").textContent = lines.join("\\n")
  window.huddleStats = lines
  window.huddleVideo = video
}, 1000)

$("join").onclick = join
$("leave").onclick = leave
$("mute").onclick = toggleMute
$("camera").onclick = toggleCamera
$("transcribe").onclick = toggleTranscription
`

const SECURITY = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
}

export const huddlePage = () =>
  new Response(HUDDLE_HTML, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY } })
export const huddleScript = () =>
  new Response(HUDDLE_JS, { headers: { "content-type": "text/javascript; charset=utf-8", ...SECURITY } })

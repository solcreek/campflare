// /huddle: the experiment's test page. A person pastes a user token, picks a
// conversation, and joins its call: the microphone is published through the
// SFU, and everyone else in the call is received. RTM brings joins and leaves.

export const HUDDLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Huddle · Campflare</title>
<style>
  :root { color-scheme: light dark; --fg: #1c1b1a; --bg: #faf9f7; --muted: #6b6560; --accent: #d9480f; --line: #e6e1dc; --ok: #2f9e44; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f1eeeb; --bg: #1b1a19; --muted: #a39d97; --line: #3a3633; } }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  main { max-width: 40rem; margin: 6vh auto; padding: 0 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  label { display: block; font-weight: 600; margin: .8rem 0 .3rem; }
  input { width: 100%; box-sizing: border-box; padding: .5rem .6rem; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  .row { display: flex; gap: .6rem; margin-top: 1rem; flex-wrap: wrap; }
  button { font: inherit; padding: .5rem 1rem; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; padding: 0; } li { padding: .5rem 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 1rem; }
  .meter { display: inline-block; width: 6rem; height: .5rem; border-radius: 4px; background: var(--line); vertical-align: middle; overflow: hidden; }
  .meter > span { display: block; height: 100%; width: 0; background: var(--ok); }
  #status { color: var(--muted); } pre { font-size: .8rem; color: var(--muted); white-space: pre-wrap; }
</style>
</head>
<body><main>
  <h1>Huddle (experiment)</h1>
  <label for="token">User token</label>
  <input id="token" type="password" autocomplete="off" placeholder="xoxp-…">
  <label for="channel">Conversation</label>
  <input id="channel" placeholder="#general, an id, or a user id for a 1:1 call">
  <div class="row">
    <button id="join" class="primary">Join with microphone</button>
    <button id="leave" disabled>Leave</button>
  </div>
  <p id="status">Not in a call.</p>
  <ul id="people"></ul>
  <pre id="stats"></pre>
</main>
<script src="/huddle.js" type="module"></script>
</body>
</html>`

export const HUDDLE_JS = `
const $ = (id) => document.getElementById(id)
const state = { token: "", channel: "", me: "", pub: null, recv: null, recvSession: null, mic: null, rtm: null, people: new Map(), midToUser: new Map(), queue: Promise.resolve() }
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

/** Waits for ICE gathering (no trickle: the SFU API takes complete SDP), bounded. */
function gathered(pc, ms = 2500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve()
  return new Promise((done) => {
    const timer = setTimeout(done, ms)
    pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && (clearTimeout(timer), done()))
  })
}

/** One SDP exchange at a time on the receiving session, as the SFU requires. */
const serially = (work) => (state.queue = state.queue.then(work, work))

function render() {
  const ul = $("people")
  ul.replaceChildren(...[...state.people.values()].map((p) => {
    const li = document.createElement("li")
    li.dataset.user = p.user
    li.innerHTML = '<span class="who"></span><span><span class="meter"><span></span></span></span>'
    li.querySelector(".who").textContent = p.name + (p.user === state.me ? " (you)" : "")
    return li
  }))
}

async function receive(publications) {
  const fresh = publications.filter((p) => p.user !== state.me)
  if (!fresh.length) return
  await serially(async () => {
    const wanted = fresh.flatMap((p) => p.tracks.filter((t) => t.kind === "audio").map((t) => ({ session_id: p.session_id, track_name: t.name })))
    if (!wanted.length) return
    const sub = await api("campflare.huddles.subscribe", { channel: state.channel, session_id: state.recvSession ?? undefined, publications: wanted })
    state.recvSession = sub.session_id
    for (const t of sub.tracks) state.midToUser.set(t.mid, fresh.find((p) => p.session_id === t.session_id)?.user)
    await state.recv.setRemoteDescription({ type: "offer", sdp: sub.sdp })
    await state.recv.setLocalDescription(await state.recv.createAnswer())
    await gathered(state.recv)
    await api("campflare.huddles.answer", { session_id: sub.session_id, sdp: state.recv.localDescription.sdp })
  })
}

async function names() {
  const { members } = await api("users.list", { limit: 1000 })
  return new Map(members.map((u) => [u.id, u.profile?.display_name || u.real_name || u.name]))
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
    const who = await names()
    const { ice_servers } = await api("campflare.huddles.ice_servers")

    // Events first, so no join between our join and our subscribe is missed.
    const { url } = await api("rtm.connect")
    state.rtm = new WebSocket(url)
    state.rtm.onmessage = (e) => {
      const ev = JSON.parse(e.data)
      if (ev.channel !== state.channel) return
      if (ev.type === "huddle_joined" && ev.user !== state.me) {
        state.people.set(ev.user, { ...ev, name: who.get(ev.user) || ev.user }); render(); receive([ev])
      } else if (ev.type === "huddle_left") {
        state.people.delete(ev.user); render()
      }
    }

    state.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    state.pub = new RTCPeerConnection({ iceServers: ice_servers, bundlePolicy: "max-bundle" })
    const tx = state.pub.addTransceiver(state.mic.getAudioTracks()[0], { direction: "sendonly" })
    await state.pub.setLocalDescription(await state.pub.createOffer())
    await gathered(state.pub)
    const joined = await api("campflare.huddles.join", { channel: state.channel, sdp: state.pub.localDescription.sdp, mid: tx.mid })
    await state.pub.setRemoteDescription({ type: "answer", sdp: joined.sdp })

    state.recv = new RTCPeerConnection({ iceServers: ice_servers, bundlePolicy: "max-bundle" })
    state.recv.ontrack = (e) => {
      const audio = new Audio()
      audio.autoplay = true
      audio.srcObject = new MediaStream([e.track])
      audio.dataset.user = state.midToUser.get(e.transceiver.mid) ?? ""
      document.body.append(audio)
      e.track.addEventListener("ended", () => audio.remove())
    }

    state.people.set(state.me, { user: state.me, name: who.get(state.me) || "me" })
    for (const p of joined.participants) state.people.set(p.user, { ...p, name: who.get(p.user) || p.user })
    render()
    await receive(joined.participants)
    status("In the call.")
    $("leave").disabled = false
    window.huddle = state // for tests and poking around
  } catch (error) {
    status(String(error.message || error))
    $("join").disabled = false
  }
}

async function leave() {
  $("leave").disabled = true
  await api("campflare.huddles.leave", { channel: state.channel }).catch(() => {})
  for (const pc of [state.pub, state.recv]) pc?.close()
  state.mic?.getTracks().forEach((t) => t.stop())
  state.rtm?.close()
  document.querySelectorAll("audio").forEach((a) => a.remove())
  Object.assign(state, { pub: null, recv: null, recvSession: null, mic: null, rtm: null, queue: Promise.resolve() })
  state.people.clear(); state.midToUser.clear(); render()
  status("Not in a call.")
  $("join").disabled = false
}

// Closing the tab leaves too: sendBeacon can't set headers, so the token rides in the form.
addEventListener("pagehide", () => {
  if (!state.pub) return
  const form = new FormData(); form.set("token", state.token); form.set("channel", state.channel)
  navigator.sendBeacon("/api/campflare.huddles.leave", form)
})

/** Connection state, round-trip time and audio levels, once a second. */
setInterval(async () => {
  if (!state.pub) return
  const lines = []
  for (const [name, pc] of [["send", state.pub], ["receive", state.recv]]) {
    if (!pc) continue
    let rtt = "", packets = 0
    const levels = new Map()
    for (const s of (await pc.getStats()).values()) {
      if (s.type === "candidate-pair" && s.nominated && s.currentRoundTripTime !== undefined) rtt = Math.round(s.currentRoundTripTime * 1000) + " ms RTT"
      if (s.type === "inbound-rtp" && s.kind === "audio") { packets += s.packetsReceived || 0; levels.set(s.mid, s.audioLevel || 0) }
      if (s.type === "outbound-rtp" && s.kind === "audio") packets += s.packetsSent || 0
    }
    lines.push(name + ": " + pc.connectionState + (rtt ? ", " + rtt : "") + ", " + packets + " packets")
    for (const [mid, level] of levels) {
      const meter = document.querySelector('li[data-user="' + state.midToUser.get(mid) + '"] .meter > span')
      if (meter) meter.style.width = Math.min(100, Math.round(Math.sqrt(level) * 140)) + "%"
    }
  }
  $("stats").textContent = lines.join("\\n")
  window.huddleStats = lines
}, 1000)

$("join").onclick = join
$("leave").onclick = leave
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

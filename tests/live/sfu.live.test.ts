import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from "werift"
import { describe, expect, it } from "vitest"
import { createSfu, iceServers } from "../../apps/server/src/huddle/sfu.ts"
import { devVars } from "./env.ts"

// Real Cloudflare Realtime SFU, real WebRTC (werift in Node): Alice publishes
// audio, Bob subscribes, and RTP must arrive at Bob. With RECORD_FIXTURES=1
// every SFU exchange is saved for the offline tests' fake SFU.

const env = devVars()
const configured = Boolean(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET)
const FIXTURES = resolve(import.meta.dirname, "../../apps/server/test/fixtures/sfu")

/**
 * Addresses in SDP (this machine's, and the SFU's) give way to documentation
 * addresses in the fixtures. Only candidate and connection lines: the
 * fingerprint line also looks like hex separated by colons.
 */
const scrub = (text: string) =>
  text.replace(/(a=candidate:[^\\]*|c=IN IP[46] [^\\]*)/g, (line) =>
    line
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (ip.startsWith("192.0.2.") ? ip : "192.0.2.1"))
      .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, "2001:db8::1"),
  )

function recordingFetch(record: { operation: string; request?: unknown; status: number; response: unknown }[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const res = await fetch(input, init)
    const body = await res
      .clone()
      .json()
      .catch(() => undefined)
    const operation = `${init?.method ?? "GET"} ${url.replace(/^.*\/apps\/[^/]+/, "").replace(/\/sessions\/[^/]+\//, "/sessions/{id}/")}`
    record.push({
      operation,
      request: init?.body ? JSON.parse(String(init.body)) : undefined,
      status: res.status,
      response: body,
    })
    return res
  }
}

async function gathered(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") return
  await new Promise<void>((done) => pc.iceGatheringStateChange.subscribe((s) => s === "complete" && done()))
}

async function connected(pc: RTCPeerConnection, ms = 15_000) {
  if (pc.connectionState === "connected") return
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`not connected: ${pc.connectionState}`)), ms)
    pc.connectionStateChange.subscribe((s) => {
      if (s === "connected") {
        clearTimeout(timer)
        done()
      } else if (s === "failed") fail(new Error("connection failed"))
    })
  })
}

describe.skipIf(!configured)("Realtime SFU (live)", () => {
  it("carries audio from a publisher to a subscriber", async () => {
    const record: Parameters<typeof recordingFetch>[0] = []
    const sfu = createSfu({
      appId: env.REALTIME_APP_ID!,
      appSecret: env.REALTIME_APP_SECRET!,
      fetch: recordingFetch(record),
    })
    const ice = await iceServers(env)
    const config = { iceServers: ice.map((s) => ({ ...s, urls: Array.isArray(s.urls) ? s.urls[0]! : s.urls })) }

    // Alice: a sendonly audio transceiver, offered to the SFU.
    const alice = new RTCPeerConnection(config)
    const mic = new MediaStreamTrack({ kind: "audio" })
    const transceiver = alice.addTransceiver(mic, { direction: "sendonly" })
    await alice.setLocalDescription(await alice.createOffer())
    await gathered(alice)
    const aliceSession = await sfu.newSession()
    const published = await sfu.publish(aliceSession, { type: "offer", sdp: alice.localDescription!.sdp }, [
      { mid: transceiver.mid!, trackName: "audio" },
    ])
    expect(published.sessionDescription?.type).toBe("answer")
    await alice.setRemoteDescription(published.sessionDescription!)
    await connected(alice)

    // Opus silence frames, every 20 ms, so the SFU has packets to forward.
    const payloadType = transceiver.codecs[0]!.payloadType
    let seq = 0
    const sending = setInterval(() => {
      mic.writeRtp(
        new RtpPacket(
          new RtpHeader({ payloadType, sequenceNumber: seq++ & 0xffff, timestamp: seq * 960, marker: false }),
          Buffer.from([0xf8, 0xff, 0xfe]),
        ),
      )
    }, 20)

    try {
      // Bob: subscribes; the SFU offers, Bob answers.
      const bob = new RTCPeerConnection(config)
      // An object: the RTP callback counts, the loop below reads.
      const received = { packets: 0 }
      bob.onTrack.subscribe((track) => track.onReceiveRtp.subscribe(() => received.packets++))
      const bobSession = await sfu.newSession()
      const offer = await sfu.subscribe(bobSession, [{ sessionId: aliceSession, trackName: "audio" }])
      expect(offer.sessionDescription?.type).toBe("offer")
      expect(offer.requiresImmediateRenegotiation).toBe(true)
      expect(offer.tracks?.[0]).toMatchObject({ sessionId: aliceSession, trackName: "audio", mid: expect.any(String) })
      await bob.setRemoteDescription(offer.sessionDescription!)
      await bob.setLocalDescription(await bob.createAnswer())
      await gathered(bob)
      await sfu.renegotiate(bobSession, { type: "answer", sdp: bob.localDescription!.sdp })
      await connected(bob)

      for (let i = 0; i < 100 && received.packets < 10; i++) await new Promise((r) => setTimeout(r, 100))
      expect(received.packets).toBeGreaterThanOrEqual(10)

      // Errors as the real API gives them, for the fixtures.
      await sfu.subscribe(bobSession, [{ sessionId: aliceSession, trackName: "no-such-track" }]).catch(() => undefined)
      await sfu.renegotiate("0000000000000000", { type: "answer", sdp: "v=0" }).catch(() => undefined)

      await sfu.forceClose(aliceSession, [transceiver.mid!])
      await bob.close()
    } finally {
      clearInterval(sending)
      await alice.close()
    }

    if (env.RECORD_FIXTURES) {
      mkdirSync(FIXTURES, { recursive: true })
      writeFileSync(resolve(FIXTURES, "exchanges.json"), `${scrub(JSON.stringify(record, null, 2))}\n`)
    }
  })
})

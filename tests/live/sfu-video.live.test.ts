import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Browser, Page } from "playwright-core"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { createSfu } from "../../apps/server/src/huddle/sfu.ts"
import { launchChrome, mediaPage, until } from "./browser.ts"
import { devVars } from "./env.ts"
import { recordingFetch, scrub } from "./record.ts"

// Simulcast against the real SFU: Chrome publishes a 1280×720 camera in
// three encodings (f, h, q), another Chrome tab receives it, and switching
// the subscription's layer with tracks/update must change the received
// resolution. Node is the backend here, so every SFU exchange is recorded
// (RECORD_FIXTURES=1) for the offline fake SFU.

const env = devVars()
const configured = Boolean(env.REALTIME_APP_ID && env.REALTIME_APP_SECRET)
const FIXTURES = resolve(import.meta.dirname, "../../apps/server/test/fixtures/sfu")

let browser: Browser
beforeAll(async () => {
  if (configured) browser = await launchChrome()
})
afterAll(async () => browser?.close())

declare global {
  interface Window {
    pc: RTCPeerConnection
  }
}

/** Waits for ICE gathering in the page, so its SDP is complete. */
const gatheredSdp = (page: Page) =>
  page.evaluate(async () => {
    const pc = window.pc
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, 3000)
        pc.addEventListener(
          "icegatheringstatechange",
          () => pc.iceGatheringState === "complete" && (clearTimeout(timer), done()),
        )
      })
    }
    return pc.localDescription!.sdp
  })

const receivedWidth = (page: Page) =>
  page.evaluate(async () => {
    for (const s of (await window.pc.getStats()).values()) {
      if (s.type === "inbound-rtp" && s.kind === "video")
        return { width: s.frameWidth ?? 0, frames: s.framesDecoded ?? 0 }
    }
    return { width: 0, frames: 0 }
  })

describe.skipIf(!configured)("Realtime SFU simulcast (live)", () => {
  it("serves the layer a subscriber asks for, and switches it in place", async () => {
    const record: Parameters<typeof recordingFetch>[0] = []
    const sfu = createSfu({
      appId: env.REALTIME_APP_ID!,
      appSecret: env.REALTIME_APP_SECRET!,
      fetch: recordingFetch(record),
    })
    const base = inject("baseUrl")

    // Publisher: a camera in three encodings.
    const publisher = await mediaPage(browser, `${base}/huddle`)
    const mid = await publisher.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } })
      window.pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        bundlePolicy: "max-bundle",
      })
      const tx = window.pc.addTransceiver(stream.getVideoTracks()[0]!, {
        direction: "sendonly",
        sendEncodings: [
          { rid: "f", scaleResolutionDownBy: 1 },
          { rid: "h", scaleResolutionDownBy: 2 },
          { rid: "q", scaleResolutionDownBy: 4 },
        ],
      })
      await window.pc.setLocalDescription(await window.pc.createOffer())
      return tx.mid!
    })
    const offer = await gatheredSdp(publisher)
    expect(offer).toContain("a=simulcast:send")
    const pubSession = await sfu.newSession()
    const published = await sfu.publish(pubSession, { type: "offer", sdp: offer }, [{ mid, trackName: "camera" }])
    await publisher.evaluate(
      (sdp) => window.pc.setRemoteDescription({ type: "answer", sdp }),
      published.sessionDescription!.sdp,
    )

    // Subscriber: asks for the full layer first.
    const subscriber = await mediaPage(browser, `${base}/huddle`)
    await subscriber.evaluate(() => {
      window.pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        bundlePolicy: "max-bundle",
      })
    })
    const subSession = await sfu.newSession()
    const preference = { priorityOrdering: "none", ridNotAvailable: "asciibetical" } as const
    const sub = await sfu.subscribe(subSession, [
      { sessionId: pubSession, trackName: "camera", simulcast: { preferredRid: "f", ...preference } },
    ])
    await subscriber.evaluate(async (sdp) => {
      await window.pc.setRemoteDescription({ type: "offer", sdp })
      await window.pc.setLocalDescription(await window.pc.createAnswer())
    }, sub.sessionDescription!.sdp)
    await sfu.renegotiate(subSession, { type: "answer", sdp: await gatheredSdp(subscriber) })

    await until(async () => (await receivedWidth(subscriber)).width >= 1000, 30_000)
    const full = await receivedWidth(subscriber)

    // Down to the quarter layer, in place: no renegotiation.
    const receivingMid = sub.tracks![0]!.mid!
    await sfu.update(subSession, [
      {
        mid: receivingMid,
        sessionId: pubSession,
        trackName: "camera",
        simulcast: { preferredRid: "q", ...preference },
      },
    ])
    await until(async () => {
      const now = await receivedWidth(subscriber)
      return now.width > 0 && now.width <= 400
    }, 30_000)
    const quarter = await receivedWidth(subscriber)
    console.log(`received width: ${full.width}px on f, ${quarter.width}px on q`)
    expect(quarter.width).toBeLessThan(full.width / 2)

    // Errors as the real API words them, for the fixtures: a layer for a subscription that doesn't exist.
    await sfu
      .update(subSession, [{ mid: "99", sessionId: pubSession, trackName: "camera", simulcast: { preferredRid: "h" } }])
      .catch(() => undefined)

    await sfu.forceClose(pubSession, [mid])
    if (env.RECORD_FIXTURES) {
      mkdirSync(FIXTURES, { recursive: true })
      writeFileSync(resolve(FIXTURES, "exchanges-video.json"), `${scrub(JSON.stringify(record, null, 2))}\n`)
    }
  })
})

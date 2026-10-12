import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { MAX_RETRIES, type TeamHub } from "../src/hub"
import { connect, ok, settle, workspace } from "./helpers"

type Frame = Record<string, unknown>
const isMessage = (text: string) => (f: Frame) =>
  f.type === "events_api" && (f.payload as { event: Frame }).event.text === text

/** Makes every unacked envelope overdue and runs the alarm the hub scheduled, as if the ack window had passed. */
async function expire(teamId: string) {
  const stub = env.HUB.get(env.HUB.idFromName(teamId))
  await runInDurableObject(stub, async (_hub: TeamHub, state) => {
    state.storage.sql.exec("UPDATE unacked SET due = 0")
  })
  return runDurableObjectAlarm(stub)
}

async function unackedCount(teamId: string) {
  const stub = env.HUB.get(env.HUB.idFromName(teamId))
  return runInDurableObject(
    stub,
    async (_hub: TeamHub, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM unacked").one().n,
  )
}

describe("Socket Mode redelivery", () => {
  it("doesn't resend an acknowledged envelope", async () => {
    const w = await workspace()
    const app = await w.addApp("Listener")
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    await ok("chat.postMessage", { channel: w.general, text: "acked" }, w.owner.token)
    const envelope = await link.next(isMessage("acked"))
    link.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
    await settle()
    expect(await unackedCount(w.teamId)).toBe(0)
    await expire(w.teamId)
    await settle()
    expect(link.frames.filter(isMessage("acked"))).toEqual([])
    link.close()
  })

  it("resends an unacknowledged envelope with retry_attempt, then gives up", async () => {
    const w = await workspace()
    const app = await w.addApp("Listener")
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    await ok("chat.postMessage", { channel: w.general, text: "lost" }, w.owner.token)
    const first = await link.next(isMessage("lost"))
    expect(first).toMatchObject({ retry_attempt: 0, retry_reason: "" })

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      expect(await expire(w.teamId)).toBe(true)
      const retry = await link.next(isMessage("lost"))
      expect(retry).toMatchObject({ envelope_id: first.envelope_id, retry_attempt: attempt, retry_reason: "timeout" })
      // The same event: a client can tell a retry from a new one by event_id.
      expect((retry.payload as Frame).event_id).toBe((first.payload as Frame).event_id)
    }
    await expire(w.teamId)
    await settle()
    expect(link.frames.filter(isMessage("lost"))).toEqual([])
    expect(await unackedCount(w.teamId)).toBe(0)
    link.close()
  })

  it("retries on another link of the app, and acks stop it", async () => {
    const w = await workspace()
    const app = await w.addApp("Listener")
    const a = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    const b = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await b.next((f) => f.type === "hello")
    await ok("chat.postMessage", { channel: w.general, text: "spread" }, w.owner.token)
    await settle(100)
    const firstOn = a.frames.some(isMessage("spread")) ? a : b
    const other = firstOn === a ? b : a
    await firstOn.next(isMessage("spread"))
    await expire(w.teamId)
    const retry = await other.next(isMessage("spread"))
    expect(retry.retry_attempt).toBe(1)
    other.ws.send(JSON.stringify({ envelope_id: retry.envelope_id }))
    await settle()
    expect(await unackedCount(w.teamId)).toBe(0)
    a.close()
    b.close()
  })

  it("keeps counting attempts while the app has no link", async () => {
    const w = await workspace()
    const app = await w.addApp("Listener")
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    await ok("chat.postMessage", { channel: w.general, text: "orphan" }, w.owner.token)
    await link.next(isMessage("orphan"))
    link.close()
    await settle()
    for (let i = 0; i <= MAX_RETRIES; i++) await expire(w.teamId)
    expect(await unackedCount(w.teamId)).toBe(0)
  })
})

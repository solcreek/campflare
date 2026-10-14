import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { handlePermalink, permalinkRoute, unpackTs } from "../src/permalinks"
import { ok, ORIGIN, workspace } from "./helpers"

type Posted = { ts: string }

const follow = (url: string) => SELF.fetch(url, { redirect: "manual" })

describe("permalinks", () => {
  it("send the browser to the app's route for a message, and for a reply in its thread", async () => {
    const w = await workspace()
    const root = await ok<Posted>("chat.postMessage", { channel: w.general, text: "Ship it?" }, w.owner.token)
    const reply = await ok<Posted>(
      "chat.postMessage",
      { channel: w.general, text: "¿Mañana? 明天", thread_ts: root.ts },
      w.owner.token,
    )
    const link = async (ts: string) =>
      (await ok<{ permalink: string }>("chat.getPermalink", { channel: w.general, message_ts: ts }, w.owner.token))
        .permalink

    const res = await follow(await link(root.ts))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(`https://app.campflare.test/?team=dev#/${w.general}?msg=${root.ts}`)
    expect(res.headers.get("cache-control")).toBe("no-store")

    const thread = await follow(await link(reply.ts))
    expect(thread.headers.get("location")).toBe(
      `https://app.campflare.test/?team=dev#/${w.general}/${root.ts}?msg=${reply.ts}`,
    )
  })

  it("open the conversation for a link without a message, and refuse what isn't a channel", async () => {
    const conversation = await follow(`${ORIGIN}/archives/C0123ABC`)
    expect(conversation.headers.get("location")).toBe("https://app.campflare.test/?team=dev#/C0123ABC")
    // Unknown ids still go to the app: only it can tell, signed in, whether the message exists.
    const unknown = await follow(`${ORIGIN}/archives/CNOPE/p1700000000000100`)
    expect(unknown.headers.get("location")).toBe("https://app.campflare.test/?team=dev#/CNOPE?msg=1700000000.000100")
    expect((await follow(`${ORIGIN}/archives/not-a-channel/p1`)).status).toBe(404)
  })
})

describe("permalinkRoute", () => {
  it("unpacks the ts and keeps the thread only for a reply", () => {
    expect(unpackTs("p1700000000000100")).toBe("1700000000.000100")
    expect(unpackTs("p12")).toBeUndefined()
    expect(unpackTs("1700000000000100")).toBeUndefined()
    expect(permalinkRoute("C1", "p1700000000000100")).toBe("#/C1?msg=1700000000.000100")
    expect(permalinkRoute("C1", "p1700000000000200", "1700000000.000100")).toBe(
      "#/C1/1700000000.000100?msg=1700000000.000200",
    )
    // A thread head's own link names itself as its thread: no thread to open.
    expect(permalinkRoute("C1", "p1700000000000100", "1700000000.000100")).toBe("#/C1?msg=1700000000.000100")
    expect(permalinkRoute("C1", "p1700000000000200", "<script>")).toBe("#/C1?msg=1700000000.000200")
    expect(permalinkRoute("C1", "pnope")).toBe("#/C1")
    expect(permalinkRoute("c1")).toBeUndefined()
  })

  it("says where to look when the server doesn't know where its app is", async () => {
    const url = new URL(`${ORIGIN}/archives/C1/p1700000000000100`)
    const res = handlePermalink(undefined, url, "C1", "p1700000000000100")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const html = await res.text()
    expect(html).toContain("APP_URL")
    expect(html).toContain("<code>#/C1?msg=1700000000.000100</code>")
  })
})

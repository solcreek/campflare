import { describe, expect, it } from "vitest"
import { expectError, ok, workspace } from "./helpers"

type Search = {
  messages: {
    total: number
    matches: {
      text: string
      channel: { id: string; name: string; is_im: boolean }
      username: string
      permalink: string
    }[]
    paging: { pages: number }
  }
}

async function search(token: string, query: string, extra: Record<string, unknown> = {}) {
  return (await ok<Search>("search.messages", { query, ...extra }, token)).messages
}

describe("search.messages", () => {
  it("finds words, phrases and exclusions", async () => {
    const w = await workspace()
    const post = (text: string) => ok("chat.postMessage", { channel: w.general, text }, w.owner.token)
    await post("deploy failed on staging")
    await post("the deploy worked")
    await post("release notes are out")

    expect((await search(w.owner.token, "deploy")).total).toBe(2)
    expect((await search(w.owner.token, '"deploy failed"')).matches.map((m) => m.text)).toEqual([
      "deploy failed on staging",
    ])
    expect((await search(w.owner.token, "deploy -staging")).matches.map((m) => m.text)).toEqual(["the deploy worked"])
    expect((await search(w.owner.token, "nothing-like-this")).total).toBe(0)
    const first = (await search(w.owner.token, "deploy", { sort: "timestamp", sort_dir: "asc" })).matches
    expect(first.map((m) => m.text)).toEqual(["deploy failed on staging", "the deploy worked"])
    expect(first[0]!.username).toBe("owner")
    expect(first[0]!.permalink).toContain(`/archives/${w.general}/p`)
    await expectError("search.messages", {}, w.owner.token, "no_query")
  })

  it("matches every script: CJK substrings, and Latin text without case or accents", async () => {
    const w = await workspace()
    const corpus = {
      zh: "部署失敗了，請檢查日誌",
      ja: "東京オフィスで会議があります",
      ko: "배포가 실패했습니다",
      es: "El despliegue falló en producción",
      fr: "Le café est prêt à la cafétéria",
      de: "Die Straße nach München ist gesperrt",
    }
    for (const text of Object.values(corpus)) await ok("chat.postMessage", { channel: w.general, text }, w.owner.token)
    const found = async (query: string) => (await search(w.owner.token, query)).matches.map((m) => m.text)

    // CJK has no spaces between words: substrings must match, including
    // two-character words, which are shorter than a trigram.
    expect(await found("失敗了")).toEqual([corpus.zh])
    expect(await found("部署")).toEqual([corpus.zh])
    expect(await found("オフィス")).toEqual([corpus.ja])
    expect(await found("東京")).toEqual([corpus.ja])
    expect(await found("실패했")).toEqual([corpus.ko])
    expect(await found("배포")).toEqual([corpus.ko])
    // Latin scripts: either case, with or without diacritics.
    expect(await found("fallo")).toEqual([corpus.es])
    expect(await found("PRODUCCION")).toEqual([corpus.es])
    expect(await found("cafeteria")).toEqual([corpus.fr])
    expect(await found("prêt")).toEqual([corpus.fr])
    expect(await found("munchen")).toEqual([corpus.de])
    expect(await found("Straße")).toEqual([corpus.de])
  })

  it("filters with in:, from:, has:, is: and dates", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name: "dev" }, w.owner.token)
    await ok("chat.postMessage", { channel: w.general, text: "alpha in general" }, w.owner.token)
    const dev = await ok<{ ts: string }>(
      "chat.postMessage",
      { channel: channel.id, text: "alpha in dev <https://x.test>" },
      w.owner.token,
    )
    await ok("chat.postMessage", { channel: w.general, text: "alpha from bob" }, bob.token)
    await ok("chat.postMessage", { channel: bob.id, text: "alpha in a dm" }, w.owner.token)
    await ok("chat.postMessage", { channel: channel.id, text: "alpha reply", thread_ts: dev.ts }, w.owner.token)
    await ok("reactions.add", { channel: channel.id, timestamp: dev.ts, name: "eyes" }, w.owner.token)

    const texts = async (q: string) => (await search(w.owner.token, q)).matches.map((m) => m.text).toSorted()
    expect(await texts("alpha in:#dev")).toEqual(["alpha in dev <https://x.test>", "alpha reply"])
    expect(await texts(`alpha in:<#${channel.id}|dev>`)).toHaveLength(2)
    expect(await texts("alpha in:@bob")).toEqual(["alpha in a dm"])
    expect(await texts("alpha from:@bob")).toEqual(["alpha from bob"])
    expect(await texts(`alpha from:<@${bob.id}>`)).toEqual(["alpha from bob"])
    expect(await texts("alpha from:me")).toHaveLength(4)
    expect(await texts("from:nobody")).toEqual([])
    expect(await texts("in:#nowhere")).toEqual([])
    expect(await texts("alpha has:link")).toEqual(["alpha in dev <https://x.test>"])
    expect(await texts("alpha has:reaction")).toEqual(["alpha in dev <https://x.test>"])
    expect(await texts("alpha has:file")).toEqual([])
    expect(await texts("alpha has:pin")).toEqual([])
    expect(await texts("alpha is:thread")).toEqual(["alpha in dev <https://x.test>", "alpha reply"])
    expect(await texts("alpha is:dm")).toEqual(["alpha in a dm"])
    expect(await texts("alpha after:2000-01-01 before:2999-01-01")).toHaveLength(5)
    expect(await texts("alpha before:2000-01-01")).toEqual([])
    expect(await texts("alpha on:today")).toHaveLength(5)
    expect(await texts("alpha during:2000-01")).toEqual([])

    const dm = (await search(w.owner.token, "alpha is:dm")).matches[0]!
    expect(dm.channel).toMatchObject({ is_im: true, name: bob.id })
  })

  it("only searches what you can read, and pages", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    await ok("chat.postMessage", { channel: channel.id, text: "hidden treasure" }, w.owner.token)
    for (let i = 0; i < 3; i++)
      await ok("chat.postMessage", { channel: w.general, text: `public treasure ${i}` }, w.owner.token)
    expect((await search(bob.token, "treasure")).total).toBe(3)
    expect((await search(w.owner.token, "treasure")).total).toBe(4)
    const page2 = await search(bob.token, "treasure", { count: 2, page: 2 })
    expect(page2.matches).toHaveLength(1)
    expect(page2.paging.pages).toBe(2)
    // Joins and other system messages aren't content.
    const { channel: open } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "open" },
      w.owner.token,
    )
    await ok("conversations.join", { channel: open.id }, bob.token)
    expect((await search(w.owner.token, "joined")).total).toBe(0)
  })
})

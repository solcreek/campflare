import { SELF } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { afterEach, describe, expect, it } from "vitest"
import { EMOJI_MAX_BYTES, newName, setEmojiFetch, STANDARD_EMOJI } from "../src/api/emoji"
import { imageSize } from "../src/api/media"
import { setImagesOverride } from "../src/api/thumbs"
import { createMetadataFetch } from "../src/auth/cimd-fetch"
import { ORIGIN, call, connect, eventually, expectError, ok, workspace, type Body } from "./helpers"
import { convert, makeGif, makePng } from "./images"

// Custom emoji: emoji.list, admin.emoji.*, campflare.emoji.add, the images at
// /emoji/<team>/<image>.<ext>, and emoji_changed.

afterEach(() => {
  setImagesOverride(undefined)
  setEmojiFetch(undefined)
})

type Added = Body & { emoji: { name: string; url: string; alias_for?: string } }
type Listed = Body & { emoji: Record<string, string>; cache_ts: string }

async function upload(token: string, name: string, bytes: Uint8Array | undefined) {
  const form = new FormData()
  form.set("name", name)
  if (bytes) form.set("image", new File([new Uint8Array(bytes)], "emoji.png"))
  const res = await SELF.fetch(`${ORIGIN}/api/campflare.emoji.add`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  return (await res.json()) as Added
}

async function added(token: string, name: string, bytes: Uint8Array<ArrayBuffer>) {
  const r = await upload(token, name, bytes)
  if (!r.ok) throw new Error(`campflare.emoji.add failed: ${r.error}`)
  return r.emoji
}

async function live(token: string) {
  const rtm = await ok<{ url: string }>("rtm.connect", {}, token)
  const link = await connect(rtm.url)
  await link.next((f) => f.type === "hello")
  return link
}

const list = (token: string) => ok<Listed>("emoji.list", {}, token)
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer())

describe("emoji.list", () => {
  it("is empty until someone adds one, and lists the standard emoji by category when asked", async () => {
    const w = await workspace()
    expect(await list(w.owner.token)).toMatchObject({ emoji: {}, cache_ts: "0.000000" })
    expect((await list(w.owner.token)).categories).toBeUndefined()
    const withCategories = await ok<{ categories: { name: string; emoji_names: string[] }[] }>(
      "emoji.list",
      { include_categories: true },
      w.owner.token,
    )
    expect(withCategories.categories.map((c) => c.name)).toEqual([
      "smileys_people",
      "nature",
      "food_drink",
      "activity",
      "travel_places",
      "objects",
      "symbols",
      "flags",
    ])
    expect(withCategories.categories[0]!.emoji_names.slice(0, 3)).toEqual(["grinning", "smiley", "smile"])
    expect(withCategories.categories[2]!.emoji_names).toContain("ramen")
  })

  it("works for a bot, whose default scopes include emoji:read", async () => {
    const w = await workspace()
    const app = await w.addApp("Helper")
    await added(w.owner.token, "campflare", await makePng(64, 64))
    expect(Object.keys((await list(app.botToken)).emoji)).toEqual(["campflare"])
  })
})

describe("campflare.emoji.add", () => {
  it("stores the image, serves it without a token, lists it and tells everyone", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const link = await live(bob.token)
    const png = await makePng(64, 48)
    const before = await list(w.owner.token)
    const emoji = await added(bob.token, ":Party-Parrot:", png)
    expect(emoji.name).toBe("party-parrot")
    expect(emoji.url).toMatch(new RegExp(`^${ORIGIN}/emoji/${w.teamId}/[0-9a-f]+\\.png$`))
    const change = await link.next((f) => f.type === "emoji_changed")
    expect(change).toMatchObject({ subtype: "add", name: "party-parrot", value: emoji.url })
    expect(change.event_ts).toBeTruthy()
    link.close()

    const listed = await list(w.owner.token)
    expect(listed.emoji).toEqual({ "party-parrot": emoji.url })
    expect(Number(listed.cache_ts)).toBeGreaterThan(Number(before.cache_ts))

    const res = await SELF.fetch(emoji.url)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toContain("immutable")
    expect(res.headers.get("content-security-policy")).toBe("sandbox")
    expect(await bytesOf(res)).toEqual(png)
  })

  it("follows Slack's name rules", async () => {
    const w = await workspace()
    const png = await makePng(32, 32)
    for (const bad of [
      "fête",
      "café",
      "über",
      "表情",
      "絵文字",
      "이모지",
      "a b",
      "a.b",
      "a+b",
      "x".repeat(101),
      "__proto__",
      "constructor",
      ":Constructor:",
      "toString",
      "hasOwnProperty",
      "__defineGetter__",
    ]) {
      expect([bad, (await upload(w.owner.token, bad, png)).error]).toEqual([bad, "error_bad_name_i18n"])
    }
    expect((await upload(w.owner.token, "", png)).error).toBe("error_missing_name")
    expect((await upload(w.owner.token, "::", png)).error).toBe("error_missing_name")
    for (const standard of ["thumbsup", "+1", "ramen", "flag-jp", "skin-tone-2", ":Tada:"]) {
      expect([standard, (await upload(w.owner.token, standard, png)).error]).toEqual([
        standard,
        "error_name_taken_i18n",
      ])
    }
    expect((await upload(w.owner.token, "x".repeat(100), png)).ok).toBe(true)
    await added(w.owner.token, "ship_it-2", png)
    const stored = (await env.FILES.list({ prefix: `${w.teamId}/emoji/` })).objects.length
    expect((await upload(w.owner.token, "ship_it-2", png)).error).toBe("error_name_taken")
    // Refused before the image was stored.
    expect((await env.FILES.list({ prefix: `${w.teamId}/emoji/` })).objects).toHaveLength(stored)
  })

  it("takes PNG, GIF, JPEG and WebP up to 128 KB", async () => {
    const w = await workspace()
    expect((await upload(w.owner.token, "none", undefined)).error).toBe("error_no_image")
    expect((await upload(w.owner.token, "empty", new Uint8Array(0))).error).toBe("error_no_image")
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect((await upload(w.owner.token, "svg", svg)).error).toBe("error_bad_format")
    const big = new Uint8Array(EMOJI_MAX_BYTES + 1)
    big.set(await makePng(8, 8))
    expect((await upload(w.owner.token, "big", big)).error).toBe("error_too_big")
    // A body bigger than any emoji needs is refused before it's parsed, whatever the image.
    const padded = new FormData()
    padded.set("name", "padded")
    padded.set("image", new File([await makePng(8, 8)], "e.png"))
    padded.set("padding", "x".repeat(EMOJI_MAX_BYTES + 32 * 1024))
    const res = await SELF.fetch(`${ORIGIN}/api/campflare.emoji.add`, {
      method: "POST",
      headers: { authorization: `Bearer ${w.owner.token}` },
      body: padded,
    })
    expect(await res.json()).toMatchObject({ ok: false, error: "error_too_big" })
    const png = await makePng(24, 24)
    const jpeg = await convert(env.IMAGES!, png, "image/jpeg")
    expect((await added(w.owner.token, "photo-jpeg", jpeg)).url).toMatch(/\.jpg$/)
    const webp = new Uint8Array(
      await (
        await env.IMAGES!.input(new Blob([png]).stream()).output({ format: "image/webp" })
      )
        .response()
        .arrayBuffer(),
    )
    const still = await added(w.owner.token, "photo-webp", webp)
    expect(still.url).toMatch(/\.webp$/)
    expect((await SELF.fetch(still.url)).headers.get("content-type")).toBe("image/webp")
    const gif = makeGif(16, 16, 2)
    const moving = await added(w.owner.token, "spinner", gif)
    expect(moving.url).toMatch(/\.gif$/)
    expect(await bytesOf(await SELF.fetch(moving.url))).toEqual(gif)
  })

  it("scales a big image down to 128 px, or keeps it as it is without the Images binding", async () => {
    const w = await workspace()
    const png = await makePng(600, 400)
    const scaled = await added(w.owner.token, "wide", png)
    expect(imageSize(await bytesOf(await SELF.fetch(scaled.url)))).toEqual({ width: 128, height: 85 })
    setImagesOverride(null)
    const kept = await added(w.owner.token, "wide-original", png)
    expect(await bytesOf(await SELF.fetch(kept.url))).toEqual(png)
  })

  it("keeps the original when Images answers a bigger file, the wrong size or type, or fails", async () => {
    const w = await workspace()
    const png = await makePng(600, 400)
    const answering = (out: Uint8Array | Error) =>
      ({
        input: () => ({
          transform() {
            return this
          },
          output: async () => {
            if (out instanceof Error) throw out
            return { response: () => new Response(new Uint8Array(out)) }
          },
        }),
      }) as unknown as ImagesBinding
    const small = await makePng(128, 85)
    const bloated = new Uint8Array(png.byteLength + 1)
    bloated.set(small)
    const cases: [string, Uint8Array | Error][] = [
      ["bigger", bloated],
      ["too-wide", await makePng(200, 100)],
      ["wrong-type", await convert(env.IMAGES!, small, "image/jpeg")],
      ["failing", new Error("images down")],
    ]
    for (const [name, out] of cases) {
      setImagesOverride(answering(out))
      const e = await added(w.owner.token, name, png)
      expect([name, await bytesOf(await SELF.fetch(e.url))]).toEqual([name, png])
    }
    // A smaller file of the right size and type is kept.
    setImagesOverride(answering(small))
    const e = await added(w.owner.token, "scaled", png)
    expect(await bytesOf(await SELF.fetch(e.url))).toEqual(small)
  })

  it("needs emoji:write and a user token", async () => {
    const w = await workspace()
    const png = await makePng(16, 16)
    const writer = (await ok<{ token: string }>("campflare.tokens.create", { preset: "write" }, w.owner.token)).token
    expect(await upload(writer, "nope", png)).toMatchObject({ error: "missing_scope", needed: "emoji:write" })
    // A read token still lists them.
    expect((await list(writer)).ok).toBe(true)
    const app = await w.addApp("Helper")
    expect((await upload(app.botToken, "nope", png)).error).toBe("not_allowed_token_type")
    const methods = await ok<{ methods: { name: string; scopes: string[] }[]; presets: Record<string, string[]> }>(
      "campflare.methods.list",
    )
    expect(methods.methods.find((m) => m.name === "admin.emoji.add")?.scopes).toEqual(["emoji:write"])
    expect(methods.presets.full).toContain("emoji:write")
    expect(methods.presets.write).not.toContain("emoji:write")
  })
})

describe("admin.emoji.add", () => {
  it("fetches the image from its URL", async () => {
    const w = await workspace()
    const png = await makePng(40, 40)
    const asked: string[] = []
    setEmojiFetch(async (input) => {
      asked.push(String(input))
      return new Response(png)
    })
    const r = await ok<Added>(
      "admin.emoji.add",
      { name: "shipit", url: "https://images.example.com/shipit.png" },
      w.owner.token,
    )
    expect(asked).toEqual(["https://images.example.com/shipit.png"])
    expect(await bytesOf(await SELF.fetch(r.emoji.url))).toEqual(png)
    expect((await list(w.owner.token)).emoji.shipit).toBe(r.emoji.url)
    // A taken name is refused before anything is fetched.
    await expectError(
      "admin.emoji.add",
      { name: "shipit", url: "https://images.example.com/b.png" },
      w.owner.token,
      "error_name_taken",
    )
    expect(asked).toHaveLength(1)

    // Taken while the image was being fetched: the INSERT refuses it, and the stored image goes.
    setEmojiFetch(async () => {
      await env.DB.prepare(
        "INSERT INTO emoji (team_id, name, alias_for, created_by, created) VALUES (?, 'raced', 'shipit', ?, 0)",
      )
        .bind(w.teamId, w.owner.id)
        .run()
      return new Response(png)
    })
    await expectError(
      "admin.emoji.add",
      { name: "raced", url: "https://x.example.com/a" },
      w.owner.token,
      "error_name_taken",
    )
    await eventually(async () => (await env.FILES.list({ prefix: `${w.teamId}/emoji/` })).objects.length === 1)
  })

  it("refuses what the SSRF guard refuses, failed fetches, and too much", async () => {
    const w = await workspace()
    const png = await makePng(40, 40)
    // The real guard, with a resolver that answers a private address.
    setEmojiFetch(
      createMetadataFetch(
        async () => ["10.0.0.1"],
        async () => new Response(png),
      ),
    )
    await expectError(
      "admin.emoji.add",
      { name: "a1", url: "https://intranet.example.com/a.png" },
      w.owner.token,
      "error_bad_upload",
    )
    setEmojiFetch(
      createMetadataFetch(
        async () => ["93.184.216.34"],
        async () => new Response(png),
      ),
    )
    for (const url of [
      "http://images.example.com/a.png",
      "https://127.0.0.1/a.png",
      "https://localhost/a.png",
      "not a url",
    ]) {
      await expectError("admin.emoji.add", { name: "a2", url }, w.owner.token, "error_bad_upload")
    }
    // Through the guard to a public address it works.
    await ok("admin.emoji.add", { name: "a3", url: "https://images.example.com/a.png" }, w.owner.token)

    setEmojiFetch(async () => new Response("gone", { status: 404 }))
    await expectError(
      "admin.emoji.add",
      { name: "a4", url: "https://x.example.com/a" },
      w.owner.token,
      "error_bad_upload",
    )
    setEmojiFetch(
      async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } }),
    )
    await expectError(
      "admin.emoji.add",
      { name: "a5", url: "https://x.example.com/a" },
      w.owner.token,
      "error_bad_upload",
    )
    // A body that never ends is cut off at the limit.
    setEmojiFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(16 * 1024))
            },
          }),
        ),
    )
    await expectError("admin.emoji.add", { name: "a6", url: "https://x.example.com/a" }, w.owner.token, "error_too_big")
    await expectError("admin.emoji.add", { name: "a7" }, w.owner.token, "error_no_image")
    expect(Object.keys((await list(w.owner.token)).emoji)).toEqual(["a3"])
  })
})

describe("admin.emoji.addAlias", () => {
  it("names a custom emoji or a standard one; an alias of an alias names the original", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const link = await live(w.owner.token)
    const parrot = await added(w.owner.token, "blob-parrot", await makePng(32, 32))
    const alias = await ok<Added>(
      "admin.emoji.addAlias",
      { name: "partyparrot", alias_for: ":blob-parrot:" },
      bob.token,
    )
    expect(alias.emoji).toEqual({ name: "partyparrot", url: "alias:blob-parrot", alias_for: "blob-parrot" })
    await link.next((f) => f.type === "emoji_changed" && f.name === "blob-parrot")
    expect(await link.next((f) => f.type === "emoji_changed" && f.name === "partyparrot")).toMatchObject({
      subtype: "add",
      value: "alias:blob-parrot",
    })
    link.close()
    await ok("admin.emoji.addAlias", { name: "pp", alias_for: "partyparrot" }, bob.token)
    await ok("admin.emoji.addAlias", { name: "yes", alias_for: "thumbsup" }, bob.token)
    expect((await list(bob.token)).emoji).toEqual({
      "blob-parrot": parrot.url,
      partyparrot: "alias:blob-parrot",
      pp: "alias:blob-parrot",
      yes: "alias:thumbsup",
    })
    await expectError("admin.emoji.addAlias", { name: "phantom", alias_for: "nothing" }, bob.token, "emoji_not_found")
    await expectError("admin.emoji.addAlias", { name: "phantom" }, bob.token, "emoji_not_found")
    await expectError("admin.emoji.addAlias", { name: "pp", alias_for: "blob-parrot" }, bob.token, "error_name_taken")
    await expectError(
      "admin.emoji.addAlias",
      { name: "heart", alias_for: "blob-parrot" },
      bob.token,
      "error_name_taken_i18n",
    )
  })
})

describe("admin.emoji.remove", () => {
  it("lets the creator or an admin remove an emoji, with its aliases and its image", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const mine = await added(bob.token, "bobs", await makePng(32, 32))
    await ok("admin.emoji.addAlias", { name: "bobs-too", alias_for: "bobs" }, carol.token)
    await ok("admin.emoji.addAlias", { name: "bobs-also", alias_for: "bobs" }, carol.token)
    await expectError("admin.emoji.remove", { name: "bobs" }, carol.token, "not_an_admin")
    await expectError("admin.emoji.remove", { name: "nothing" }, carol.token, "emoji_not_found")
    // The alias's creator may remove the alias alone.
    await ok("admin.emoji.remove", { name: ":bobs-also:" }, carol.token)
    const link = await live(carol.token)
    await ok("admin.emoji.remove", { name: "bobs" }, bob.token)
    expect(await link.next((f) => f.type === "emoji_changed")).toMatchObject({
      subtype: "remove",
      names: ["bobs", "bobs-too"],
    })
    link.close()
    expect((await list(bob.token)).emoji).toEqual({})
    expect((await SELF.fetch(mine.url)).status).toBe(404)
    expect(await env.FILES.list({ prefix: `${w.teamId}/emoji/` })).toMatchObject({ objects: [] })

    const carols = await added(carol.token, "carols", await makePng(32, 32))
    await ok("admin.emoji.remove", { name: "carols" }, w.owner.token)
    expect((await SELF.fetch(carols.url)).status).toBe(404)
  })
})

describe("admin.emoji.rename", () => {
  it("renames an emoji; its aliases and image follow", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const cat = await added(bob.token, "cat-jam", await makePng(32, 32))
    await ok("admin.emoji.addAlias", { name: "jam", alias_for: "cat-jam" }, carol.token)
    await added(carol.token, "good-dog", await makePng(32, 32))
    await expectError("admin.emoji.rename", { name: "cat-jam", new_name: "kitty" }, carol.token, "not_an_admin")
    await expectError("admin.emoji.rename", { name: "nothing", new_name: "kitty" }, bob.token, "emoji_not_found")
    await expectError("admin.emoji.rename", { name: "cat-jam", new_name: "good-dog" }, bob.token, "error_name_taken")
    await expectError("admin.emoji.rename", { name: "cat-jam", new_name: "cat" }, bob.token, "error_name_taken_i18n")
    await expectError("admin.emoji.rename", { name: "cat-jam", new_name: "Chat Été" }, bob.token, "error_bad_name_i18n")

    const link = await live(carol.token)
    const r = await ok<Added>("admin.emoji.rename", { name: "cat-jam", new_name: "kitty-jam" }, bob.token)
    expect(r.emoji).toEqual({ name: "kitty-jam", url: cat.url })
    expect(await link.next((f) => f.type === "emoji_changed")).toMatchObject({
      subtype: "rename",
      old_name: "cat-jam",
      new_name: "kitty-jam",
      value: cat.url,
    })
    link.close()
    expect((await list(bob.token)).emoji).toEqual({
      "kitty-jam": cat.url,
      jam: "alias:kitty-jam",
      "good-dog": expect.stringMatching(/\.png$/),
    })
    expect((await SELF.fetch(cat.url)).status).toBe(200)
    // An admin may rename anyone's.
    await ok("admin.emoji.rename", { name: "good-dog", new_name: "doggo" }, w.owner.token)
  })
})

describe("admin.emoji.list", () => {
  it("pages through every emoji with who added it and when", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await added(bob.token, "b-one", await makePng(16, 16))
    await added(w.owner.token, "a-one", await makePng(16, 16))
    await ok("admin.emoji.addAlias", { name: "c-one", alias_for: "a-one" }, bob.token)
    type Page = Body & {
      emoji: Record<string, { url: string; date_created: number; uploaded_by: string; alias_for?: string }>
      response_metadata: { next_cursor: string }
    }
    const first = await ok<Page>("admin.emoji.list", { limit: 2 }, bob.token)
    expect(Object.keys(first.emoji)).toEqual(["a-one", "b-one"])
    expect(first.emoji["a-one"]).toMatchObject({ uploaded_by: w.owner.id, url: expect.stringMatching(/\.png$/) })
    expect(first.emoji["b-one"]!.uploaded_by).toBe(bob.id)
    expect(first.emoji["a-one"]!.date_created).toBeGreaterThan(0)
    const second = await ok<Page>(
      "admin.emoji.list",
      { limit: 2, cursor: first.response_metadata.next_cursor },
      bob.token,
    )
    expect(second.emoji).toEqual({
      "c-one": { url: "alias:a-one", alias_for: "a-one", uploaded_by: bob.id, date_created: expect.any(Number) },
    })
    expect(second.response_metadata.next_cursor).toBe("")
  })
})

describe("emoji images", () => {
  it("are 404 for anything that isn't one", async () => {
    const w = await workspace()
    for (const path of [
      `/emoji/${w.teamId}/0123456789abcdef.png`,
      `/emoji/${w.teamId}/..%2f.png`,
      "/emoji/x/abcdefab.png",
    ]) {
      expect([path, (await SELF.fetch(`${ORIGIN}${path}`)).status]).toEqual([path, 404])
    }
  })
})

describe("names", () => {
  it("know the standard emoji, Slack's second names and the skin tones", () => {
    expect(STANDARD_EMOJI.size).toBeGreaterThan(1800)
    const names = ["+1", "thumbsup", "-1", "100", "flag-tw", "skin-tone-6", "face_with_spiral_eyes"]
    expect(names.filter((n) => !STANDARD_EMOJI.has(n))).toEqual([])
    expect(newName(" :Ship_It: ")).toBe("ship_it")
    expect(() => newName(undefined)).toThrow("error_missing_name")
  })

  it("come back through a call too", async () => {
    const w = await workspace()
    expect((await call("campflare.emoji.add", { name: "no-image" }, w.owner.token)).error).toBe("error_no_image")
  })
})

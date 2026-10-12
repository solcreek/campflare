import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { expectError, ok, workspace } from "./helpers"

// A 3×2 PNG header is all imageSize() reads.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0,
  0, 0,
])

type FileJson = {
  id: string
  name: string
  url_private: string
  url_private_download: string
  original_w?: number
  original_h?: number
  size: number
  mimetype: string
}

async function upload(token: string, name: string, bytes: Uint8Array, opts: { multipart?: boolean } = {}) {
  const reserved = await ok<{ upload_url: string; file_id: string }>(
    "files.getUploadURLExternal",
    { filename: name, length: bytes.length },
    token,
  )
  expect(reserved.upload_url).toMatch(/^https:\/\/campflare\.test\/upload\/v1\//)
  let body: BodyInit = bytes
  if (opts.multipart) {
    const form = new FormData()
    form.set("file", new File([bytes], name))
    body = form
  }
  const res = await SELF.fetch(reserved.upload_url, { method: "POST", body })
  expect(res.status).toBe(200)
  expect(await res.text()).toBe(`OK - ${bytes.length}`)
  return reserved.file_id
}

describe("files", () => {
  it("uploads, shares into a conversation, and serves to its members", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const carol = await w.addUser("carol")
    const fileId = await upload(w.owner.token, "shot.png", PNG)
    await expectError("files.info", { file: fileId }, bob.token, "file_not_found") // not yet shared

    const dm = await ok<{ channel: { id: string } }>("conversations.open", { users: bob.id }, w.owner.token)
    const done = await ok<{ files: { id: string; title: string }[] }>(
      "files.completeUploadExternal",
      { files: [{ id: fileId, title: "Screenshot" }], channel_id: dm.channel.id, initial_comment: "look" },
      w.owner.token,
    )
    expect(done.files).toEqual([{ id: fileId, title: "Screenshot" }])

    const history = await ok<{ messages: { text: string; files: FileJson[]; upload: boolean }[] }>(
      "conversations.history",
      { channel: dm.channel.id },
      bob.token,
    )
    const message = history.messages[0]!
    expect(message).toMatchObject({ text: "look", upload: true })
    expect(message.files[0]).toMatchObject({
      id: fileId,
      name: "shot.png",
      mimetype: "image/png",
      original_w: 3,
      original_h: 2,
      size: PNG.length,
    })

    const file = message.files[0]!
    const get = await SELF.fetch(file.url_private, { headers: { authorization: `Bearer ${bob.token}` } })
    expect(get.status).toBe(200)
    expect(get.headers.get("content-type")).toBe("image/png")
    expect(get.headers.get("content-disposition")).toMatch(/^inline/)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG)
    const download = await SELF.fetch(file.url_private_download, { headers: { authorization: `Bearer ${bob.token}` } })
    expect(download.headers.get("content-disposition")).toMatch(/^attachment/)
    await download.arrayBuffer()
    const ranged = await SELF.fetch(file.url_private, {
      headers: { authorization: `Bearer ${bob.token}`, range: "bytes=0-3" },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-3/${PNG.length}`)
    expect((await ranged.arrayBuffer()).byteLength).toBe(4)

    // Carol isn't in the DM; no token at all; a bad token.
    expect((await SELF.fetch(file.url_private, { headers: { authorization: `Bearer ${carol.token}` } })).status).toBe(
      404,
    )
    expect((await SELF.fetch(file.url_private)).status).toBe(401)
    expect((await SELF.fetch(file.url_private, { headers: { authorization: "Bearer xoxp-nope" } })).status).toBe(401)
    expect(
      (
        await SELF.fetch(`https://campflare.test/files-pri/${w.teamId}-FNOPE/x`, {
          headers: { authorization: `Bearer ${bob.token}` },
        })
      ).status,
    ).toBe(404)

    expect(await ok("files.info", { file: fileId }, bob.token)).toMatchObject({
      file: { id: fileId, ims: [dm.channel.id] },
    })
    await expectError("files.info", { file: fileId }, carol.token, "file_not_found")
  })

  it("accepts multipart uploads and keeps unshared files private", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const bytes = new TextEncoder().encode("hello world")
    const fileId = await upload(w.owner.token, "notes.txt", bytes, { multipart: true })
    await ok("files.completeUploadExternal", { files: JSON.stringify([{ id: fileId }]) }, w.owner.token)
    const mine = await ok<{ file: FileJson }>("files.info", { file: fileId }, w.owner.token)
    expect(mine.file).toMatchObject({ name: "notes.txt", mimetype: "text/plain", size: 11 })
    expect(mine.file.original_w).toBeUndefined()
    await expectError("files.info", { file: fileId }, bob.token, "file_not_found")
  })

  it("lists and deletes files", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    const a = await upload(w.owner.token, "a.txt", new Uint8Array([1]))
    const b = await upload(bob.token, "b.txt", new Uint8Array([2]))
    await ok("files.completeUploadExternal", { files: [{ id: a }], channel_id: w.general }, w.owner.token)
    await ok(
      "files.completeUploadExternal",
      { files: [{ id: b }], channels: w.general, thread_ts: undefined },
      bob.token,
    )
    const all = await ok<{ files: FileJson[]; paging: { total: number } }>("files.list", {}, bob.token)
    expect(all.paging.total).toBe(2)
    const byUser = await ok<{ files: FileJson[] }>(
      "files.list",
      { user: w.owner.id, channel: w.general, ts_from: 1, ts_to: 9999999999 },
      bob.token,
    )
    expect(byUser.files.map((f) => f.id)).toEqual([a])
    const paged = await ok<{ files: FileJson[]; paging: { pages: number } }>(
      "files.list",
      { count: 1, page: 2 },
      bob.token,
    )
    expect(paged.files).toHaveLength(1)
    expect(paged.paging.pages).toBe(2)

    await expectError("files.delete", { file: a }, bob.token, "cant_delete_file")
    await ok("files.delete", { file: a }, w.owner.token)
    await expectError("files.info", { file: a }, w.owner.token, "file_not_found")
    // The message keeps a tombstone where the file was.
    const history = await ok<{ messages: { files?: { id: string; mode: string }[] }[] }>(
      "conversations.history",
      { channel: w.general },
      bob.token,
    )
    expect(history.messages.flatMap((m) => m.files ?? [])).toContainEqual({ id: a, mode: "tombstone" })
  })

  it("validates the upload flow", async () => {
    const w = await workspace()
    const bob = await w.addUser("bob")
    await expectError("files.getUploadURLExternal", { filename: "x" }, w.owner.token, "invalid_arguments")
    await expectError("files.getUploadURLExternal", { filename: "x", length: 2 ** 31 }, w.owner.token, "file_too_large")
    const reserved = await ok<{ upload_url: string; file_id: string }>(
      "files.getUploadURLExternal",
      { filename: "x", length: 1 },
      w.owner.token,
    )
    await expectError(
      "files.completeUploadExternal",
      { files: [{ id: reserved.file_id }] },
      w.owner.token,
      "file_upload_not_complete",
    )
    await expectError("files.completeUploadExternal", { files: [] }, w.owner.token, "invalid_arguments")
    await expectError("files.completeUploadExternal", { files: [{ title: "x" }] }, w.owner.token, "invalid_arguments")
    await expectError(
      "files.completeUploadExternal",
      { files: [{ id: reserved.file_id }] },
      bob.token,
      "file_not_found",
    )
    const { channel } = await ok<{ channel: { id: string } }>("conversations.create", { name: "x" }, bob.token)
    await expectError(
      "files.completeUploadExternal",
      { files: [{ id: reserved.file_id }], channel_id: channel.id },
      w.owner.token,
      "not_in_channel",
    )

    expect((await SELF.fetch(`${reserved.upload_url}x`, { method: "POST", body: "a" })).status).toBe(403)
    expect((await SELF.fetch("https://campflare.test/upload/v1/garbage", { method: "POST", body: "a" })).status).toBe(
      403,
    )
    const form = new FormData()
    form.set("note", "no file here")
    expect((await SELF.fetch(reserved.upload_url, { method: "POST", body: form })).status).toBe(400)
    expect((await SELF.fetch(reserved.upload_url, { method: "POST", body: "a" })).status).toBe(200)
    // Each upload URL takes one upload.
    expect((await SELF.fetch(reserved.upload_url, { method: "POST", body: "a" })).status).toBe(404)
  })
})

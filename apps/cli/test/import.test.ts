import { createClient } from "@campflare/client"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chunks, type JobJson } from "../src/import"
import { memoryAccess, openZip, ZipError } from "../src/zip"
import { baseUrl, loggedIn, memoryIo } from "./harness"
import { makeZip } from "./zip-writer"

// `campflare import slack` against a real server: a synthetic Slack export,
// zipped here, with a stand-in for Slack's file and emoji endpoints.

const SLACK_TOKEN = "xoxp-exported-workspace"
let slack: Server
let slackUrl = ""

beforeAll(async () => {
  slack = createServer((req, res) => {
    if (req.url === "/api/emoji.list") {
      res.setHeader("content-type", "application/json")
      const ok = req.headers.authorization === `Bearer ${SLACK_TOKEN}`
      return res.end(
        JSON.stringify(
          ok ? { ok, emoji: { fiesta: "https://x/fiesta.png", party: "alias:fiesta" } } : { ok, error: "invalid_auth" },
        ),
      )
    }
    if (req.url === "/files/F01/plan.pdf") {
      // Slack answers a wrong token with its sign-in page.
      if (req.headers.authorization !== `Bearer ${SLACK_TOKEN}`) {
        res.setHeader("content-type", "text/html")
        return res.end("<html>sign in</html>")
      }
      res.setHeader("content-type", "application/pdf")
      return res.end("%PDF-1.4 le plan · 計画")
    }
    res.statusCode = 404
    res.end("not found")
  })
  await new Promise<void>((resolve) => slack.listen(0, "127.0.0.1", resolve))
  slackUrl = `http://127.0.0.1:${(slack.address() as { port: number }).port}`
})

afterAll(() => new Promise<void>((resolve) => slack.close(() => resolve())))

const json = (value: unknown) => JSON.stringify(value)

/** A Slack export where ana is the person with `email`. */
function exportZip(email: string, opts: { zip64?: boolean; folder?: string } = {}) {
  const users = [
    { id: "U01", name: "olive", real_name: "Olive Owner", profile: { email: "olive@elsewhere.test" } },
    { id: "U02", name: "ana", real_name: "Ana", profile: { email: email.toUpperCase() } },
    { id: "U03", name: "wang.fang", real_name: "王芳", profile: {} },
    { id: "U04", name: "jose", real_name: "José Álvarez", profile: { email: "jose@elsewhere.test" } },
    { id: "U05", name: "minjun", real_name: "김민준", profile: {} },
    { id: "B01", name: "deploybot", is_bot: true, profile: {} },
  ]
  const channels = [
    {
      id: "C01",
      name: "general",
      is_general: true,
      created: 1_600_000_000,
      creator: "U01",
      members: ["U01", "U02", "U03", "U04", "U05"],
    },
    {
      id: "C02",
      name: "café",
      created: 1_600_000_100,
      creator: "U04",
      members: ["U02", "U04"],
      topic: { value: "Café · カフェ" },
    },
  ]
  const groups = [{ id: "G01", name: "secret-plans", creator: "U02", members: ["U02", "U03"] }]
  const dms = [{ id: "D01", members: ["U02", "U05"] }]
  const mpims = [{ id: "G02", name: "mpdm-ana--jose--minjun-1", members: ["U02", "U04", "U05"] }]
  const head = "1700000100.000200"
  const day1 = [
    // Replies come before their head: the head is in the next day's file.
    { ts: "1700000200.000300", user: "U04", text: "¡Claro que sí!", thread_ts: head, parent_user_id: "U03" },
    {
      ts: "1700000000.000100",
      user: "U02",
      text: "Bonjour à tous, <@U03> 你好 and <@U05> 안녕하세요 in <#C02|café>",
      reactions: [{ name: "wave", users: ["U03", "U04"], count: 2 }],
      pinned_to: ["C01"],
      user_profile: { real_name: "Ana", image_72: "https://x/ana.png" },
      blocks: [{ type: "rich_text", elements: [] }],
    },
  ]
  const day2 = [
    { ts: head, user: "U03", text: "明日の会議は十時です", thread_ts: head, reply_count: 2 },
    { ts: "1700000300.000400", user: "U05", text: "네, 알겠습니다", thread_ts: head, parent_user_id: "U03" },
    {
      ts: "1700000400.000500",
      user: "U04",
      text: "Übermorgen geht's los",
      edited: { user: "U04", ts: "1700000401.000000" },
    },
    {
      ts: "1700000500.000600",
      subtype: "bot_message",
      bot_id: "B999",
      bot_profile: { name: "Deploys" },
      text: "Déployé ✅",
    },
    { ts: "1700000600.000700", user: "U05", subtype: "channel_join", text: "<@U05> has joined the channel" },
    {
      ts: "1700000700.000800",
      user: "U02",
      text: "Le plan",
      files: [
        { id: "F01", name: "plan.pdf", title: "Plan · 計画", url_private_download: `${slackUrl}/files/F01/plan.pdf` },
        { id: "F02", name: "gone.png", url_private_download: `${slackUrl}/files/F02/gone.png` },
        { id: "F03", name: "old.png", mode: "hidden_by_limit" },
        { id: "F04", name: "nolink.txt" },
      ],
    },
  ]
  const prefix = opts.folder ? `${opts.folder}/` : ""
  return makeZip(
    {
      [`${prefix}users.json`]: json(users),
      [`${prefix}channels.json`]: json(channels),
      [`${prefix}groups.json`]: json(groups),
      [`${prefix}dms.json`]: json(dms),
      [`${prefix}mpims.json`]: json(mpims),
      [`${prefix}integration_logs.json`]: "[]",
      [`${prefix}general/2023-11-14.json`]: json(day1),
      [`${prefix}general/2023-11-15.json`]: json(day2),
      [`${prefix}café/2023-11-14.json`]: json([
        { ts: "1700000000.000001", user: "U04", text: "Un café, s'il vous plaît" },
      ]),
      [`${prefix}secret-plans/2023-11-14.json`]: json([{ ts: "1700000000.000002", user: "U03", text: "秘密の計画" }]),
      [`${prefix}D01/2023-11-14.json`]: json([{ ts: "1700000000.000003", user: "U05", text: "비밀이에요" }]),
      [`${prefix}mpdm-ana--jose--minjun-1/2023-11-14.json`]: json([
        { ts: "1700000000.000004", user: "U04", text: "Hola" },
      ]),
      [`${prefix}general/notes.txt`]: "not a day",
      [`${prefix}general/`]: "",
    },
    { zip64: opts.zip64 },
  )
}

/** An admin logged in, with ana (by email) in the workspace and #café taken. */
async function setUp() {
  const admin = await loggedIn()
  const email = `ana-${crypto.randomUUID().slice(0, 8)}@example.test`
  expect(await admin.run("admin", "add-user", "ana", "--email", email)).toBe(0)
  expect(await admin.run("create-channel", "café")).toBe(0)
  admin.clear()
  const token = admin.config!.profiles.default!.token!
  return { admin, email, client: createClient({ url: baseUrl, token }) }
}

const withZip = (admin: ReturnType<typeof memoryIo>, files: Record<string, Uint8Array>) => {
  const io = memoryIo({ files })
  Object.assign(admin.io, { readFile: io.io.readFile })
  return admin
}

describe("campflare import slack", () => {
  it("says what it would do, and writes nothing, with --dry-run", async () => {
    const { admin, email } = await setUp()
    withZip(admin, { "export.zip": exportZip(email) })
    expect(await admin.run("import", "slack", "export.zip", "--dry-run")).toBe(0)
    expect(admin.out).toContain("Dry run: nothing was written.")
    expect(admin.out).toContain("6: 1 match by email, 5 would be placeholders")
    expect(admin.out).toContain("ana → @ana")
    expect(admin.out).toContain("#café renamed #café-imported")
    expect(admin.out).toContain("messages       12")
    expect(admin.out).toContain("files          4 (left as a line each)")
    admin.clear()
    expect(await admin.run("import", "slack", "export.zip", "--dry-run", "--merge-into-existing", "--json")).toBe(0)
    const plan = JSON.parse(admin.out) as { conversations: { clashes: string[] }; messages: number }
    expect(plan.conversations.clashes).toEqual([
      "#general merged into the existing one",
      "#café merged into the existing one",
    ])
    admin.clear()
    expect(await admin.run("import", "status")).toBe(0)
    expect(admin.out).toBe("No imports yet\n")
  })

  it("imports the export, silently, and says what it did; status, a second run, and undo", async () => {
    const { admin, email, client } = await setUp()
    withZip(admin, { "acme.zip": exportZip(email, { folder: "Acme Slack export" }) })
    expect(await admin.run("import", "slack", "acme.zip")).toBe(0)
    expect(admin.err).toContain("Started import J")
    expect(admin.err).toContain("#general-imported: 8 messages")
    expect(admin.err).toContain("#café-imported: 1 messages")
    expect(admin.out).toMatch(/^Imported acme\.zip as job J[A-Z0-9]+ \(finished\)/)
    expect(admin.out).toContain("1 matched by email, 5 placeholders (deactivated)")
    expect(admin.out).toContain("3 created, 2 renamed, 0 merged, 0 skipped")
    expect(admin.out).toContain("messages       12, 2 reactions, 1 pins")
    expect(admin.out).toContain(
      "files          0 attached, 3 left as a line (--files download --slack-token to bring them)",
    )
    const job = /job (J[A-Z0-9]+)/.exec(admin.out)![1]!

    const { channels } = await client.call<{ ok: boolean; channels: { id: string; name: string }[] }>(
      "conversations.list",
      {
        types: "public_channel",
      },
    )
    const general = channels.find((c) => c.name === "general-imported")!.id
    const cafe = channels.find((c) => c.name === "café-imported")!.id
    const history = await client.call<{
      ok: boolean
      messages: { ts: string; text: string; reply_count?: number; user?: string }[]
    }>("conversations.history", { channel: general })
    const byTs = new Map(history.messages.map((m) => [m.ts, m]))
    expect(byTs.get("1700000000.000100")!.text).toMatch(
      /^Bonjour à tous, <@U[A-Z0-9]+> 你好 and <@U[A-Z0-9]+> 안녕하세요 in <#C[A-Z0-9]+>$/,
    )
    expect(byTs.get("1700000000.000100")!.text).toContain(`<#${cafe}>`)
    expect(byTs.get("1700000100.000200")!.reply_count).toBe(2)
    expect(byTs.get("1700000700.000800")!.text).toBe(
      "Le plan\n[file not imported: plan.pdf]\n[file not imported: gone.png]\n[file not imported: old.png]\n[file not imported: nolink.txt]",
    )

    admin.clear()
    expect(await admin.run("import", "status")).toBe(0)
    expect(admin.out).toMatch(new RegExp(`^${job}  finished  acme\\.zip  `))
    admin.clear()
    expect(await admin.run("import", "status", job)).toBe(0)
    expect(admin.out).toContain("12 messages, 5 placeholders, 5 conversations created")
    admin.clear()
    expect(await admin.run("import", "status", job, "--json")).toBe(0)
    expect(JSON.parse(admin.out)).toMatchObject({ job: { id: job, state: "finished" } })

    // The same export again: refused, with how to start over.
    admin.clear()
    expect(await admin.run("import", "slack", "acme.zip")).toBe(1)
    expect(admin.err).toContain("already_imported")

    admin.clear()
    expect(await admin.run("import", "undo", job)).toBe(0)
    expect(admin.out).toMatch(new RegExp(`Undid import ${job}: removed .*12 messages`))
    admin.clear()
    expect(await admin.run("import", "undo", job, "--json")).toBe(0)
    expect(JSON.parse(admin.out)).toMatchObject({ job: { state: "undone" }, removed: {} })
  })

  it("downloads files with a Slack token, and continues an interrupted run", async () => {
    const { admin, email, client } = await setUp()
    withZip(admin, { "export.zip": exportZip(email, { zip64: true }) })
    // The first run dies after a few chunks.
    let calls = 0
    admin.io.fetch = async (input, init) => {
      if (String(input).endsWith("campflare.import.messages") && ++calls === 2) throw new Error("connection reset")
      return fetch(input, init)
    }
    const args = ["import", "slack", "export.zip", "--files", "download", "--slack-token", SLACK_TOKEN]
    expect(await admin.run(...args, "--slack-api", `${slackUrl}/api`)).toBe(1)
    expect(admin.err).toContain("connection reset")
    admin.clear()
    expect(await admin.run(...args, "--slack-api", `${slackUrl}/api`, "--merge-into-existing", "--json")).toBe(0)
    expect(admin.err).toContain("Resuming import J")
    expect(admin.err).toContain("(resumed after 2023-11-14.json)")
    const result = JSON.parse(admin.out) as { job: JobJson; failed_files: string[]; emoji: unknown }
    // Merging was the first run's choice: the job keeps its options.
    expect(result.job.options).toMatchObject({ merge_into_existing: false, files: "download" })
    expect(result.job.counts).toMatchObject({
      messages: 12,
      files: 3,
      files_attached: 1,
      files_skipped: 2,
      reactions: 2,
    })
    expect(result.failed_files).toEqual(["gone.png: HTTP 404", "nolink.txt: no download URL"])
    expect(result.emoji).toEqual({ imported: 0, skipped: 2 })

    const { channels } = await client.call<{ ok: boolean; channels: { id: string; name: string }[] }>(
      "conversations.list",
    )
    const general = channels.find((c) => c.name === "general-imported")!.id
    const history = await client.call<{
      ok: boolean
      messages: { ts: string; text: string; files?: { id: string; title: string }[] }[]
    }>("conversations.history", { channel: general })
    const withFile = history.messages.find((m) => m.ts === "1700000700.000800")!
    expect(withFile.text).toBe(
      "Le plan\n[file not imported: gone.png]\n[file not imported: old.png]\n[file not imported: nolink.txt]",
    )
    expect(withFile.files).toEqual([expect.objectContaining({ title: "Plan · 計画" })])
    const info = await client.call<{ ok: boolean; file: { url_private: string } }>("files.info", {
      file: withFile.files![0]!.id,
    })
    expect(await (await client.fetchFile(info.file.url_private)).text()).toBe("%PDF-1.4 le plan · 計画")
  })

  it("reports a wrong Slack token without failing the import", async () => {
    const { admin, email } = await setUp()
    withZip(admin, { "export.zip": exportZip(email) })
    expect(
      await admin.run(
        "import",
        "slack",
        "export.zip",
        "--files",
        "download",
        "--slack-token",
        "xoxp-wrong",
        "--slack-api",
        `${slackUrl}/api/`,
      ),
    ).toBe(0)
    expect(admin.out).toContain("file failed    plan.pdf: not authorized (check --slack-token)")
    expect(admin.err).toContain("Couldn't list the export's custom emoji: invalid_auth")
  })

  it("says what's wrong with how it was called", async () => {
    const { admin } = await setUp()
    withZip(admin, {
      "notes.zip": makeZip({ "readme.txt": "hello" }),
      "not.zip": new TextEncoder().encode("plain text"),
    })
    expect(await admin.run("import")).toBe(2)
    expect(await admin.run("import", "slack")).toBe(2)
    expect(await admin.run("import", "slack", "a.zip", "b.zip")).toBe(2)
    expect(await admin.run("import", "slack", "x.zip", "--files", "sometimes")).toBe(2)
    expect(await admin.run("import", "slack", "x.zip", "--files", "download")).toBe(2)
    expect(admin.err).toContain("--slack-token")
    expect(await admin.run("import", "undo")).toBe(2)
    expect(await admin.run("import", "slack", "notes.zip")).toBe(2)
    expect(admin.err).toContain("no users.json")
    expect(await admin.run("import", "slack", "not.zip")).toBe(1)
    expect(admin.err).toContain("not a zip file")

    // Members can't import.
    const member = memoryIo()
    const token = (
      await createClient({ url: baseUrl, token: admin.config!.profiles.default!.token! }).call<{
        ok: boolean
        token: string
      }>("campflare.users.create", { name: `m${Date.now() % 100000}` })
    ).token
    expect(await member.run("login", "--url", baseUrl, "--token", token)).toBe(0)
    expect(await member.run("import", "status", "--json")).toBe(1)
    expect(member.err).toContain("not_an_admin")
  })
})

describe("the zip reader", () => {
  it("reads stored, deflated and ZIP64 zips, with UTF-8 names and a comment", async () => {
    const files = { "a.json": "[1]", "東京/2023-01-01.json": '["café"]' }
    for (const opts of [{}, { store: true }, { zip64: true, comment: "Slack export" }]) {
      const zip = await openZip(memoryAccess(makeZip(files, opts)))
      expect(zip.entries.map((e) => e.name)).toEqual(Object.keys(files))
      expect(new TextDecoder().decode(await zip.read(zip.entries[1]!))).toBe('["café"]')
      expect(zip.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      await zip.close()
    }
    const same = await openZip(memoryAccess(makeZip(files)))
    const again = await openZip(memoryAccess(makeZip(files)))
    expect(same.fingerprint).toBe(again.fingerprint)
  })

  it("refuses what it can't read", async () => {
    await expect(openZip(memoryAccess(new Uint8Array(10)))).rejects.toThrow(ZipError)
    const good = makeZip({ "a.txt": "a" })
    // An end record pointing at a ZIP64 one that isn't there.
    const fake64 = new Uint8Array(good)
    const end = fake64.byteLength - 22
    new DataView(fake64.buffer).setUint16(end + 10, 0xffff, true)
    await expect(openZip(memoryAccess(fake64))).rejects.toThrow("broken ZIP64 zip")
    // A central directory that isn't one.
    const broken = new Uint8Array(good)
    const cdAt = new DataView(broken.buffer).getUint32(end + 16, true)
    broken[cdAt] = 0
    await expect(openZip(memoryAccess(broken))).rejects.toThrow("broken central directory")
    // A local header that isn't one; a method it doesn't know.
    const local = new Uint8Array(good)
    local[0] = 0
    const zip = await openZip(memoryAccess(local))
    await expect(zip.read(zip.entries[0]!)).rejects.toThrow("broken entry")
    const odd = await openZip(memoryAccess(good))
    await expect(odd.read({ ...odd.entries[0]!, method: 14 })).rejects.toThrow("compression method 14")
  })
})

describe("chunks", () => {
  it("splits by count and by size", () => {
    const m = (text: string) => ({ ts: "1.0", text })
    expect(chunks([m("a"), m("b"), m("c")], 2).map((c) => c.length)).toEqual([2, 1])
    expect(chunks([m("a".repeat(50)), m("b".repeat(50))], 10, 80).map((c) => c.length)).toEqual([1, 1])
    expect(chunks([])).toEqual([])
  })
})

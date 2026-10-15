import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { sunsetPng } from "../../../scripts/seed"
import { baseUrl, loggedIn, memoryIo } from "./harness"

describe("help and usage", () => {
  it("prints help and rejects unknown commands", async () => {
    const cli = memoryIo()
    expect(await cli.run()).toBe(2)
    expect(cli.out).toContain("Usage: campflare")
    expect(await cli.run("help")).toBe(0)
    expect(await cli.run("send", "--help")).toBe(0)
    expect(await cli.run("bogus")).toBe(2)
    expect(cli.err).toContain("unknown command: bogus")
    expect(await cli.run("send", "--nope")).toBe(2)
  })

  it("needs a login before talking to a server", async () => {
    const cli = memoryIo()
    expect(await cli.run("whoami")).toBe(2)
    expect(cli.err).toContain("not logged in")
    expect(await cli.run("login")).toBe(2)
    expect(await cli.run("bootstrap", "--url", baseUrl)).toBe(2)
  })
})

describe("accounts", () => {
  it("bootstraps, logs in with a second profile, and switches", async () => {
    const cli = await loggedIn()
    expect(cli.config?.current).toBe("default")
    expect(await cli.run("whoami")).toBe(0)
    expect(cli.out).toMatch(/^@owner \(U[A-Z0-9]+\) in CLI/)

    const token = cli.config!.profiles.default!.token!
    expect(await cli.run("token", "create", "--label", "second")).toBe(0)
    const second = cli.out.trim().split("\n").at(-1)!
    expect(second).toMatch(/^xoxp-/)
    cli.clear()
    expect(
      await cli.run("login", "--url", baseUrl, "--token", second, "--profile", "laptop", "--app-token", "xapp-x"),
    ).toBe(0)
    expect(cli.out).toContain("profile laptop")
    expect(cli.config?.current).toBe("laptop")
    cli.clear()
    expect(await cli.run("profiles", "--use", "default")).toBe(0)
    expect(cli.out).toContain("* default")
    expect(cli.out).toContain("  laptop")
    expect(cli.out).toContain("(+app token)")
    expect(await cli.run("profiles", "--use", "nope")).toBe(2)
    expect(await cli.run("whoami", "--profile", "nope")).toBe(2)
    expect(cli.config?.profiles.default?.token).toBe(token)

    cli.clear()
    expect(await cli.run("login", "--url", baseUrl, "--token", "xoxp-bad")).toBe(1)
    expect(cli.err).toContain("invalid_auth")
  })

  it("lets the environment override the profile", async () => {
    const owner = await loggedIn()
    const token = owner.config!.profiles.default!.token!
    const cli = memoryIo({ env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: token } })
    expect(await cli.run("whoami", "--json")).toBe(0)
    expect(JSON.parse(cli.out)).toMatchObject({ ok: true, user: "owner" })
  })

  it("reports a broken config file", async () => {
    const cli = memoryIo()
    await cli.io.writeConfig("{not json")
    expect(await cli.run("whoami")).toBe(2)
    expect(cli.err).toContain("not valid JSON")
  })

  it("sets a password from stdin or a hidden prompt, never from arguments", async () => {
    const admin = await loggedIn()
    const email = `amelie-${Date.now()}@example.test`
    expect(await admin.run("admin", "add-user", "amelie", "--email", email, "--json")).toBe(0)
    const { token } = JSON.parse(admin.out) as { token: string }
    const env = { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: token }
    const signIn = (password: string) =>
      fetch(`${baseUrl}/auth/sign-in/campflare-password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify({ email, password }),
      })

    const piped = memoryIo({ env, stdin: "Amélie à Montréal\n" })
    expect(await piped.run("password", "set")).toBe(0)
    expect(piped.out).toContain("Password set")
    expect((await signIn("Amélie à Montréal")).status).toBe(200)

    const typed = memoryIo({ env, secrets: ["アメリの新しい合言葉", "アメリの新しい合言葉"] })
    expect(await typed.run("password", "set")).toBe(0)
    expect((await signIn("アメリの新しい合言葉")).status).toBe(200)
    expect((await signIn("Amélie à Montréal")).status).toBe(401)

    const mistyped = memoryIo({ env, secrets: ["첫 번째 비밀번호", "두 번째 비밀번호"] })
    expect(await mistyped.run("password", "set")).toBe(2)
    expect(mistyped.err).toContain("differ")

    const short = memoryIo({ env, stdin: "short\n" })
    expect(await short.run("password", "set")).toBe(1)
    expect(short.err).toContain("invalid_password")
    expect(short.err).toContain("at least 10 characters")

    expect(await memoryIo({ env }).run("password", "set")).toBe(2) // no stdin, no terminal
    expect(await memoryIo({ env }).run("password", "show")).toBe(2)
  })

  it("mints a narrow, expiring token for an agent, and says what a token may do", async () => {
    const cli = await loggedIn()
    expect(await cli.run("whoami")).toBe(0)
    expect(cli.out).toContain("Role: owner. Scopes: ")
    expect(cli.out).toContain("admin.users:write")
    cli.clear()
    expect(await cli.run("token", "create", "--preset", "read", "--scopes", "chat:write", "--expires", "2h")).toBe(0)
    const agent = cli.out.trim()
    expect(agent).toMatch(/^xoxp-\S+$/) // the token alone, for TOKEN=$(…)
    expect(cli.err).toMatch(/^Scopes: .*chat:write; expires \d{4}-\d\d-\d\dT/)

    const env = { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: agent }
    const asAgent = memoryIo({ env })
    expect(await asAgent.run("whoami", "--json")).toBe(0)
    expect(JSON.parse(asAgent.out)).toMatchObject({ role: "owner", scopes: expect.arrayContaining(["chat:write"]) })
    asAgent.clear()
    expect(await asAgent.run("react", "#general", "1.000001", "eyes")).toBe(1)
    expect(asAgent.err).toContain("error: missing_scope (needs reactions:write; this token has ")
    expect(asAgent.err).toContain("campflare token create --scopes <scope>")
    asAgent.clear()
    expect(await asAgent.run("token", "create", "--json")).toBe(1)
    expect(JSON.parse(asAgent.err)).toMatchObject({ ok: false, error: "missing_scope", needed: "tokens:write" })

    cli.clear()
    expect(await cli.run("token", "list")).toBe(0)
    expect(cli.out).toMatch(/\[read,chat:write\]  expires /)
    expect(await cli.run("token", "create", "--expires", "soon")).toBe(2)
  })

  it("lists the methods and the scopes they need, without a token", async () => {
    const cli = memoryIo()
    expect(await cli.run("api", "--list", "chat.post", "--url", baseUrl)).toBe(0)
    expect(cli.out).toContain("chat.postMessage  (user, bot)  chat:write")
    expect(cli.out).toContain("chat.postEphemeral")
    expect(cli.out).not.toContain("reactions.add")
    cli.clear()
    expect(await cli.run("api", "--list", "rtm.", "--url", baseUrl)).toBe(0)
    expect(cli.out).toContain("rtm.connect  (user, bot)  rtm:stream + channels:history + ")
    cli.clear()
    expect(await cli.run("api", "--list", "conversations.history", "--url", baseUrl, "--json")).toBe(0)
    const listed = JSON.parse(cli.out) as {
      methods: { conversation_scope?: string }[]
      presets: Record<string, string[]>
    }
    expect(listed.methods[0]!.conversation_scope).toBe("history")
    expect(listed.presets.read).toContain("search:read")
    expect(await memoryIo().run("api", "--list")).toBe(2)
  })

  it("changes a person's role", async () => {
    const cli = await loggedIn()
    expect(await cli.run("admin", "add-user", "bruno")).toBe(0)
    cli.clear()
    expect(await cli.run("admin", "role", "@bruno", "admin")).toBe(0)
    expect(cli.out).toBe("@bruno is now an admin\n")
    cli.clear()
    expect(await cli.run("admin", "role", "@bruno", "member")).toBe(0)
    expect(cli.out).toBe("@bruno is now a member\n")
    expect(await cli.run("admin", "role", "@bruno")).toBe(2)
    expect(await cli.run("admin", "role", "@owner", "admin")).toBe(1)
    expect(cli.err).toContain("last_owner")
  })

  it("manages tokens", async () => {
    const cli = await loggedIn()
    expect(await cli.run("token", "create")).toBe(0)
    cli.clear()
    expect(await cli.run("token", "list")).toBe(0)
    // The newest token is the one just created, not the one this profile uses.
    const id = cli.out.trim().split("\n").at(-1)!.split(/\s+/)[0]!
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    cli.clear()
    expect(await cli.run("token", "list", "--json")).toBe(0)
    expect(JSON.parse(cli.out)).toHaveLength(2)
    cli.clear()
    expect(await cli.run("token", "revoke", id)).toBe(0)
    expect(cli.out).toBe("Revoked\n")
    cli.clear()
    expect(await cli.run("token", "revoke", "0000000000000000")).toBe(0)
    expect(cli.out).toBe("No such token\n")
    expect(await cli.run("token", "revoke")).toBe(2)
    expect(await cli.run("token", "frobnicate")).toBe(2)
  })
})

describe("messaging", () => {
  it("sends to #channels, @people and @me, from args or stdin, and reads history", async () => {
    const cli = await loggedIn()
    expect(await cli.run("admin", "add-user", "bob", "--name", "Bob Builder", "--email", "bob@x.test")).toBe(0)
    const bobToken = cli.out.match(/xoxp-\S+/)![0]
    cli.clear()

    expect(await cli.run("send", "#general", "hello", "<@UNOBODY>", "&amp;")).toBe(0)
    expect(cli.out).toMatch(/^Sent to #general \(ts \d+\.\d+\)/)
    expect(await cli.run("send", "@bob", "psst")).toBe(0)
    expect(await cli.run("send", "@Bob", "case-insensitive")).toBe(0)
    expect(await cli.run("send", "@me", "note to self")).toBe(0)
    expect(await cli.run("send", "#general", "--json", "as json")).toBe(0)

    const piped = memoryIo({ stdin: "from a pipe\n", env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: bobToken } })
    expect(await piped.run("send", "@owner")).toBe(0)

    cli.clear()
    expect(await cli.run("history", "#general", "-n", "5")).toBe(0)
    expect(cli.out).toMatch(/owner: hello @UNOBODY &\n/)
    expect(cli.out).toContain("as json")
    cli.clear()
    expect(await cli.run("history", "@bob")).toBe(0)
    expect(cli.out).toContain("owner: psst")
    expect(cli.out).toContain("bob: from a pipe")
    expect(await cli.run("history", "@me", "--json")).toBe(0)

    expect(await cli.run("send")).toBe(2)
    expect(await cli.run("send", "#general")).toBe(2)
    expect(await cli.run("send", "#nowhere", "x")).toBe(2)
    expect(await cli.run("send", "@nobody", "x")).toBe(2)
    expect(await cli.run("history")).toBe(2)
  })

  it("asks which person when a name is ambiguous", async () => {
    const cli = await loggedIn()
    await cli.run("admin", "add-user", "sam1", "--name", "Sam Smith")
    await cli.run("admin", "add-user", "sam2", "--name", "Sam Jones")
    cli.clear()
    expect(await cli.run("send", "@sam", "hi")).toBe(2)
    expect(cli.err).toContain("@sam matches 2 people")
    expect(await cli.run("send", "@jones", "hi")).toBe(0)
  })

  it("threads, reacts, edits and deletes", async () => {
    const cli = await loggedIn()
    await cli.run("send", "#general", "--json", "parent")
    const { channel, ts } = JSON.parse(cli.out) as { channel: string; ts: string }
    expect(await cli.run("send", channel, "a reply", "--thread", ts)).toBe(0)
    expect(await cli.run("react", "#general", ts, ":tada:")).toBe(0)
    expect(await cli.run("react", "#general", ts, "tada", "--remove")).toBe(0)
    expect(await cli.run("edit", "#general", ts, "parent", "edited")).toBe(0)
    cli.clear()
    expect(await cli.run("history", "#general", "--thread", ts)).toBe(0)
    expect(cli.out).toMatch(/owner: parent edited \(1 reply\)\n  ↳ .*owner: a reply\n/)
    expect(await cli.run("delete", channel, ts)).toBe(0)
    expect(await cli.run("react", "#general", ts)).toBe(2)
    expect(await cli.run("edit", "#general", ts)).toBe(2)
    expect(await cli.run("delete", "#general")).toBe(2)
    cli.clear()
    expect(await cli.run("react", "#general", "1.000001", "x")).toBe(1)
    expect(cli.err).toContain("message_not_found")
  })

  it("uploads files", async () => {
    const cli = await loggedIn()
    cli.io.readFile = memoryIo({ files: { "/tmp/a.txt": "aaa", "/tmp/b.log": "bbb" } }).io.readFile
    expect(await cli.run("send", "#general", "two files", "-f", "/tmp/a.txt", "-f", "/tmp/b.log")).toBe(0)
    expect(cli.out).toContain("Sent 2 files to #general")
    expect(await cli.run("send", "#general", "-f", "/tmp/a.txt", "--json")).toBe(0)
    cli.clear()
    expect(await cli.run("history", "#general", "-n", "2")).toBe(0)
    expect(cli.out).toContain("[a.txt, b.log]")
    expect(await cli.run("send", "#general", "-f", "/tmp/missing")).toBe(1)
  })

  it("searches", async () => {
    const cli = await loggedIn()
    await cli.run("send", "#general", "the deploy failed")
    await cli.run("send", "@me", "deploy notes")
    cli.clear()
    expect(await cli.run("search", "deploy")).toBe(0)
    expect(cli.out).toContain("#general  owner: the deploy failed")
    expect(cli.out).toMatch(/@owner {2}owner: deploy notes/)
    expect(cli.err).toBe("2 matches\n")
    cli.clear()
    expect(await cli.run("search", "deploy", "-n", "1", "--newest")).toBe(0)
    expect(cli.err).toBe("2 matches (page 1 of 2)\n")
    expect(await cli.run("search", "failed", "--json")).toBe(0)
    expect(await cli.run("search")).toBe(2)
  })
})

describe("scheduling", () => {
  it("schedules with send --at, lists and unschedules", async () => {
    const cli = await loggedIn()
    expect(await cli.run("scheduled")).toBe(0)
    expect(cli.out).toContain("No scheduled messages")
    cli.clear()
    expect(await cli.run("send", "#general", "Bis morgen", "--at", "2h")).toBe(0)
    expect(cli.out).toMatch(/^Scheduled for #general at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \(id Q[A-Z0-9]+\)\n$/)
    const at = new Date(Date.now() + 86_400_000).toISOString()
    cli.clear()
    expect(await cli.run("send", "#general", "明日", "--at", at, "--json")).toBe(0)
    const scheduled = JSON.parse(cli.out) as { scheduled_message_id: string; post_at: number; channel: string }
    expect(scheduled.post_at).toBe(Math.floor(Date.parse(at) / 1000))

    cli.clear()
    expect(await cli.run("scheduled", "#general")).toBe(0)
    expect(
      cli.out
        .trim()
        .split("\n")
        .map((l) => l.split("  ").at(-1)),
    ).toEqual(["Bis morgen", "明日"])
    expect(await cli.run("unschedule", "#general", scheduled.scheduled_message_id)).toBe(0)
    cli.clear()
    expect(await cli.run("scheduled", "--json")).toBe(0)
    expect((JSON.parse(cli.out) as { text: string }[]).map((m) => m.text)).toEqual(["Bis morgen"])

    expect(await cli.run("unschedule", "#general", scheduled.scheduled_message_id)).toBe(1)
    expect(cli.err).toContain("invalid_scheduled_message_id")
    expect(await cli.run("unschedule", "#general")).toBe(2)
    expect(await cli.run("send", "#general", "x", "--at", "someday")).toBe(2)
    expect(await cli.run("send", "#general", "x", "--at", "1h", "-f", "package.json")).toBe(2)
    expect(await cli.run("send", "#general", "x", "--at", "1700000000")).toBe(1)
    expect(cli.err).toContain("time_in_past")
  })

  it("sets, lists, completes and deletes reminders", async () => {
    const cli = await loggedIn()
    expect(await cli.run("reminders")).toBe(0)
    expect(cli.out).toContain("No reminders")
    cli.clear()
    expect(await cli.run("remind", "Llamar a Zoë", "in", "15", "minutes")).toBe(0)
    expect(cli.out).toMatch(/^Reminder set for \S+Z \(id Rm[A-Z0-9]+\)\n$/)
    const id = /id (Rm[A-Z0-9]+)/.exec(cli.out)![1]!
    cli.clear()
    expect(await cli.run("remind", "회의", "tomorrow at 9am", "--json")).toBe(0)
    const second = JSON.parse(cli.out) as { id: string; text: string }
    expect(second.text).toBe("회의")

    cli.clear()
    expect(await cli.run("reminder", "done", id)).toBe(0)
    expect(cli.out).toBe(`Completed ${id}\n`)
    cli.clear()
    expect(await cli.run("reminders")).toBe(0)
    expect(cli.out).toMatch(new RegExp(`^${id}  \\S+  done  Llamar a Zoë\\n${second.id}  \\S+        회의\\n$`))
    expect(await cli.run("reminder", "delete", second.id)).toBe(0)
    cli.clear()
    expect(await cli.run("reminders", "--json")).toBe(0)
    expect((JSON.parse(cli.out) as { id: string }[]).map((r) => r.id)).toEqual([id])

    expect(await cli.run("remind", "x", "whenever")).toBe(1)
    expect(cli.err).toContain("cannot_parse")
    expect(await cli.run("remind", "x")).toBe(2)
    expect(await cli.run("reminder", "snooze", id)).toBe(2)
    expect(await cli.run("reminder", "done")).toBe(2)
  })
})

describe("workspace", () => {
  it("lists channels and people; creates, joins, invites and leaves", async () => {
    const cli = await loggedIn()
    await cli.run("admin", "add-user", "bob", "--admin")
    const bobToken = cli.out.match(/xoxp-\S+/)![0]
    const bob = memoryIo({ env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: bobToken } })
    cli.clear()
    expect(await cli.run("create-channel", "#dev")).toBe(0)
    expect(cli.out).toMatch(/Created #dev \(C/)
    expect(await cli.run("create-channel", "secret", "--private")).toBe(0)
    expect(await cli.run("send", "@bob", "hi")).toBe(0)
    cli.clear()
    expect(await cli.run("channels")).toBe(0)
    expect(cli.out).toContain("#dev")
    expect(cli.out).toContain("#secret 🔒")
    expect(cli.out).toContain("@bob")
    expect(await cli.run("channels", "--all", "--json")).toBe(0)

    expect(await bob.run("join", "#dev")).toBe(0)
    expect(bob.out).toContain("Joined #dev")
    expect(await bob.run("join", "#nope")).toBe(2)
    expect(await bob.run("leave", "#dev")).toBe(0)
    expect(await cli.run("invite", "#secret", "@bob")).toBe(0)
    bob.clear()
    expect(await bob.run("channels")).toBe(0)
    expect(bob.out).toContain("#secret")

    cli.clear()
    expect(await cli.run("users")).toBe(0)
    expect(cli.out).toMatch(/@bob/)
    expect(await cli.run("users", "--json")).toBe(0)
    expect(await cli.run("create-channel")).toBe(2)
    expect(await cli.run("join")).toBe(2)
    expect(await cli.run("leave")).toBe(2)
    expect(await cli.run("invite", "#dev")).toBe(2)
  })

  it("lets a bot name public channels it hasn't joined, as it may post there", async () => {
    const cli = await loggedIn()
    expect(await cli.run("admin", "add-app", "Poster", "--json")).toBe(0)
    const { bot_token } = JSON.parse(cli.out) as { bot_token: string }
    const bot = memoryIo({ env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: bot_token } })
    expect(await bot.run("send", "#general", "from the bot")).toBe(0)
    expect(await bot.run("send", "#nowhere", "x")).toBe(2)
    expect(bot.err).toContain("you're not in #nowhere")
  })

  it("adds apps and calls raw API methods", async () => {
    const cli = await loggedIn()
    expect(await cli.run("admin", "add-app", "Deploy", "Bot")).toBe(0)
    expect(cli.out).toMatch(/Bot token: xoxb-\S+\nApp token: xapp-\S+\nSigning secret: [0-9a-f]{32}\n/)
    cli.clear()
    expect(await cli.run("admin", "add-app", "Other", "--json")).toBe(0)
    const other = JSON.parse(cli.out) as { app: { id: string }; signing_secret: string }

    // Its settings, and a Request URL checked with url_verification by an app listening here.
    const listener = createServer((req, res) => {
      let body = ""
      req.on("data", (d: Buffer) => (body += d))
      req.on("end", () => res.end((JSON.parse(body) as { challenge?: string }).challenge ?? ""))
    })
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/events`
    try {
      cli.clear()
      expect(await cli.run("admin", "app", other.app.id)).toBe(0)
      expect(cli.out).toContain(
        `Signing secret: ${other.signing_secret}\nRequest URL: none (Socket Mode only)\nEvents: all`,
      )
      cli.clear()
      expect(await cli.run("admin", "app", other.app.id, "--request-url", url, "--events", "app_mention")).toBe(0)
      expect(cli.out).toContain(`Request URL: ${url}\nEvents: app_mention\n`)
      expect(cli.out).not.toContain("Last delivery")
      // Every event again, one delivered: how it went shows.
      expect(await cli.run("admin", "app", other.app.id, "--events", "")).toBe(0)
      expect(await cli.run("send", "#general", "for the app")).toBe(0)
      for (let tries = 0; !/Last 60 min: 1 attempts/.test(cli.out) && tries < 100; tries++) {
        await new Promise((r) => setTimeout(r, 50))
        cli.clear()
        expect(await cli.run("admin", "app", other.app.id)).toBe(0)
      }
      expect(cli.out).toMatch(
        /Last delivery: \d{4}-\d\d-\d\d \d\d:\d\d, ok \(HTTP 200\)\nLast 60 min: 1 attempts, 0 failed, 0 waiting to retry\n/,
      )
      cli.clear()
      expect(await cli.run("admin", "app", other.app.id, "--request-url", "", "--json")).toBe(0)
      expect(JSON.parse(cli.out)).toMatchObject({ app: { event_subscriptions: { request_url: null } } })
      cli.clear()
      expect(await cli.run("admin", "app", other.app.id, "--rotate-secret")).toBe(0)
      const rotated = /Signing secret: ([0-9a-f]{32})\n/.exec(cli.out)?.[1]
      expect(rotated).toBeDefined()
      expect(rotated).not.toBe(other.signing_secret)
      expect(cli.out).toContain("The old signing secret no longer signs anything")
      cli.clear()
      expect(await cli.run("admin", "app", other.app.id, "--request-url", "https://campflare.invalid/x")).toBe(1)
      expect(cli.err).toMatch(/^error: url_verification_failed \[ERROR\] no answer from the Request URL/)
      expect(await cli.run("admin", "app")).toBe(2)
    } finally {
      listener.close()
    }
    expect(await cli.run("admin", "add-user", "carol", "--json")).toBe(0)
    expect(await cli.run("admin", "add-user")).toBe(2)
    expect(await cli.run("admin", "add-app")).toBe(2)
    expect(await cli.run("admin", "nope")).toBe(2)
    cli.clear()
    expect(await cli.run("api", "conversations.list", "limit=1")).toBe(0)
    expect(JSON.parse(cli.out)).toMatchObject({ ok: true, channels: [{ name: "general" }] })
    expect(await cli.run("api")).toBe(2)
    expect(await cli.run("api", "auth.test", "novalue")).toBe(2)
    cli.clear()
    expect(await cli.run("api", "chat.postMessage", "channel=CNOPE", "text=x")).toBe(1)
    expect(cli.err).toBe("error: channel_not_found\n")
    cli.clear()
    expect(await cli.run("api", "campflare.users.create")).toBe(1)
    expect(cli.err).toContain("invalid_arguments [ERROR] missing required field: name")
  })
})

describe("buttons", () => {
  it("lists a message's buttons, clicks one, and sets the app's Interactivity URL", async () => {
    const cli = await loggedIn()
    await cli.run("admin", "add-app", "Deploy", "--json")
    const app = JSON.parse(cli.out) as { app: { id: string }; bot_token: string }
    const bot = memoryIo({ env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: app.bot_token } })
    const blocks = [
      {
        type: "actions",
        block_id: "decide",
        elements: [
          { type: "button", action_id: "approve", text: { type: "plain_text", text: "Approve" }, value: "pr-42" },
        ],
      },
      {
        type: "context_actions",
        block_id: "rate",
        elements: [
          {
            type: "feedback_buttons",
            action_id: "feedback",
            positive_button: { text: { type: "plain_text", text: "Good" }, value: "up" },
            negative_button: { text: { type: "plain_text", text: "Bad" }, value: "down" },
          },
        ],
      },
    ]
    expect(
      await bot.run("api", "chat.postMessage", "channel=#general", "text=Ship it?", `blocks=${JSON.stringify(blocks)}`),
    ).toBe(0)
    const { ts } = JSON.parse(bot.out) as { ts: string }

    cli.clear()
    expect(await cli.run("click", "#general", ts)).toBe(0)
    expect(cli.out).toBe(
      "approve  Approve  --value pr-42  --block decide\n" +
        "feedback  Good  --value up  --block rate\n" +
        "feedback  Bad  --value down  --block rate\n",
    )
    cli.clear()
    expect(await cli.run("click", "#general", ts, "--json")).toBe(0)
    expect(JSON.parse(cli.out)).toHaveLength(3)

    cli.clear()
    expect(await cli.run("click", "#general", ts, "approve")).toBe(1)
    expect(cli.err).toBe("error: interactivity_not_enabled\n")

    // An app listening here takes the click.
    const payloads: Record<string, unknown>[] = []
    const listener = createServer((req, res) => {
      let body = ""
      req.on("data", (d: Buffer) => (body += d))
      req.on("end", () => {
        payloads.push(JSON.parse(new URLSearchParams(body).get("payload")!) as Record<string, unknown>)
        res.end()
      })
    })
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/interactive`
    try {
      cli.clear()
      expect(await cli.run("admin", "app", app.app.id, "--interactivity-url", url)).toBe(0)
      expect(cli.out).toContain(`Interactivity URL: ${url}\n`)
      cli.clear()
      expect(await cli.run("click", "#general", ts, "feedback", "--value", "down", "--block", "rate")).toBe(0)
      expect(cli.out).toBe("Clicked: the app took it (HTTP); if it opened a view: campflare view list\n")
      expect(payloads[0]).toMatchObject({ type: "block_actions", actions: [{ action_id: "feedback", value: "down" }] })
      cli.clear()
      expect(await cli.run("click", "#general", ts, "approve", "--json")).toBe(0)
      expect(JSON.parse(cli.out)).toEqual({ ok: true, delivered: "http" })
      cli.clear()
      expect(await cli.run("admin", "app", app.app.id, "--interactivity-url", "", "--json")).toBe(0)
      expect(JSON.parse(cli.out)).toMatchObject({ app: { interactivity: { request_url: null } } })
    } finally {
      listener.close()
    }

    // A message without buttons, one that isn't there, and missing arguments.
    cli.clear()
    await cli.run("send", "#general", "--json", "plain")
    const plain = (JSON.parse(cli.out) as { ts: string }).ts
    cli.clear()
    expect(await cli.run("click", "#general", plain)).toBe(0)
    expect(cli.out).toBe("No buttons in that message\n")
    expect(await cli.run("click", "#general", "1000000000.000001")).toBe(2)
    expect(await cli.run("click", "#general")).toBe(2)
  })
})

describe("select menus and modals", () => {
  it("chooses in a select, then opens, fills in and submits the modal the app opens", async () => {
    const cli = await loggedIn()
    await cli.run("admin", "add-app", "Forms", "--json")
    const app = JSON.parse(cli.out) as { app: { id: string }; bot_token: string }
    const text = (t: string) => ({ type: "plain_text", text: t })
    const option = (t: string, value: string) => ({ text: text(t), value })
    const form = {
      type: "modal",
      callback_id: "deploy",
      title: text("Deploy"),
      submit: text("Go"),
      blocks: [
        {
          type: "input",
          block_id: "note",
          label: text("Note"),
          element: { type: "plain_text_input", action_id: "text" },
        },
        {
          type: "input",
          block_id: "who",
          label: text("Reviewer"),
          element: { type: "users_select", action_id: "pick" },
        },
        {
          type: "input",
          block_id: "checks",
          label: text("Checks"),
          optional: true,
          element: { type: "checkboxes", action_id: "boxes", options: [option("Migrar", "m"), option("Prüfen", "p")] },
        },
      ],
    }
    // The app: opens the form on "open", refuses a short note, else closes it.
    const payloads: Record<string, unknown>[] = []
    const listener = createServer((req, res) => {
      let body = ""
      req.on("data", (d: Buffer) => (body += d))
      req.on("end", () => {
        const payload = JSON.parse(new URLSearchParams(body).get("payload")!) as Record<string, unknown> & {
          trigger_id: string
          actions?: { action_id: string }[]
          view?: { state: { values: { note: { text: { value: string } } } } }
        }
        payloads.push(payload)
        if (payload.type === "view_submission") {
          const short = payload.view!.state.values.note.text.value.length < 3
          res.setHeader("content-type", "application/json")
          res.end(short ? JSON.stringify({ response_action: "errors", errors: { note: "Too short" } }) : "")
          return
        }
        res.end()
        if (payload.actions?.[0]?.action_id !== "open") return
        void fetch(`${baseUrl}/api/views.open`, {
          method: "POST",
          headers: { authorization: `Bearer ${app.bot_token}`, "content-type": "application/json" },
          body: JSON.stringify({ trigger_id: payload.trigger_id, view: form }),
        })
      })
    })
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/interactive`
    try {
      expect(await cli.run("admin", "app", app.app.id, "--interactivity-url", url)).toBe(0)
      const bot = memoryIo({ env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: app.bot_token } })
      const blocks = [
        {
          type: "section",
          block_id: "env",
          text: { type: "mrkdwn", text: "Where?" },
          accessory: {
            type: "static_select",
            action_id: "pick",
            placeholder: text("Environment"),
            options: [option("Production", "prod"), option("Staging", "staging")],
          },
        },
        {
          type: "actions",
          block_id: "more",
          elements: [
            { type: "users_select", action_id: "who" },
            { type: "channels_select", action_id: "where" },
            { type: "button", action_id: "open", text: text("Deploy…") },
          ],
        },
      ]
      expect(
        await bot.run("api", "chat.postMessage", "channel=#general", "text=Where?", `blocks=${JSON.stringify(blocks)}`),
      ).toBe(0)
      const { ts } = JSON.parse(bot.out) as { ts: string }

      cli.clear()
      expect(await cli.run("click", "#general", ts)).toBe(0)
      expect(cli.out).toBe(
        "pick  Environment (static_select)  --option prod|staging  --block env\n" +
          "who  (users_select)  --user <@person>  --block more\n" +
          "where  (channels_select)  --conversation <#channel>  --block more\n" +
          "open  Deploy…  --block more\n",
      )
      expect(await cli.run("click", "#general", ts, "pick", "--option", "staging")).toBe(0)
      expect(await cli.run("click", "#general", ts, "who", "--user", "@me")).toBe(0)
      expect(await cli.run("click", "#general", ts, "where", "--conversation", "#general")).toBe(0)
      expect(payloads.map((p) => (p.actions as Record<string, unknown>[])[0])).toMatchObject([
        { type: "static_select", selected_option: { value: "staging" } },
        { type: "users_select", selected_user: expect.stringMatching(/^U/) },
        { type: "channels_select", selected_channel: expect.stringMatching(/^C/) },
      ])

      cli.clear()
      expect(await cli.run("view", "list")).toBe(0)
      expect(cli.out).toBe("No views open\n")
      expect(await cli.run("click", "#general", ts, "open")).toBe(0)
      let views: { id: string }[] = []
      for (let i = 0; i < 100 && views.length === 0; i++) {
        cli.clear()
        await cli.run("view", "list", "--json")
        views = JSON.parse(cli.out) as { id: string }[]
        if (views.length === 0) await new Promise((r) => setTimeout(r, 20))
      }
      const id = views[0]!.id
      cli.clear()
      expect(await cli.run("view", "list")).toBe(0)
      expect(cli.out).toBe(
        `${id}  Deploy  (deploy)  [shown]\n` +
          "  --value note.text=…  Note (plain_text_input)\n" +
          "  --value who.pick=…  Reviewer (users_select)  a @person\n" +
          "  --value checks.boxes=…  Checks (checkboxes, optional)  one of m|p\n" +
          `  submit: campflare view submit ${id} --value block.action=value …\n`,
      )

      cli.clear()
      expect(await cli.run("view", "submit", id, "--value", "note.text=ok", "--value", "who.pick=@me")).toBe(1)
      expect(cli.err).toBe("note: Too short\n")
      cli.clear()
      expect(await cli.run("view", "submit", id, "--value", "who.pick=@me")).toBe(1)
      expect(cli.err).toBe("note: Please complete this required field.\n")
      cli.clear()
      const args = ["--value", "note.text=Ship it", "--value", "who.pick=@me"]
      expect(
        await cli.run("view", "submit", id, ...args, "--value", "checks.boxes=m", "--value", "checks.boxes=p"),
      ).toBe(0)
      expect(cli.out).toBe("Submitted: the app took it (HTTP)\n")
      expect(payloads.at(-1)).toMatchObject({
        type: "view_submission",
        view: {
          state: {
            values: {
              note: { text: { value: "Ship it" } },
              who: { pick: { selected_user: expect.stringMatching(/^U/) } },
              checks: { boxes: { selected_options: [{ value: "m" }, { value: "p" }] } },
            },
          },
        },
      })

      // Opened again, then closed.
      expect(await cli.run("click", "#general", ts, "open")).toBe(0)
      for (let i = 0; i < 100; i++) {
        cli.clear()
        await cli.run("view", "list", "--json")
        views = JSON.parse(cli.out) as { id: string }[]
        if (views.length > 0) break
        await new Promise((r) => setTimeout(r, 20))
      }
      cli.clear()
      expect(await cli.run("view", "close", views[0]!.id)).toBe(0)
      expect(cli.out).toBe("Closed\n")
      expect(await cli.run("view", "submit", views[0]!.id)).toBe(2)
      expect(await cli.run("view", "submit", "V1", "--value", "nodot=1")).toBe(2)
      expect(await cli.run("view")).toBe(2)
      expect(await cli.run("view", "close")).toBe(2)
      expect(await cli.run("view", "click", "V1")).toBe(2)
      cli.clear()
      expect(await cli.run("view", "click", "V1", "x")).toBe(1)
      expect(cli.err).toBe("error: not_found\n")
    } finally {
      listener.close()
    }
  })
})

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe("apps", () => {
  async function withBot() {
    const owner = await loggedIn()
    await owner.run("admin", "add-app", "Writer", "--json")
    const { bot_token } = JSON.parse(owner.out) as { bot_token: string }
    owner.clear()
    const bot = (opts: Parameters<typeof memoryIo>[0] = {}) =>
      memoryIo({ ...opts, env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: bot_token } })
    return { owner, bot }
  }

  it("streams piped markdown into one message, piece by piece, after a status", async () => {
    const { owner, bot } = await withBot()
    await owner.run("send", "#general", "Résumez, s'il vous plaît", "--json")
    const { ts: question } = JSON.parse(owner.out) as { ts: string }
    owner.clear()
    // A piece over Slack's 12,000 characters goes in several appends.
    const long = "長".repeat(12_001)
    const cli = bot({ stdinChunks: ["**Résumé**", " : 早安", "", ` ${long}`] })
    expect(
      await cli.run(
        "stream",
        "#general",
        "--thread",
        question,
        "--status",
        "is thinking…",
        "--blocks",
        '[{"type":"divider"}]',
      ),
    ).toBe(0)
    expect(cli.err).toMatch(/^Streaming to #general \(ts \d+\.\d+\)\n$/)
    expect(cli.out).toMatch(/^Streamed 12017 characters to #general/)
    expect(await owner.run("history", "#general", "--thread", question, "--json")).toBe(0)
    const [, reply] = JSON.parse(owner.out) as { text: string; blocks: { type: string }[]; streaming_state: string }[]
    expect(reply).toMatchObject({ text: `**Résumé** : 早安 ${long}`, streaming_state: "completed" })
    expect(reply!.blocks.map((b) => b.type)).toEqual(["markdown", "divider"])
  })

  it("streams into a DM from all of stdin, and to someone named with --to", async () => {
    const { owner, bot } = await withBot()
    const whole = bot({ stdin: "Hola\n" })
    expect(await whole.run("stream", "@owner", "--json")).toBe(0)
    expect(JSON.parse(whole.out)).toMatchObject({ channel: expect.stringMatching(/^D/), message: { text: "Hola" } })
    const named = bot({ stdinChunks: ["Annyeong"] })
    expect(await named.run("stream", "#general", "--to", "@owner")).toBe(0)
    expect(await owner.run("history", "#general", "-n", "1", "--json")).toBe(0)
    expect(JSON.parse(owner.out)).toMatchObject([{ text: "Annyeong", streaming_state: "completed" }])
  })

  it("stops a stream as a person, and the streaming CLI stops reading", async () => {
    const { owner, bot } = await withBot()
    await owner.run("send", "#general", "Cuéntame", "--json")
    const { ts: question } = JSON.parse(owner.out) as { ts: string }
    owner.clear()
    let streamTs = ""
    const cli = bot({
      stdinChunks: async function* () {
        yield "Érase una vez"
        streamTs = /\(ts (\d+\.\d+)\)/.exec(cli.err)![1]!
        expect(await owner.run("stop", "#general", streamTs)).toBe(0)
        yield " 昔々"
        yield " never read"
      },
    })
    expect(await cli.run("stream", "#general", "--thread", question)).toBe(0)
    expect(owner.out).toBe(`Stopped the reply in #general (ts ${streamTs}) at 13 characters\n`)
    expect(cli.out).toBe(`Stopped by someone in #general after 13 characters (ts ${streamTs})\n`)
    owner.clear()
    expect(await owner.run("history", "#general", "--thread", question, "--json")).toBe(0)
    const [, reply] = JSON.parse(owner.out) as { text: string; streaming_state: string }[]
    expect(reply).toMatchObject({ text: "Érase una vez", streaming_state: "completed" })
    // Only once, and only with a ts.
    expect(await owner.run("stop", "#general", streamTs, "--json")).toBe(1)
    expect(owner.err).toContain("message_not_in_streaming_state")
    expect(await owner.run("stop", "#general")).toBe(2)

    const json = bot({
      stdinChunks: async function* () {
        yield "x"
        await owner.run("stop", "#general", /\(ts (\d+\.\d+)\)/.exec(json.err)![1]!, "--json")
        yield "y"
      },
    })
    expect(await json.run("stream", "#general", "--thread", question, "--json")).toBe(0)
    expect(JSON.parse(json.out)).toMatchObject({ stopped_by_user: true })
    expect(owner.out).toMatch(/"streaming_state": ?"completed"/)
  })

  it("sets and clears a status", async () => {
    const { owner, bot } = await withBot()
    await owner.run("send", "#general", "?", "--json")
    const { ts } = JSON.parse(owner.out) as { ts: string }
    const cli = bot()
    expect(await cli.run("status", "#general", ts, "is", "looking")).toBe(0)
    expect(cli.out).toBe("Status set in #general: is looking\n")
    cli.clear()
    expect(await cli.run("status", "#general", ts)).toBe(0)
    expect(cli.out).toBe("Status cleared in #general\n")
    expect(await cli.run("status", "#general", "1.000001", "x")).toBe(1)
    expect(cli.err).toContain("invalid_thread_ts")
  })

  it("says what's missing", async () => {
    const { owner, bot } = await withBot()
    const cli = bot({ stdinChunks: ["x"] })
    expect(await cli.run("stream")).toBe(2)
    expect(await cli.run("stream", "#general", "--status", "x")).toBe(2)
    expect(cli.err).toContain("--status needs --thread")
    expect(await cli.run("stream", "#general", "--blocks", "{")).toBe(2)
    expect(cli.err).toContain("--blocks wants a JSON array")
    expect(await cli.run("stream", "#general")).toBe(2)
    expect(cli.err).toContain("give --to @person or --thread")
    expect(await bot().run("stream", "#general")).toBe(2)
    expect(await cli.run("status", "#general")).toBe(2)
    // A thread whose first message is gone has no one to answer.
    await owner.run("send", "#general", "gone soon", "--json")
    const { ts } = JSON.parse(owner.out) as { ts: string }
    await owner.run("delete", "#general", ts)
    expect(await cli.run("stream", "#general", "--thread", ts)).toBe(1)
    // A person's token is told to use a bot's.
    const person = memoryIo({
      stdinChunks: ["x"],
      env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: owner.config!.profiles.default!.token! },
    })
    expect(await person.run("stream", "#general", "--to", "@me")).toBe(2)
    expect(person.err).toContain("stream acts as an app: use its bot token")
    expect(await person.run("status", "#general", "1.000001")).toBe(2)
  })
})

describe("listen", () => {
  it("streams RTM events until interrupted", async () => {
    const cli = await loggedIn()
    const done = cli.run("listen")
    await until(() => cli.err.includes("[connected]"))
    const other = memoryIo({ env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: cli.config!.profiles.default!.token! } })
    await other.run("send", "#general", "live", "message")
    other.clear()
    await other.run("send", "#general", "--json", "x")
    const { ts } = JSON.parse(other.out) as { ts: string }
    await other.run("react", "#general", ts, "eyes")
    await until(() => cli.out.includes("reaction_added"))
    cli.interrupt()
    expect(await done).toBe(0)
    expect(cli.out).toMatch(/C[A-Z0-9]+ {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}owner: live message/)
    expect(cli.out).toContain("reaction_added")
  })

  it("streams Socket Mode envelopes as JSON with an app token", async () => {
    const cli = await loggedIn()
    await cli.run("admin", "add-app", "Listener", "--json")
    const app = JSON.parse(cli.out) as { app_token: string }
    const token = cli.config!.profiles.default!.token!
    const listener = memoryIo()
    await listener.run("login", "--url", baseUrl, "--token", token, "--app-token", app.app_token)
    const done = listener.run("listen", "--socket", "--json")
    await until(() => listener.err.includes("[connected]"))
    await cli.run("send", "#general", "over socket mode")
    await until(() => listener.out.includes("over socket mode"))
    listener.interrupt()
    expect(await done).toBe(0)
    expect(JSON.parse(listener.out.trim().split("\n").at(-1)!)).toMatchObject({
      type: "message",
      text: "over socket mode",
    })
  })

  it("needs an app token for Socket Mode", async () => {
    const cli = await loggedIn()
    expect(await cli.run("listen", "--socket")).toBe(2)
    expect(cli.err).toContain("Socket Mode needs an app token")
  })
})

describe("events", () => {
  it("polls the event log from a cursor and prints where to resume", async () => {
    const cli = await loggedIn()
    expect(await cli.run("events")).toBe(0)
    const start = cli.err.match(/^cursor (\d+)$/m)![1]!
    expect(cli.out).toBe("")
    await cli.run("send", "#general", "logged event")
    cli.clear()
    expect(await cli.run("events", "--cursor", start, "--wait", "5")).toBe(0)
    expect(cli.out).toMatch(/^\d+ {2}C[A-Z0-9]+ {2}.*owner: logged event$/m)
    expect(cli.err).toMatch(/^cursor \d+/)
    cli.clear()
    expect(await cli.run("events", "--cursor", start, "--json")).toBe(0)
    const first = JSON.parse(cli.out.trim().split("\n")[0]!) as { cursor: string; event: { text: string } }
    expect(first.event.text).toBe("logged event")
    cli.clear()
    expect(await cli.run("events", "--cursor", "nope")).toBe(1)
    expect(cli.err).toContain("invalid_cursor")
  })

  it("follows until interrupted", async () => {
    const cli = await loggedIn()
    const done = cli.run("events", "--follow", "--wait", "2")
    await new Promise((r) => setTimeout(r, 300))
    await memoryIo({ env: { CAMPFLARE_URL: baseUrl, CAMPFLARE_TOKEN: cli.config!.profiles.default!.token! } }).run(
      "send",
      "#general",
      "followed event",
    )
    await until(() => cli.out.includes("followed event"))
    cli.interrupt()
    expect(await done).toBe(0)
    expect(cli.out).toContain("owner: followed event")
  })

  it("reports gaps and errors while following", async () => {
    const cli = await loggedIn()
    const done = cli.run("events", "--follow", "--cursor", "999999", "--wait", "1")
    await until(() => cli.err.includes("[error: invalid_cursor"))
    cli.interrupt()
    expect(await done).toBe(0)
  })
})

describe("profiles and groups", () => {
  it("shows and sets a profile: title, status with an expiry, photo", async () => {
    const cli = await loggedIn()
    const png = await sunsetPng(96, 96)
    cli.io.readFile = async (path) => {
      if (path !== "/tmp/yo.png") throw new Error(`ENOENT: ${path}`)
      return png
    }
    expect(await cli.run("profile")).toBe(0)
    expect(cli.out).toContain("Olive Owner")
    expect(cli.out).toContain("Photo: none (initials)")
    cli.clear()
    expect(
      await cli.run(
        "profile",
        "--title",
        "Jefa · 部長",
        "--status",
        "En vacances",
        "--emoji",
        ":palm_tree:",
        "--until",
        "2h",
      ),
    ).toBe(0)
    expect(cli.out).toContain("Title: Jefa · 部長")
    expect(cli.out).toMatch(/Status: :palm_tree: En vacances \(until \d{4}-\d\d-\d\dT/)
    cli.clear()
    expect(await cli.run("profile", "--photo", "/tmp/yo.png", "--json")).toBe(0)
    const shown = JSON.parse(cli.out) as { is_custom_image: boolean; image_192: string; status_expiration: number }
    expect(shown.is_custom_image).toBe(true)
    expect((await fetch(shown.image_192)).status).toBe(200)
    expect(shown.status_expiration).toBeGreaterThan(Date.now() / 1000 + 3500)
    cli.clear()
    expect(await cli.run("profile", "--status", "", "--remove-photo")).toBe(0)
    expect(cli.out).not.toContain("Status:")
    expect(cli.out).toContain("Photo: none (initials)")

    expect(await cli.run("admin", "add-user", "kenji", "--name", "Kenji Sato")).toBe(0)
    cli.clear()
    expect(await cli.run("profile", "@kenji")).toBe(0)
    expect(cli.out).toContain("Kenji Sato")
    expect(await cli.run("profile", "@kenji", "--title", "x")).toBe(2)
    expect(await cli.run("profile", "--emoji", ":x:")).toBe(2)
    expect(await cli.run("profile", "--photo", "/tmp/yo.png", "--remove-photo")).toBe(2)
    expect(await cli.run("profile", "--status", "x", "--until", "soon")).toBe(2)
  })

  it("creates groups, fills and lists them, and turns them off and on", async () => {
    const cli = await loggedIn()
    await cli.run("admin", "add-user", "ines", "--name", "Inès Moreau")
    await cli.run("admin", "add-user", "minjun", "--name", "Min-jun Park")
    cli.clear()
    expect(await cli.run("groups")).toBe(0)
    expect(cli.out).toContain("No groups yet")
    cli.clear()
    expect(
      await cli.run(
        "group",
        "create",
        "@diseno",
        "--name",
        "Diseño · 디자인",
        "--members",
        "@ines,@me",
        "--channels",
        "#general",
      ),
    ).toBe(0)
    expect(cli.out).toMatch(/Created @diseno \(S[A-Z0-9]+\)/)
    expect(cli.out).toContain("(2 members)")
    cli.clear()
    expect(await cli.run("group", "add", "diseno", "@minjun")).toBe(0)
    expect(cli.out).toContain("(3 members)")
    cli.clear()
    expect(await cli.run("group", "remove", "@diseno", "@ines", "--json")).toBe(0)
    const group = JSON.parse(cli.out) as { id: string; users: string[]; prefs: { channels: string[] } }
    expect(group.users).toHaveLength(2)
    expect(group.prefs.channels).toHaveLength(1)
    cli.clear()
    expect(await cli.run("group", "update", "diseno", "--description", "Équipe de design", "--handle", "design")).toBe(
      0,
    )
    expect(cli.out).toContain("Updated @design")
    cli.clear()
    expect(await cli.run("group", "show", group.id)).toBe(0)
    expect(cli.out).toContain("Équipe de design")
    expect(await cli.run("group", "disable", "design")).toBe(0)
    cli.clear()
    expect(await cli.run("groups")).toBe(0)
    expect(cli.out).not.toContain("@design")
    expect(await cli.run("groups", "--all")).toBe(0)
    expect(cli.out).toContain("disabled")
    cli.clear()
    expect(await cli.run("group", "enable", "design")).toBe(0)
    expect(cli.out).toContain("Enabled @design")
    cli.clear()
    expect(await cli.run("groups", "--json")).toBe(0)
    expect(JSON.parse(cli.out)).toMatchObject([{ handle: "design", user_count: 2 }])

    expect(await cli.run("group", "show", "nope")).toBe(2)
    expect(await cli.run("group", "add", "design")).toBe(2)
    cli.clear()
    expect(await cli.run("group", "remove", "design", "@minjun", "@me")).toBe(2)
    expect(cli.err).toContain("campflare group disable design")
    expect(await cli.run("group", "frobnicate", "design")).toBe(2)
    expect(await cli.run("group")).toBe(2)
    cli.clear()
    expect(await cli.run("group", "create", "design")).toBe(1)
    expect(cli.err).toContain("handle_already_exists")
  })
})

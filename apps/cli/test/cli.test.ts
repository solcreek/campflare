import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
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
      expect(cli.out).toBe("Clicked: the app took it (HTTP)\n")
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

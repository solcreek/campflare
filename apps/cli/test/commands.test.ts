import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { commandLine, commandSpec } from "../src/run"
import { loggedIn } from "./harness"

describe("--command specs", () => {
  it("reads /name:description:usage hint", () => {
    expect(commandSpec("/deploy:Deploy a branch:[branch] [env:prod]", "https://x.example")).toEqual({
      command: "/deploy",
      description: "Deploy a branch",
      usage_hint: "[branch] [env:prod]",
      url: "https://x.example",
    })
    expect(commandSpec("/部署")).toEqual({ command: "/部署", description: "", usage_hint: "" })
    expect(() => commandSpec("deploy:x")).toThrow("--command starts with")
    expect(commandLine({ command: "/café", usage_hint: "", description: "Un café" })).toBe("/café  Un café")
  })
})

describe("slash commands", () => {
  it("registers an app's commands, lists them and runs one, printing the app's answer", async () => {
    const cli = await loggedIn()
    await cli.run("admin", "add-app", "Deployer", "--json")
    const app = JSON.parse(cli.out) as { app: { id: string } }

    const seen: URLSearchParams[] = []
    let reply = JSON.stringify({ text: "Déploiement de staging 开始" })
    const listener = createServer((req, res) => {
      let body = ""
      req.on("data", (d: Buffer) => (body += d))
      req.on("end", () => {
        seen.push(new URLSearchParams(body))
        res.setHeader("content-type", "application/json")
        res.end(reply)
      })
    })
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r))
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/commands`
    try {
      cli.clear()
      expect(
        await cli.run(
          "admin",
          "app",
          app.app.id,
          "--command",
          "/deploy:Deploy a branch:[branch]",
          "--command",
          "/배포:브랜치 배포",
          "--command-url",
          url,
        ),
      ).toBe(0)
      expect(cli.out).toContain(
        `Slash commands:\n  /deploy [branch]  Deploy a branch  → ${url}\n  /배포  브랜치 배포  → ${url}\n`,
      )

      cli.clear()
      expect(await cli.run("commands")).toBe(0)
      expect(cli.out).toBe("/deploy [branch]  Deploy a branch  (Deployer)\n/배포  브랜치 배포  (Deployer)\n")
      cli.clear()
      expect(await cli.run("commands", "--json")).toBe(0)
      expect(JSON.parse(cli.out)).toHaveLength(2)

      cli.clear()
      expect(await cli.run("command", "#general", "/deploy", "staging", "now")).toBe(0)
      expect(cli.out).toBe("Déploiement de staging 开始\n")
      expect(cli.err).toBe("Only you can see this\n")
      expect(Object.fromEntries(seen[0]!)).toMatchObject({
        command: "/deploy",
        text: "staging now",
        channel_name: "general",
      })

      reply = JSON.stringify({ response_type: "in_channel", text: "Shipped" })
      cli.clear()
      expect(await cli.run("command", "#general", "deploy", "--json")).toBe(0)
      expect(JSON.parse(cli.out)).toMatchObject({
        delivered: "http",
        response: { response_type: "in_channel", text: "Shipped" },
      })
      reply = ""
      cli.clear()
      expect(await cli.run("command", "#general", "/deploy")).toBe(0)
      expect(cli.err).toBe("/deploy went to its app (HTTP)\n")

      cli.clear()
      expect(await cli.run("command", "#general", "/nope")).toBe(1)
      expect(cli.err).toBe("error: command_not_found\n")
      expect(await cli.run("command", "#general")).toBe(2)
      expect(await cli.run("admin", "app", app.app.id, "--command-url", url)).toBe(2)
      // A usage error changes nothing: the secret isn't rotated unseen.
      cli.clear()
      await cli.run("admin", "app", app.app.id, "--json")
      const secret = (JSON.parse(cli.out) as { app: { signing_secret: string } }).app.signing_secret
      expect(await cli.run("admin", "app", app.app.id, "--rotate-secret", "--command", "deploy:no slash")).toBe(2)
      expect(await cli.run("admin", "app", app.app.id, "--command", "/a", "--clear-commands")).toBe(2)
      cli.clear()
      await cli.run("admin", "app", app.app.id, "--json")
      expect((JSON.parse(cli.out) as { app: { signing_secret: string } }).app.signing_secret).toBe(secret)

      cli.clear()
      expect(await cli.run("admin", "app", app.app.id, "--clear-commands")).toBe(0)
      expect(cli.out).toContain("Slash commands: none\n")
      cli.clear()
      expect(await cli.run("commands")).toBe(0)
      expect(cli.out).toBe("No slash commands yet\n")
    } finally {
      listener.close()
    }
  })
})

describe("incoming webhooks", () => {
  it("creates one, prints its URL alone, lists and revokes it", async () => {
    const cli = await loggedIn()
    await cli.run("admin", "add-app", "Alerts", "--json")
    const app = JSON.parse(cli.out) as { app: { id: string } }
    cli.clear()
    expect(await cli.run("admin", "webhook", "create", app.app.id, "#general", "--label", "CI")).toBe(0)
    const url = cli.out.trim()
    expect(url).toMatch(/\/services\/[0-9a-f]{48}$/)
    expect(cli.err).toMatch(/^Webhook H[0-9A-Z]+ posts in #general/)
    const posted = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Build vert ✅" }),
    })
    expect(await posted.text()).toBe("ok")

    cli.clear()
    expect(await cli.run("admin", "webhooks", app.app.id)).toBe(0)
    const [id, where, label] = cli.out.trim().split("  ")
    expect([where, label]).toEqual(["#general", "CI"])
    expect(cli.out).toContain("last used ")
    cli.clear()
    expect(await cli.run("admin", "webhooks", app.app.id, "--json")).toBe(0)
    expect(JSON.parse(cli.out)).toEqual([expect.objectContaining({ id, label: "CI" })])

    cli.clear()
    expect(await cli.run("admin", "webhook", "revoke", id!)).toBe(0)
    expect(cli.out).toBe(`Revoked webhook ${id}: its URL answers no_service now\n`)
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(404)
    cli.clear()
    expect(await cli.run("admin", "webhooks", app.app.id)).toBe(0)
    expect(cli.out).toBe(`No webhooks for ${app.app.id}\n`)
    expect(await cli.run("admin", "webhook", "create", app.app.id)).toBe(2)
    expect(await cli.run("admin", "webhook", "revoke")).toBe(2)
    expect(await cli.run("admin", "webhooks")).toBe(2)
  })
})

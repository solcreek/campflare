import type { Fetch } from "@campflare/client"
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isGrouped } from "@/components/message-list"
import { Markdown, Mrkdwn } from "@/components/mrkdwn"
import { formatRoute, parseRoute } from "@/route"
import {
  browserStore,
  desktopStore,
  devSession,
  FILE_SESSION_NOTICE,
  type Invoke,
  noticeFileSession,
  platformStore,
  revokeSession,
} from "@/session"
import { followSystemTheme } from "@/theme"
import { WorkspaceProvider, useWorkspace } from "@/workspace"
import { fakeServer } from "./server"

interface FakeShell {
  kept: unknown
  refuse: boolean
  calls: string[]
  invoke: Invoke
}

/** The shell's session_* commands over an in-memory keychain. */
function fakeShell(): FakeShell {
  const shell: FakeShell = {
    kept: null,
    refuse: false,
    calls: [],
    invoke: async (command, args) => {
      shell.calls.push(command)
      if (command === "session_load") return shell.kept
      if (shell.refuse) throw new Error("User canceled the operation.")
      if (command === "session_save") shell.kept = args?.session
      if (command === "session_clear") shell.kept = null
    },
  }
  return shell
}

describe("session", () => {
  afterEach(() => localStorage.clear())

  it("keeps a session in storage and ignores garbage", async () => {
    const store = browserStore()
    expect(await store.load()).toBeNull()
    await store.save({ url: "https://x.test", token: "xoxp-1" })
    expect(await store.load()).toEqual({ url: "https://x.test", token: "xoxp-1" })
    await store.clear()
    expect(await store.load()).toBeNull()
    localStorage.setItem("campflare.session", "{not json")
    expect(await store.load()).toBeNull()
    localStorage.setItem("campflare.session", JSON.stringify({ url: "https://x.test" }))
    expect(await store.load()).toBeNull()
    localStorage.setItem("campflare.session", JSON.stringify({ url: "https://x.test", token: 1 }))
    expect(await store.load()).toBeNull()
  })

  it("keeps how the session was obtained, and treats older sessions as pasted tokens", async () => {
    const store = browserStore()
    await store.save({ url: "https://x.test", token: "xoxp-1", via: "oauth" })
    expect(await store.load()).toEqual({ url: "https://x.test", token: "xoxp-1", via: "oauth" })
    // Kept by a build before `via`: no field, so never revoked on sign-out.
    localStorage.setItem("campflare.session", JSON.stringify({ url: "https://x.test", token: "xoxp-1" }))
    const old = await store.load()
    expect(old).toEqual({ url: "https://x.test", token: "xoxp-1" })
    expect(await revokeSession(old!)).toBe(false)
    // Anything else in it is dropped, not trusted.
    localStorage.setItem("campflare.session", JSON.stringify({ url: "https://x.test", token: "xoxp-1", via: "magic" }))
    expect(await store.load()).toEqual({ url: "https://x.test", token: "xoxp-1" })
  })

  it("revokes an OAuth session's token on its server, and only that, at best effort", async () => {
    const seen: { url: string; auth: string | null }[] = []
    const answer =
      (body: unknown): Fetch =>
      async (input, init) => {
        seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") })
        return Response.json(body)
      }
    const oauth = { url: "https://x.test", token: "xoxp-1", via: "oauth" } as const
    expect(await revokeSession(oauth, { fetch: answer({ ok: true, revoked: true }) })).toBe(true)
    expect(seen).toEqual([{ url: "https://x.test/api/auth.revoke", auth: "Bearer xoxp-1" }])

    // A pasted token is the person's: not even asked about.
    seen.length = 0
    const pasted = { ...oauth, via: "token" } as const
    expect(await revokeSession(pasted, { fetch: answer({ ok: true, revoked: true }) })).toBe(false)
    expect(seen).toEqual([])

    // An error answer or an unreachable server: false, never a throw.
    expect(await revokeSession(oauth, { fetch: answer({ ok: false, error: "invalid_auth" }) })).toBe(false)
    expect(await revokeSession(oauth, { fetch: () => Promise.reject(new TypeError("Failed to fetch")) })).toBe(false)

    // A server that never answers: given up on after the timeout, and the request aborted.
    let aborted: AbortSignal | undefined
    const hanging: Fetch = (_input, init) => {
      aborted = init?.signal ?? undefined
      return new Promise(() => {})
    }
    expect(await revokeSession(oauth, { fetch: hanging, timeoutMs: 20 })).toBe(false)
    expect(aborted?.aborted).toBe(true)
  })

  const one = { url: "https://x.test", token: "xoxp-1" }
  const two = { url: "https://y.test", token: "xoxp-2" }

  it("carries how the session was obtained through the keychain", async () => {
    const shell = fakeShell()
    const store = desktopStore(shell.invoke)
    await store.save({ ...one, via: "oauth" })
    expect(shell.kept).toEqual({ ...one, via: "oauth" })
    expect(await store.load()).toEqual({ ...one, via: "oauth" })
  })

  it("uses the keychain in the desktop shell and localStorage in a browser", async () => {
    const shell = fakeShell()
    await platformStore({ __TAURI__: { core: { invoke: shell.invoke } } }).save(one)
    expect(shell.kept).toEqual(one)
    expect(localStorage.getItem("campflare.session")).toBeNull()

    await platformStore({}).save(two)
    await platformStore({ __TAURI__: {} }).save(two)
    expect(await platformStore().load()).toEqual(two)
    expect(shell.calls).toEqual(["session_save"])
  })

  it("keeps a session in the keychain", async () => {
    const shell = fakeShell()
    const store = desktopStore(shell.invoke)
    expect(await store.load()).toBeNull()
    await store.save(one)
    expect(await store.load()).toEqual(one)
    await store.clear()
    expect(shell.kept).toBeNull()
    expect(await store.load()).toBeNull()
    shell.kept = { url: "https://x.test" }
    expect(await store.load()).toBeNull()
  })

  it("moves a session from localStorage into the keychain", async () => {
    const shell = fakeShell()
    await browserStore().save(one)
    expect(await desktopStore(shell.invoke).load()).toEqual(one)
    expect(shell.kept).toEqual(one)
    expect(localStorage.getItem("campflare.session")).toBeNull()

    // The keychain's session wins over a leftover one, which goes.
    await browserStore().save(two)
    expect(await desktopStore(shell.invoke).load()).toEqual(one)
    expect(localStorage.getItem("campflare.session")).toBeNull()
  })

  it("still signs in when the keychain refuses the move, and signs out of both", async () => {
    const shell = fakeShell()
    shell.refuse = true
    const store = desktopStore(shell.invoke)
    await browserStore().save(one)
    expect(await store.load()).toEqual(one)
    expect(shell.kept).toBeNull()
    expect(await browserStore().load()).toEqual(one)
    await expect(store.save(two)).rejects.toThrow("User canceled")

    shell.refuse = false
    await store.clear()
    expect(await browserStore().load()).toBeNull()
    expect(await store.load()).toBeNull()
  })

  it("says once, the first time, that the session went to a file", async () => {
    const shell = fakeShell()
    let backend: unknown = "file"
    const invoke: Invoke = async (command, args) => {
      await shell.invoke(command, args)
      return command === "session_save" ? backend : shell.kept
    }
    const shown: string[] = []
    const notice = noticeFileSession((message) => shown.push(message))
    const store = platformStore({ __TAURI__: { core: { invoke } } }, notice)
    await store.save(one)
    expect(shown).toEqual([FILE_SESSION_NOTICE])
    // Not again, in this launch or the next.
    await store.save(two)
    await desktopStore(
      invoke,
      browserStore(),
      noticeFileSession((m) => shown.push(m)),
    ).save(one)
    expect(shown).toHaveLength(1)

    // The keychain, or an older shell that answers nothing, is no news.
    localStorage.clear()
    for (backend of ["keychain", undefined]) await store.save(one)
    expect(shown).toHaveLength(1)
    // A session moved out of localStorage counts as a save.
    backend = "file"
    shell.kept = null
    await browserStore().save(two)
    expect(await store.load()).toEqual(two)
    expect(shown).toHaveLength(2)

    // Storage that can't remember still lets it be said.
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
    }
    noticeFileSession((m) => shown.push(m), broken)("file")
    expect(shown).toHaveLength(3)
  })

  it("signs in as the dev server's people", () => {
    const dev = { url: "http://localhost:8787", people: { alex: "xoxp-a", vincent: "xoxp-v" } }
    expect(devSession(null, "")).toBeNull()
    expect(devSession(dev, "")).toEqual({ url: dev.url, token: "xoxp-a" })
    expect(devSession(dev, "?as=vincent")).toEqual({ url: dev.url, token: "xoxp-v" })
    expect(devSession(dev, "?as=nobody")).toBeNull()
  })
})

describe("route", () => {
  it("round-trips through the hash", () => {
    expect(parseRoute("")).toEqual({ channel: undefined, thread: undefined })
    expect(parseRoute("#/C1")).toEqual({ channel: "C1", thread: undefined })
    expect(parseRoute("#/C1/1700000000.000100")).toEqual({ channel: "C1", thread: "1700000000.000100" })
    expect(formatRoute({})).toBe("#/")
    expect(formatRoute({ channel: "C1" })).toBe("#/C1")
    expect(formatRoute({ channel: "C1", thread: "1.2" })).toBe("#/C1/1.2")
  })

  it("carries the message a link points at", () => {
    expect(parseRoute("#/C1?msg=1700000000.000100")).toEqual({ channel: "C1", message: "1700000000.000100" })
    expect(parseRoute("#/C1/1700000000.000100?msg=1700000000.000200")).toEqual({
      channel: "C1",
      thread: "1700000000.000100",
      message: "1700000000.000200",
    })
    expect(parseRoute("#/C1?other=1")).toEqual({ channel: "C1", thread: undefined })
    expect(formatRoute({ channel: "C1", message: "1.2" })).toBe("#/C1?msg=1.2")
    expect(formatRoute({ channel: "C1", thread: "1.2", message: "1.3" })).toBe("#/C1/1.2?msg=1.3")
    expect(formatRoute({ message: "1.2" })).toBe("#/")
  })
})

describe("theme", () => {
  it("follows the system's dark mode", () => {
    let listener: (() => void) | undefined
    const query = {
      matches: true,
      addEventListener: (_: string, l: () => void) => (listener = l),
      removeEventListener: vi.fn<() => void>(),
    }
    vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList)
    const root = document.createElement("html")
    const stop = followSystemTheme(root)
    expect(root.classList.contains("dark")).toBe(true)
    query.matches = false
    listener!()
    expect(root.classList.contains("dark")).toBe(false)
    stop()
    expect(query.removeEventListener).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

const m = (ts: string, extra = {}) => ({ ts, channel: "C1", user: "U1", ...extra })

function renderText(text: string) {
  const server = fakeServer()
  return render(
    <WorkspaceProvider workspace={server.connect()}>
      <Mrkdwn text={text} />
    </WorkspaceProvider>,
  )
}

function Probe() {
  useWorkspace()
  return null
}

describe("isGrouped", () => {
  it("groups one person's messages within five minutes", () => {
    expect(isGrouped(undefined, m("100"))).toBe(false)
    expect(isGrouped(m("100"), m("200"))).toBe(true)
    expect(isGrouped(m("100"), m("500"))).toBe(false)
    expect(isGrouped(m("100"), m("200", { user: "U2" }))).toBe(false)
    expect(isGrouped(m("100", { reply_count: 2 }), m("200"))).toBe(false)
    expect(isGrouped(m("100", { subtype: "channel_join" }), m("200"))).toBe(false)
    expect(isGrouped(m("100"), m("~1", { pending: true }))).toBe(true)
    expect(isGrouped(m("100"), { ts: "200", channel: "C1" })).toBe(false)
  })
})

describe("Mrkdwn", () => {
  it("renders markup as elements", () => {
    const { container } = renderText(
      "_it_ ~st~ `code` <https://x.test|site> <!here> :tada: :custom: <@U9|ada> <#C9|ops> <#C8>\n&gt; quoted\n```pre```",
    )
    expect(container.querySelector("em")?.textContent).toBe("it")
    expect(container.querySelector("s")?.textContent).toBe("st")
    expect(container.querySelector("code")?.textContent).toBe("code")
    expect(screen.getByRole("link", { name: "site" }).getAttribute("href")).toBe("https://x.test")
    expect(screen.getByText("@here")).toBeTruthy()
    expect(screen.getByRole("img", { name: "tada" }).textContent).toBe("🎉")
    expect(screen.getByText(":custom:")).toBeTruthy()
    expect(screen.getByText("@ada")).toBeTruthy()
    expect(screen.getByText("#ops")).toBeTruthy()
    expect(screen.getByText("#C8")).toBeTruthy()
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted")
    expect(container.querySelector("pre")?.textContent).toBe("pre")
  })

  it("never links anything but web and mail addresses", () => {
    renderText("<javascript:alert(1)|click> <mailto:a@x.test|mail>")
    expect(screen.queryByRole("link", { name: "click" })).toBeNull()
    expect(screen.getByText("click", { exact: false })).toBeTruthy()
    expect(screen.getByRole("link", { name: "mail" })).toBeTruthy()
  })
})

describe("Markdown", () => {
  it("renders headings, lists, quotes, code and rules as elements", () => {
    const server = fakeServer()
    const { container } = render(
      <WorkspaceProvider workspace={server.connect()}>
        <Markdown
          text={
            "### Notas del día\n3. tercero\n4. cuarto\n\n- 早安\n\n> citado\n\n---\n```\n**not bold**\n```\n[bad](javascript:alert(1))"
          }
        />
      </WorkspaceProvider>,
    )
    expect(screen.getByRole("heading", { name: "Notas del día", level: 3 })).toBeTruthy()
    const [ordered, bullets] = screen.getAllByRole("list")
    expect(ordered!.tagName).toBe("OL")
    expect(ordered!.getAttribute("start")).toBe("3")
    expect(bullets!.tagName).toBe("UL")
    expect(bullets!.getAttribute("start")).toBeNull()
    expect(container.querySelector("blockquote")?.textContent).toBe("citado")
    expect(screen.getByRole("separator")).toBeTruthy()
    expect(container.querySelector("pre")?.textContent).toBe("**not bold**")
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull()
  })
})

describe("useWorkspace", () => {
  it("needs a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow("useWorkspace needs a WorkspaceProvider")
    vi.restoreAllMocks()
  })
})

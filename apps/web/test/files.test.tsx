import type { Message, NewFile } from "@campflare/core"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "@/app"
import { browserStore } from "@/session"
import { ALEX, fakeServer, FakeSocket, hello, VINCENT } from "./server"
import { ViewportObserver } from "./setup"

afterEach(() => {
  FakeSocket.all = []
  localStorage.clear()
  vi.restoreAllMocks()
})

const FILES = "https://x.test/files-pri/T1-"

const withFiles: Message = {
  ts: "1700000500.000000",
  channel: "CGEN",
  user: VINCENT,
  text: "photos and the report",
  upload: true,
  files: [
    {
      id: "F1",
      name: "tokyo.png",
      title: "東京の夜",
      alt_txt: "Nachtansicht von Tokio",
      mimetype: "image/png",
      size: 2048,
      original_w: 1600,
      original_h: 900,
      url_private: `${FILES}F1/tokyo.png`,
      url_private_download: `${FILES}F1/download/tokyo.png`,
    },
    {
      id: "F2",
      name: "informe-año.pdf",
      title: "Informe del año",
      mimetype: "application/pdf",
      pretty_type: "PDF",
      size: 1536,
      url_private: `${FILES}F2/informe-a%C3%B1o.pdf`,
      url_private_download: `${FILES}F2/download/informe-a%C3%B1o.pdf`,
    },
    {
      id: "F3",
      name: "seoul.webp",
      title: "서울",
      mimetype: "image/webp",
      size: 10,
      url_private: `${FILES}F3/seoul.webp`,
    },
    { id: "F4", mode: "tombstone" },
  ],
}

async function signedIn(messages: Message[] = [withFiles], prepare?: (server: ReturnType<typeof fakeServer>) => void) {
  const server = fakeServer({ "conversations.history": () => ({ messages }) })
  prepare?.(server)
  const store = browserStore()
  store.save({ url: "https://x.test", token: "xoxp-1" })
  const user = userEvent.setup()
  render(<App store={store} connect={server.connect} />)
  await screen.findByRole("heading", { name: "general", level: 1 })
  act(() => hello())
  return { server, user }
}

const log = () => screen.getByRole("log", { name: "Messages" })

describe("files in messages", () => {
  it("shows images inline with the token's bytes, other files as cards", async () => {
    // F3 isn't there (404): it falls back to a card.
    const { server: s, user } = await signedIn([withFiles], (server) => {
      server.api.files[`${FILES}F1/tokyo.png`] = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    })

    const image = (await within(log()).findByRole("img", { name: "Nachtansicht von Tokio" })) as HTMLImageElement
    expect(image.src).toMatch(/^blob:/)
    // 1600×900 scaled into 360×240.
    expect([image.width, image.height]).toEqual([360, 203])
    expect(image.title).toBe("東京の夜")
    expect(s.api.fileRequests.find((r) => r.url.endsWith("tokyo.png"))?.headers.authorization).toBe("Bearer xoxp-1")

    const report = within(log()).getByRole("group", { name: "File: informe-año.pdf" })
    expect(within(report).getByText("Informe del año")).toBeTruthy()
    expect(within(report).getByText("1.5 KB · PDF")).toBeTruthy()
    await within(log()).findByRole("group", { name: "File: seoul.webp" })
    expect(within(log()).getByText("This file was deleted.")).toBeTruthy()

    // Download: fetched with the token, saved through an object URL.
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    s.api.files[`${FILES}F2/download/informe-a%C3%B1o.pdf`] = "%PDF"
    await user.click(within(report).getByRole("button", { name: "Download informe-año.pdf" }))
    await waitFor(() => expect(click).toHaveBeenCalledOnce())
    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toBe("informe-año.pdf")
    expect(link.href).toMatch(/^blob:/)

    // A failed download says so.
    const seoul = within(log()).getByRole("group", { name: "File: seoul.webp" })
    await user.click(within(seoul).getByRole("button", { name: "Download seoul.webp" }))
    expect(await screen.findByText(/Couldn't download seoul\.webp/)).toBeTruthy()
  })

  it("shows a placeholder while an image loads, and keeps no card for files without a URL", async () => {
    await signedIn(
      [
        {
          ...withFiles,
          files: [
            { id: "F1", name: "slow.png", mimetype: "image/png", url_private: `${FILES}F1/slow.png` },
            { id: "F5", name: "external" },
          ],
        },
      ],
      (server) => (server.api.client.fetchFile = () => new Promise(() => {})),
    )
    expect(within(log()).getByRole("img", { name: "Loading slow.png" })).toBeTruthy()
    const external = within(log()).getByRole("group", { name: "File: external" })
    expect(within(external).queryByRole("button")).toBeNull()
  })
})

describe("lazy images", () => {
  const far: Message = {
    ts: "1700000400.000000",
    channel: "CGEN",
    user: ALEX,
    text: "早い写真",
    files: [
      {
        id: "F6",
        name: "plage-été.jpg",
        mimetype: "image/jpeg",
        original_w: 600,
        original_h: 1200,
        url_private: `${FILES}F6/plage.jpg`,
      },
    ],
  }

  it("fetches an image only once it nears the viewport, in a box of its final size", async () => {
    ViewportObserver.manual = true
    const { server } = await signedIn([withFiles, far], (s) => {
      s.api.files[`${FILES}F1/tokyo.png`] = new Uint8Array([1])
      s.api.files[`${FILES}F6/plage.jpg`] = new Uint8Array([2])
    })
    const fetched = () => server.api.fileRequests.map((r) => r.url.split("/").pop())
    const plage = within(log()).getByRole("button", { name: "Open plage-été.jpg" })
    const tokyo = within(log()).getByRole("button", { name: "Open Nachtansicht von Tokio" })
    // Nothing is fetched yet, and the placeholders already take the images' room: 600×1200 in 360×240.
    const placeholder = within(plage).getByRole("img", { name: "Loading plage-été.jpg" })
    expect([placeholder.style.width, placeholder.style.height]).toEqual(["120px", "240px"])
    expect(fetched()).toEqual([])

    act(() => ViewportObserver.show(plage, false))
    expect(fetched()).toEqual([])
    act(() => ViewportObserver.show(plage))
    const image = (await within(plage).findByRole("img", { name: "plage-été.jpg" })) as HTMLImageElement
    expect([image.width, image.height]).toEqual([120, 240])
    expect(fetched()).toEqual(["plage.jpg"])
    expect(within(tokyo).getByRole("img", { name: "Loading Nachtansicht von Tokio" })).toBeTruthy()

    // Seen once is enough: it stays loaded, and isn't observed any more.
    act(() => ViewportObserver.show(plage, false))
    expect(within(plage).getByRole("img", { name: "plage-été.jpg" })).toBeTruthy()
    act(() => ViewportObserver.show(tokyo))
    await within(tokyo).findByRole("img", { name: "Nachtansicht von Tokio" })
    expect(fetched()).toEqual(["plage.jpg", "tokyo.png"])
    // Only the image not yet near the viewport (seoul.webp) is still watched.
    expect([...ViewportObserver.all].flatMap((o) => [...o.targets])).toEqual([
      within(log()).getByRole("button", { name: "Open 서울" }),
    ])
  })

  it("loads every image where there's no IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined)
    try {
      await signedIn([far], (s) => (s.api.files[`${FILES}F6/plage.jpg`] = new Uint8Array([2])))
      expect(await within(log()).findByRole("img", { name: "plage-été.jpg" })).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("thumbnails", () => {
  const TMB = "https://x.test/files-tmb/T1-"
  const thumbs = {
    thumb_360: `${TMB}F1/tokyo_360.png`,
    thumb_360_w: 360,
    thumb_360_h: 203,
    thumb_720: `${TMB}F1/tokyo_720.png`,
    thumb_720_w: 720,
    thumb_720_h: 405,
  }
  const withThumbs: Message = { ...withFiles, files: [{ ...withFiles.files![0]!, ...thumbs }] }
  const fetched = (server: ReturnType<typeof fakeServer>) => server.api.fileRequests.map((r) => r.url.split("/").pop())

  afterEach(() => vi.unstubAllGlobals())

  it("draws an image from the thumbnail that fits its box on this screen, and the viewer from the original", async () => {
    vi.stubGlobal("devicePixelRatio", 2)
    const { server, user } = await signedIn([withThumbs], (s) => {
      s.api.files[thumbs.thumb_720] = new Uint8Array([7])
      s.api.files[`${FILES}F1/tokyo.png`] = new Uint8Array([1])
    })
    const image = (await within(log()).findByRole("img", { name: "Nachtansicht von Tokio" })) as HTMLImageElement
    expect([image.width, image.height]).toEqual([360, 203])
    expect(fetched(server)).toEqual(["tokyo_720.png"])
    expect(server.api.fileRequests[0]!.headers.authorization).toBe("Bearer xoxp-1")

    await user.click(within(log()).getByRole("button", { name: "Open Nachtansicht von Tokio" }))
    await within(screen.getByRole("dialog", { name: "東京の夜" })).findByRole("img", {
      name: "Nachtansicht von Tokio",
    })
    expect(fetched(server)).toEqual(["tokyo_720.png", "tokyo.png"])
  })

  it("takes the smaller thumbnail at 1x, and the original when the thumbnail fails", async () => {
    vi.stubGlobal("devicePixelRatio", 1)
    const { server } = await signedIn([withThumbs], (s) => {
      // thumb_360 isn't there (404).
      s.api.files[`${FILES}F1/tokyo.png`] = new Uint8Array([1])
    })
    const image = (await within(log()).findByRole("img", { name: "Nachtansicht von Tokio" })) as HTMLImageElement
    expect(image.src).toMatch(/^blob:/)
    expect(fetched(server)).toEqual(["tokyo_360.png", "tokyo.png"])
  })
})

describe("the image viewer", () => {
  const twoImages: Message = {
    ...withFiles,
    files: [
      withFiles.files![0]!,
      { ...withFiles.files![2]!, url_private_download: `${FILES}F3/download/seoul.webp` },
      withFiles.files![1]!,
    ],
  }

  it("opens an image full size, steps through the message's images, downloads and closes", async () => {
    const { server, user } = await signedIn([twoImages], (s) => {
      s.api.files[`${FILES}F1/tokyo.png`] = new Uint8Array([1])
      s.api.files[`${FILES}F3/seoul.webp`] = new Uint8Array([2])
    })
    await within(log()).findByRole("img", { name: "서울" })
    await user.click(await within(log()).findByRole("button", { name: "Open Nachtansicht von Tokio" }))

    let viewer = screen.getByRole("dialog", { name: "東京の夜" })
    // The dialog takes focus, not Download: Enter right after opening saves nothing.
    await waitFor(() => expect(document.activeElement).toBe(viewer))
    expect(within(viewer).getByText("1 of 2 · tokyo.png · 2 KB")).toBeTruthy()
    const big = within(viewer).getByRole("img", { name: "Nachtansicht von Tokio" }) as HTMLImageElement
    expect(big.src).toMatch(/^blob:/)
    // The same bytes as inline: fetched once.
    expect(server.api.fileRequests.filter((r) => r.url.endsWith("tokyo.png"))).toHaveLength(1)

    // Arrow keys step through the images and wrap around; the PDF isn't one of them.
    await user.keyboard("{ArrowRight}")
    viewer = screen.getByRole("dialog", { name: "서울" })
    expect(within(viewer).getByText("2 of 2 · seoul.webp · 10 B")).toBeTruthy()
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("dialog", { name: "東京の夜" })).toBeTruthy()
    await user.keyboard("{ArrowLeft}")
    expect(screen.getByRole("dialog", { name: "서울" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Previous image" }))
    expect(screen.getByRole("dialog", { name: "東京の夜" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Next image" }))
    viewer = screen.getByRole("dialog", { name: "서울" })
    // Other keys do nothing.
    await user.keyboard("a")
    expect(screen.getByRole("dialog", { name: "서울" })).toBeTruthy()

    // Download saves the one shown, under its file name.
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    server.api.files[`${FILES}F3/download/seoul.webp`] = new Uint8Array([2])
    await user.click(within(viewer).getByRole("button", { name: "Download seoul.webp" }))
    await waitFor(() => expect(click).toHaveBeenCalledOnce())
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("seoul.webp")

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    // The close button closes it too.
    await user.click(within(log()).getByRole("button", { name: "Open 서울" }))
    expect(screen.getByRole("dialog", { name: "서울" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    // And so does a click outside it.
    await user.click(within(log()).getByRole("button", { name: "Open 서울" }))
    expect(screen.getByRole("dialog", { name: "서울" })).toBeTruthy()
    await user.click(document.body)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("wraps a long title instead of widening the dialog past the window, keeping the full name", async () => {
    const title =
      "夏の終わりの花火大会で撮った写真、そしてヴェルサイユ宮殿での閉会のソワレ — la soirée de clôture au château"
    const name = "花火大会_et_la_soirée_de_clôture_au_château_de_Versailles.png"
    const small: Message = {
      ...withFiles,
      files: [
        {
          id: "F8",
          name,
          title,
          mimetype: "image/png",
          size: 320,
          original_w: 48,
          original_h: 32,
          url_private: `${FILES}F8/small.png`,
        },
      ],
    }
    const { server, user } = await signedIn([small], (s) => {
      s.api.files[`${FILES}F8/small.png`] = new Uint8Array([3])
    })
    await user.click(await within(log()).findByRole("button", { name: `Open ${title}` }))
    const viewer = screen.getByRole("dialog", { name: title })
    await waitFor(() => expect(document.activeElement).toBe(viewer))
    // Enter on the dialog itself downloads nothing.
    await user.keyboard("{Enter}")
    expect(server.api.fileRequests.filter((r) => r.url.includes("F8"))).toHaveLength(1)

    // Bounded by the window, and at least a reading width (no wider than the window either).
    expect(viewer.className).toContain("max-w-[calc(100vw-2rem)]")
    expect(viewer.className).toContain("min-w-[min(24rem,calc(100vw-2rem))]")
    // The header adds no width of its own: the title wraps (anywhere, for CJK and long names)
    // up to three lines, and its full text stays in the title attribute and the dialog's name.
    const heading = within(viewer).getByRole("heading", { name: title })
    expect(heading.parentElement!.className).toContain("contain-inline-size")
    expect(heading.className).toContain("wrap-anywhere")
    expect(heading.className).toContain("line-clamp-3")
    expect(heading.className).not.toContain("truncate")
    expect(heading.getAttribute("title")).toBe(title)
    const details = within(viewer).getByText(`${name} · 320 B`)
    expect(details.className).toContain("truncate")
    expect(details.getAttribute("title")).toBe(`${name} · 320 B`)
  })

  it("shows a lone image without stepping, and says when its bytes don't come", async () => {
    const lone: Message = {
      ...withFiles,
      files: [{ id: "F7", name: "größe.png", mimetype: "image/png", url_private: `${FILES}F7/gr%C3%B6%C3%9Fe.png` }],
    }
    let fail!: () => void
    const { user } = await signedIn([lone], (s) => {
      s.api.client.fetchFile = () => new Promise((_, reject) => (fail = () => reject(new Error("offline"))))
    })
    await user.click(within(log()).getByRole("button", { name: "Open größe.png" }))
    const viewer = screen.getByRole("dialog", { name: "größe.png" })
    expect(within(viewer).getByRole("img", { name: "Loading größe.png" })).toBeTruthy()
    expect(within(viewer).queryByRole("button", { name: "Next image" })).toBeNull()
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("dialog", { name: "größe.png" })).toBeTruthy()
    await act(async () => fail())
    expect(await within(viewer).findByText("Couldn't load this image.")).toBeTruthy()
  })
})

describe("uploads from the composer", () => {
  it("attaches with the button, shows the upload pending, then the stored message", async () => {
    const { server, user } = await signedIn([])
    const box = screen.getByRole("textbox", { name: "Message #general" })
    const photo = new File([new Uint8Array(2048)], "café.png", { type: "image/png" })
    const notes = new File(["hola"], "notas.txt", { type: "text/plain" })
    await user.upload(screen.getByLabelText("Files to attach"), [photo, notes])
    const attachments = screen.getByRole("list", { name: "Attachments" })
    expect(within(attachments).getByText("2 KB")).toBeTruthy()
    await user.click(within(attachments).getByRole("button", { name: "Remove notas.txt" }))
    expect(within(attachments).queryByText("notas.txt")).toBeNull()

    let finish!: () => void
    const sent: { files: NewFile[]; opts: unknown }[] = []
    server.api.client.upload = (files, opts) => {
      sent.push({ files: files as NewFile[], opts })
      return new Promise((resolve) => (finish = () => resolve([{ id: "F9", title: "café.png" }])))
    }
    await user.type(box, "Voilà{Enter}")
    const pending = await within(log()).findByRole("group", { name: "File: café.png" })
    expect(within(pending).getByText("Uploading…")).toBeTruthy()
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull()
    expect(sent[0]!.files[0]!.bytes.byteLength).toBe(2048)
    expect(sent[0]!.opts).toMatchObject({ channel: "CGEN", text: "Voilà" })

    server.api.handlers["conversations.history"] = () => ({
      messages: [
        {
          ts: "1700000600.000000",
          user: ALEX,
          text: "Voilà",
          files: [{ id: "F9", name: "café.png", mimetype: "image/png", url_private: `${FILES}F9/caf%C3%A9.png` }],
        },
      ],
    })
    server.api.files[`${FILES}F9/caf%C3%A9.png`] = new Uint8Array([1])
    await act(async () => finish())
    expect(await within(log()).findByRole("img", { name: "café.png" })).toBeTruthy()
    expect(within(log()).queryByText("Uploading…")).toBeNull()
  })

  it("attaches images pasted into the composer, and leaves text pastes alone", async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 2, 9, 5, 7), toFake: ["Date"] })
    const { server } = await signedIn([])
    const box = screen.getByRole("textbox", { name: "Message #general" })
    const paste = (fill: (data: DataTransfer) => void) => {
      const clipboardData = new DataTransfer()
      fill(clipboardData)
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData })
      fireEvent(box, event)
      return event
    }

    // Text, even with the picture an office app puts beside it, pastes as text.
    const text = paste((data) => {
      data.setData("text/plain", "Größe ¿qué? 大きさ")
      data.items.add(new File([new Uint8Array(4)], "image.png", { type: "image/png" }))
    })
    expect(text.defaultPrevented).toBe(false)
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull()

    // A screenshot comes as "image.png": it gets a name of its own; a named file keeps its name.
    const image = paste((data) => {
      data.items.add(new File([new Uint8Array(4)], "image.png", { type: "image/png" }))
      data.items.add(new File([new Uint8Array(8)], "서울-야경.jpg", { type: "image/jpeg" }))
    })
    expect(image.defaultPrevented).toBe(true)
    const attachments = screen.getByRole("list", { name: "Attachments" })
    expect(within(attachments).getByText("Pasted image 2026-10-02 at 09.05.07.png")).toBeTruthy()
    expect(within(attachments).getByText("서울-야경.jpg")).toBeTruthy()
    vi.useRealTimers()

    const sent: NewFile[][] = []
    server.api.client.upload = async (files) => {
      sent.push(files as NewFile[])
      return []
    }
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.map((f) => [f.name, f.bytes.byteLength])).toEqual([
      ["Pasted image 2026-10-02 at 09.05.07.png", 4],
      ["서울-야경.jpg", 8],
    ])
  })

  it("takes files dropped on the conversation, and keeps a failed upload for retry", async () => {
    const { server } = await signedIn([])
    server.api.handlers["files.getUploadURLExternal"] = () => new Error("file_too_large")
    const section = screen.getByRole("region", { name: "general" })
    const file = new File(["x"], "大きい.zip", { type: "application/zip" })
    const dataTransfer = { types: ["Files"], files: [file] }
    fireEvent.dragOver(section, { dataTransfer })
    expect(screen.getByText("Drop files to attach them")).toBeTruthy()
    fireEvent.dragLeave(section, { dataTransfer, relatedTarget: null })
    expect(screen.queryByText("Drop files to attach them")).toBeNull()
    // Text being dragged isn't a file drop.
    fireEvent.dragOver(section, { dataTransfer: { types: ["text/plain"], files: [] } })
    expect(screen.queryByText("Drop files to attach them")).toBeNull()
    fireEvent.drop(section, { dataTransfer: { types: ["text/plain"], files: [] } })
    fireEvent.dragOver(section, { dataTransfer })
    fireEvent.drop(section, { dataTransfer })
    const attachments = screen.getByRole("list", { name: "Attachments" })
    expect(within(attachments).getByText("大きい.zip")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect((await screen.findByRole("alert")).textContent).toContain("file_too_large")
    expect(within(log()).getByRole("group", { name: "File: 大きい.zip" })).toBeTruthy()
    expect(server.api.calls.filter((c) => c.method === "files.getUploadURLExternal")).toHaveLength(1)
  })
})

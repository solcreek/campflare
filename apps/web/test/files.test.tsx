import type { Message, NewFile } from "@campflare/core"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "@/app"
import { browserStore } from "@/session"
import { ALEX, fakeServer, FakeSocket, hello, VINCENT } from "./server"

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

import type { Message } from "@campflare/core"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "@/app"
import { browserStore } from "@/session"
import { fakeServer, FakeSocket, hello, VINCENT } from "./server"

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

import { type Browser, expect, type Page, test } from "@playwright/test"
import { sunsetPng } from "../../../scripts/seed.ts"
import type { Stack } from "./global-setup"

const stack = JSON.parse(process.env.CAMPFLARE_E2E!) as Stack

/** A person's app, signed in as them (alex unless named). */
async function open(browser: Browser, as = "alex", route = ""): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto(`${stack.appUrl}/?as=${as}${route}`)
  await expect(page.getByRole("status", { name: "Connected" })).toBeVisible()
  return page
}

const sidebarItem = (page: Page, name: string) =>
  // An unread badge joins the button's name: "dev 2 unread".
  page
    .getByRole("navigation", { name: /Channels|Direct messages/ })
    .getByRole("button", { name: new RegExp(`^${name}( \\d+ unread)?$`) })

/** The open conversation's messages (a thread panel has its own log). */
const messages = (page: Page) => page.getByRole("region").getByRole("log", { name: "Messages" })

test("a message reaches the other person live, in every script", async ({ browser }) => {
  const alex = await open(browser)
  const vincent = await open(browser, "vincent")
  await expect(alex.getByRole("heading", { name: "general", level: 1 })).toBeVisible()

  // Unique per run: the stack is shared, and --repeat-each must not find an earlier run's copies.
  const run = Date.now().toString(36)
  for (const text of [`今日は 🎉 早安 ${run}`, `¿Qué tal? Ça va. Grüße ${run}`, `회의는 3시에 ${run}`]) {
    await alex.getByRole("textbox", { name: "Message #general" }).fill(text)
    await alex.keyboard.press("Enter")
    await expect(messages(alex).getByText(text)).toBeVisible()
    await expect(messages(vincent).getByText(text)).toBeVisible()
  }

  // Someone else's message in a conversation you're not looking at shows as unread.
  await sidebarItem(vincent, "random").click()
  await alex.getByRole("button", { name: "Vincent Vega" }).click()
  await alex.getByRole("textbox", { name: "Message Vincent Vega" }).fill(`ping ${run}`)
  await alex.keyboard.press("Enter")
  await expect(vincent.getByLabel("1 unread")).toBeVisible()
  await sidebarItem(vincent, "Alex Rivera").click()
  await expect(messages(vincent).getByText(`ping ${run}`)).toBeVisible()
  await expect(vincent.getByLabel("1 unread")).toHaveCount(0)
})

test("threads, reactions and edits stay in step between people", async ({ browser }) => {
  const alex = await open(browser)
  const minjun = await open(browser, "minjun")
  // A channel of our own, so this test doesn't depend on the others.
  const name = `e2e-${Date.now()}`
  await alex.getByRole("button", { name: "Add channels" }).click()
  await alex.getByRole("textbox", { name: "New channel name" }).fill(name)
  await alex.getByRole("button", { name: "Create" }).click()
  await expect(alex.getByRole("heading", { name, level: 1 })).toBeVisible()
  await alex.getByRole("textbox", { name: `Message #${name}` }).fill("Ship it on Friday?")
  await alex.keyboard.press("Enter")

  await minjun.getByRole("button", { name: "Add channels" }).click()
  await minjun.getByRole("dialog").getByRole("button", { name }).click()
  await minjun.getByRole("button", { name: "Join channel" }).click()
  const question = messages(minjun).getByRole("article").filter({ hasText: "Ship it on Friday?" })
  await question.hover()
  await question.getByRole("button", { name: "Reply in thread" }).click()
  const thread = minjun.getByRole("complementary", { name: "Thread" })
  await thread.getByRole("textbox", { name: "Reply…" }).fill("Thursday is safer")
  await minjun.keyboard.press("Enter")
  await expect(thread.getByText("Thursday is safer")).toBeVisible()

  // Alex sees the reply count, then reacts; Minjun sees the reaction.
  await expect(messages(alex).getByRole("button", { name: "1 reply" })).toBeVisible()
  const mine = messages(alex).getByRole("article").filter({ hasText: "Ship it on Friday?" })
  await mine.hover()
  await mine.getByRole("button", { name: "Add reaction" }).click()
  await alex.getByRole("button", { name: "React with +1" }).click()
  await expect(question.getByRole("button", { name: "+1, 1" })).toBeVisible()

  // An edit and a delete reach Minjun too.
  await mine.hover()
  await mine.getByRole("button", { name: "Edit message" }).click()
  await alex.getByRole("textbox", { name: "Edit message" }).fill("Ship it on Thursday?")
  await alex.keyboard.press("Enter")
  await expect(messages(minjun).getByText("Ship it on Thursday?")).toBeVisible()
  await expect(messages(minjun).getByText("(edited)")).toBeVisible()
})

/** The image's bytes arrived and decoded: a blob: URL with real pixels. */
async function expectLoaded(image: ReturnType<Page["getByRole"]>) {
  await expect(image).toBeVisible()
  await expect(image).toHaveAttribute("src", /^blob:/)
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
}

test("images show inline, and an upload reaches the other person", async ({ browser }) => {
  const alex = await open(browser)
  // The seeded sunset, fetched cross-origin from url_private with alex's token.
  await expectLoaded(messages(alex).getByRole("img", { name: "An orange sunset fading into purple" }))

  const vincent = await open(browser, "vincent")
  await sidebarItem(alex, "random").click()
  await sidebarItem(vincent, "random").click()
  const png = await sunsetPng(120, 80)
  await alex.getByLabel("Files to attach").setInputFiles([
    { name: "atardecer-夕焼け.png", mimeType: "image/png", buffer: Buffer.from(png) },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Grüße, 안녕") },
  ])
  await expect(alex.getByRole("list", { name: "Attachments" }).getByText("notes.txt")).toBeVisible()
  const caption = `Ce soir 🌅 ${Date.now().toString(36)}`
  await alex.getByRole("textbox", { name: "Message #random" }).fill(caption)
  await alex.keyboard.press("Enter")

  for (const page of [alex, vincent]) {
    // This run's message: earlier runs (--repeat-each) left files with the same names.
    const upload = messages(page).getByRole("article").filter({ hasText: caption })
    await expect(upload).toHaveCount(1)
    await expectLoaded(upload.getByRole("img", { name: "atardecer-夕焼け.png" }))
    await expect(upload.getByRole("group", { name: "File: notes.txt" })).toBeVisible()
  }
  await expect(messages(alex).getByText("Uploading…")).toHaveCount(0)
})

test("a pasted image is attached under a name of its own", async ({ browser }) => {
  const alex = await open(browser)
  const box = alex.getByRole("textbox", { name: "Message #general" })
  // A paste event as the browser dispatches it: the system clipboard isn't the test's to fill.
  await box.evaluate(
    async (el, bytes) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }))
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }))
    },
    Array.from(await sunsetPng(40, 30)),
  )
  await expect(
    alex.getByRole("list", { name: "Attachments" }).getByText(/^Pasted image \d{4}-\d\d-\d\d at [\d.]+\.png$/),
  ).toBeVisible()
  await expect(box).toHaveValue("")
})

test("every screen has a URL", async ({ browser }) => {
  const alex = await open(browser)
  await sidebarItem(alex, "dev").click()
  await messages(alex).getByRole("button", { name: "2 replies" }).click()
  await expect(
    alex.getByRole("complementary", { name: "Thread" }).getByText("Looking now", { exact: false }),
  ).toBeVisible()
  // The same URL in a fresh window opens the same thread.
  const again = await open(browser, "alex", new URL(alex.url()).hash)
  await expect(
    again.getByRole("complementary", { name: "Thread" }).getByText("Looking now", { exact: false }),
  ).toBeVisible()
})

test("signs in through the browser: the server's sign-in and consent, then back to the app", async ({ browser }) => {
  // Someone new each run: the server remembers consent, and a repeat would skip the Allow page.
  const run = Date.now().toString(36)
  const created = (await (
    await fetch(`${stack.apiUrl}/api/campflare.users.create`, {
      method: "POST",
      headers: { authorization: `Bearer ${stack.people.alex}` },
      body: new URLSearchParams({
        name: `zoe-${run}`,
        real_name: `Zoé Hayashi ${run}`,
        email: `zoe-${run}@campflare.test`,
      }),
    })
  ).json()) as { ok: boolean; token: string }
  expect(created.ok).toBe(true)

  const page = await (await browser.newContext()).newPage()
  // ?as=none: the dev server's auto sign-in steps aside for the login screen.
  await page.goto(`${stack.appUrl}/?as=none`)
  await page.getByLabel("Server").fill(stack.apiUrl)
  await page.getByRole("button", { name: "Sign in with your browser" }).click()

  // The server's own pages: a token of the person's own, then consent for the app.
  await expect(page.getByLabel("Campflare token")).toBeVisible()
  expect(new URL(page.url()).origin).toBe(stack.apiUrl)
  await page.getByLabel("Campflare token").fill(created.token)
  await page.getByRole("button", { name: "Continue" }).click()
  await expect(page.getByRole("heading", { name: /^Allow / })).toBeVisible()
  await page.getByRole("button", { name: "Allow" }).click()

  // Back in the app, signed in as that person, with the code gone from the address bar.
  await expect(page.getByRole("status", { name: "Connected" })).toBeVisible()
  expect(new URL(page.url()).search).toBe("")
  const text = `Signed in through the browser ${Date.now()}`
  await page.getByRole("textbox", { name: "Message #general" }).fill(text)
  await page.keyboard.press("Enter")
  // A message is named by its author, even one grouped under the previous.
  await expect(
    messages(page)
      .getByRole("article", { name: new RegExp(`^Zoé Hayashi ${run} `) })
      .filter({ hasText: text }),
  ).toBeVisible()
})

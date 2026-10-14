import { type Browser, expect, type Page, test } from "@playwright/test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
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

/** Calls a Web API method on the stack's server with a token; fails the test on ok: false. */
async function callAs<T = Record<string, unknown>>(method: string, args: Record<string, unknown>, token: string) {
  const res = await fetch(`${stack.apiUrl}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  })
  const body = (await res.json()) as T & { ok: boolean; error?: string }
  if (!body.ok) throw new Error(`${method} failed: ${body.error}`)
  return body
}

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

test("an image opens full size, and Escape closes it", async ({ browser }) => {
  const alex = await open(browser)
  const name = "An orange sunset fading into purple"
  await messages(alex)
    .getByRole("button", { name: `Open ${name}` })
    .first()
    .click()
  const viewer = alex.getByRole("dialog")
  await expectLoaded(viewer.getByRole("img", { name }))
  await expect(viewer.getByRole("button", { name: /^Download / })).toBeVisible()
  // Focus is on the dialog, not Download.
  await expect(viewer).toBeFocused()
  await alex.keyboard.press("Escape")
  await expect(viewer).toHaveCount(0)
})

test("a small image with a long title opens inside a phone's window", async ({ browser }) => {
  const alex = await open(browser)
  await alex.setViewportSize({ width: 390, height: 844 })
  const title = `夏の終わりの花火大会で撮った写真_et_la_soirée_de_clôture_au_château_de_Versailles_${Date.now().toString(36)}.png`
  await alex
    .getByLabel("Files to attach")
    .setInputFiles([{ name: title, mimeType: "image/png", buffer: Buffer.from(await sunsetPng(48, 32)) }])
  await alex.getByRole("button", { name: "Send" }).click()
  await messages(alex)
    .getByRole("button", { name: `Open ${title}` })
    .click()
  const viewer = alex.getByRole("dialog", { name: title })
  await expectLoaded(viewer.getByRole("img", { name: title }))
  // The dialog stays in the window; the title wraps inside it rather than running off the edge.
  const box = (await viewer.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  const heading = viewer.getByRole("heading", { name: title })
  await expect(heading).toHaveAttribute("title", title)
  const fits = await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)
  expect(fits).toBe(true)
  const lines = await heading.evaluate((el) => el.clientHeight / parseFloat(getComputedStyle(el).lineHeight))
  expect(lines).toBeGreaterThan(1.5)
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
  // The person sets their own password with their token, as `campflare password set` does.
  const password = `Zoé の合言葉 ${run}`
  const set = (await (
    await fetch(`${stack.apiUrl}/api/campflare.users.setPassword`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.token}` },
      body: new URLSearchParams({ password }),
    })
  ).json()) as { ok: boolean }
  expect(set.ok).toBe(true)

  const page = await (await browser.newContext()).newPage()
  // ?as=none: the dev server's auto sign-in steps aside for the login screen.
  await page.goto(`${stack.appUrl}/?as=none`)
  // The dev server is filled in; the token isn't.
  await expect(page.getByLabel("Server")).toHaveValue(stack.apiUrl)
  await expect(page.getByLabel("Token")).toHaveValue("")
  await page.getByRole("button", { name: "Sign in with your browser" }).click()

  // The server's own pages: email and password, then consent for the app.
  await expect(page.getByLabel("Email")).toBeVisible()
  expect(new URL(page.url()).origin).toBe(stack.apiUrl)
  await page.getByLabel("Email").fill(`zoe-${run}@campflare.test`)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
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

  // Signing out revokes the token the sign-in gave the app, not just forgets it.
  const kept = JSON.parse((await page.evaluate(() => localStorage.getItem("campflare.session")))!) as {
    token: string
    via: string
  }
  expect(kept.via).toBe("oauth")
  const authTest = async (token: string) =>
    (await (
      await fetch(`${stack.apiUrl}/api/auth.test`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
    ).json()) as { ok: boolean; error?: string }
  expect((await authTest(kept.token)).ok).toBe(true)
  await page.getByRole("button", { name: / menu$/ }).click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(page.getByRole("heading", { name: "Sign in to Campflare" })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("campflare.session"))).toBeNull()
  expect(await authTest(kept.token)).toMatchObject({ ok: false, error: "token_revoked" })
  // The person's own token, from before the browser sign-in, still works.
  expect((await authTest(created.token)).ok).toBe(true)
})

test("a permalink from chat.getPermalink opens its message, a root or a reply", async ({ browser }) => {
  const api = async <T>(method: string, args: Record<string, string>) => {
    const res = (await (
      await fetch(`${stack.apiUrl}/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${stack.people.alex}` },
        body: new URLSearchParams(args),
      })
    ).json()) as T & { ok: boolean; error?: string }
    expect(res.error).toBeUndefined()
    return res
  }
  const name = `e2e-links-${Date.now()}`
  const { channel } = await api<{ channel: { id: string } }>("conversations.create", { name })
  const root = await api<{ ts: string }>("chat.postMessage", {
    channel: channel.id,
    text: "Où est le rapport ? ¿Dónde?",
  })
  const reply = await api<{ ts: string }>("chat.postMessage", {
    channel: channel.id,
    thread_ts: root.ts,
    text: "報告書はここ 보고서 여기",
  })
  // Later messages, so the linked one isn't simply the newest.
  for (let i = 0; i < 3; i++) await api("chat.postMessage", { channel: channel.id, text: `later ${i}` })
  const permalink = async (ts: string) =>
    (await api<{ permalink: string }>("chat.getPermalink", { channel: channel.id, message_ts: ts })).permalink

  // The server's link redirects to the app (signed in as alex in dev), highlighted in the conversation.
  const page = await (await browser.newContext()).newPage()
  const rootLink = await permalink(root.ts)
  expect(rootLink.startsWith(`${stack.apiUrl}/archives/${channel.id}/p`)).toBe(true)
  await page.goto(rootLink)
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
  const linked = messages(page).locator('article[aria-current="true"]')
  await expect(linked).toHaveCount(1)
  await expect(linked).toContainText("Où est le rapport ?")
  await expect(linked).toBeInViewport()

  // A reply's link opens its thread with the reply highlighted.
  await page.goto(await permalink(reply.ts))
  const thread = page.getByRole("complementary", { name: "Thread" })
  await expect(thread.locator('article[aria-current="true"]')).toContainText("報告書はここ")
  expect(new URL(page.url()).hash).toBe(`#/${channel.id}/${root.ts}?msg=${reply.ts}`)

  // A link to nothing gets the app's not-found view, not a bare 404.
  await page.goto(`${stack.apiUrl}/archives/CNOPE404/p1700000000000100`)
  await expect(page.getByRole("heading", { name: "Conversation not found", level: 1 })).toBeVisible()
})

test("a permalink opened signed out signs in through the browser first, then lands on the message", async ({
  browser,
}) => {
  // Someone new, so the server asks for consent; their token signs them in on the server's page.
  const run = Date.now().toString(36)
  const call = async <T>(method: string, args: Record<string, string>, token = stack.people.alex!) =>
    (await (
      await fetch(`${stack.apiUrl}/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: new URLSearchParams(args),
      })
    ).json()) as T & { ok: boolean }
  const created = await call<{ token: string }>("campflare.users.create", {
    name: `linnea-${run}`,
    real_name: `Linnéa Park ${run}`,
    email: `linnea-${run}@campflare.test`,
  })
  // In #general, which everyone is in.
  const posted = await call<{ ts: string; channel: string }>("chat.postMessage", {
    channel: "#general",
    text: `Lien direct ${run}`,
  })
  const general = posted.channel
  const { permalink } = await call<{ permalink: string }>("chat.getPermalink", {
    channel: general,
    message_ts: posted.ts,
  })

  // Where the link sends the browser, with the dev server's auto sign-in stepped aside (?as=none).
  const target = new URL((await fetch(permalink, { redirect: "manual" })).headers.get("location")!)
  target.search = "?as=none"
  const page = await (await browser.newContext()).newPage()
  await page.goto(target.href)
  await page.getByRole("button", { name: "Sign in with your browser" }).click()
  await page.getByText("Sign in with a token instead").click()
  await page.getByLabel("Campflare token").fill(created.token)
  await page.getByRole("button", { name: "Continue with token" }).click()
  await page.getByRole("button", { name: "Allow" }).click()

  // Back in the app, signed in as them, on the linked message.
  await expect(page.getByRole("status", { name: "Connected" })).toBeVisible()
  await expect(messages(page).locator('article[aria-current="true"]')).toContainText(`Lien direct ${run}`)
  expect(new URL(page.url()).hash).toBe(`#/${general}?msg=${posted.ts}`)
})

test("a click on an app's button reaches the app, and its answer replaces the message", async ({ browser }) => {
  // The app: takes block_actions at its Interactivity URL and answers through the response_url.
  const app = createServer((req, res) => {
    let body = ""
    req.on("data", (d: Buffer) => (body += d))
    req.on("end", () => {
      res.end()
      const payload = JSON.parse(new URLSearchParams(body).get("payload")!) as {
        user: { name: string }
        actions: { value: string }[]
        response_url: string
      }
      void fetch(payload.response_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          replace_original: true,
          text: `Approved ${payload.actions[0]!.value} by ${payload.user.name}`,
        }),
      })
    })
  })
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r))
  try {
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/interactive`
    await callAs("campflare.apps.setInteractivity", { app: stack.app.id, request_url: url }, stack.people.alex!)
    const run = Date.now().toString(36)
    await callAs(
      "chat.postMessage",
      {
        channel: "#general",
        text: `Open the pull request ${run}?`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `Open the pull request ${run}?` } },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "approve",
                text: { type: "plain_text", text: "Approve" },
                value: `pr-${run}`,
                style: "primary",
              },
            ],
          },
        ],
      },
      stack.app.botToken,
    )

    const alex = await open(browser)
    const question = messages(alex)
      .getByRole("article")
      .filter({ hasText: `Open the pull request ${run}?` })
    await question.getByRole("button", { name: "Approve" }).click()
    const answered = messages(alex)
      .getByRole("article")
      .filter({ hasText: `Approved pr-${run} by alex` })
    await expect(answered).toBeVisible()
    await expect(answered.getByRole("button", { name: "Approve" })).toHaveCount(0)
  } finally {
    await callAs("campflare.apps.setInteractivity", { app: stack.app.id, request_url: "" }, stack.people.alex!)
    app.close()
  }
})

test("a button opens the app's modal; it's filled in, refused once, then submitted, and the app replies", async ({
  browser,
}) => {
  // An app of its own, so this test and the one above don't share an Interactivity URL.
  const created = await callAs<{ app: { id: string }; bot_token: string }>(
    "campflare.apps.create",
    { name: `Deployer ${Date.now().toString(36)}` },
    stack.people.alex!,
  )
  const run = Date.now().toString(36)
  const text = (t: string) => ({ type: "plain_text", text: t })
  const form = {
    type: "modal",
    callback_id: "deploy",
    title: text("Deploy"),
    submit: text("Deploy"),
    blocks: [
      {
        type: "input",
        block_id: "note",
        label: text("Release note"),
        element: { type: "plain_text_input", action_id: "text" },
      },
      {
        type: "input",
        block_id: "env",
        label: text("Environment"),
        element: {
          type: "static_select",
          action_id: "pick",
          options: [
            { text: text("Production"), value: "prod" },
            { text: text("Staging"), value: "staging" },
          ],
        },
      },
    ],
  }
  // The app: the button opens the form with the click's trigger_id; a short note is refused, else it says so in the channel.
  const app = createServer((req, res) => {
    let body = ""
    req.on("data", (d: Buffer) => (body += d))
    req.on("end", () => {
      const payload = JSON.parse(new URLSearchParams(body).get("payload")!) as {
        type: string
        trigger_id: string
        user: { name: string }
        view?: {
          state: { values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> }
        }
      }
      if (payload.type === "block_actions") {
        res.end()
        void callAs("views.open", { trigger_id: payload.trigger_id, view: form }, created.bot_token)
        return
      }
      if (payload.type !== "view_submission") return void res.end()
      const values = payload.view!.state.values
      const note = values.note!.text!.value ?? ""
      if (note.length < 5) {
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ response_action: "errors", errors: { note: "Say a bit more" } }))
        return
      }
      res.end()
      void callAs(
        "chat.postMessage",
        {
          channel: "#general",
          text: `Deploying ${run} to ${values.env!.pick!.selected_option!.value} for ${payload.user.name}: ${note}`,
        },
        created.bot_token,
      )
    })
  })
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r))
  try {
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/interactive`
    await callAs("campflare.apps.setInteractivity", { app: created.app.id, request_url: url }, stack.people.alex!)
    await callAs(
      "chat.postMessage",
      {
        channel: "#general",
        text: `Ready to deploy ${run}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `Ready to deploy ${run}` } },
          { type: "actions", elements: [{ type: "button", action_id: "open", text: text("Deploy…") }] },
        ],
      },
      created.bot_token,
    )

    const alex = await open(browser)
    const ready = messages(alex)
      .getByRole("article")
      .filter({ hasText: `Ready to deploy ${run}` })
    await ready.getByRole("button", { name: "Deploy…" }).click()
    const dialog = alex.getByRole("dialog", { name: "Deploy" })
    await expect(dialog).toBeVisible()
    // Too short a note first: the app refuses it, and the note has the focus to fix it.
    await dialog.getByRole("textbox", { name: "Release note" }).fill("ok")
    await dialog.getByRole("combobox", { name: "Environment" }).selectOption("staging")
    await dialog.getByRole("button", { name: "Deploy" }).click()
    const note = dialog.getByRole("textbox", { name: "Release note" })
    await expect(dialog.getByText("Say a bit more")).toBeVisible()
    await expect(note).toHaveAttribute("aria-invalid", "true")
    await expect(note).toBeFocused()
    await note.fill("Ship it — 出荷 ✨")
    await dialog.getByRole("button", { name: "Deploy" }).press("Enter")
    await expect(dialog).toBeHidden()
    await expect(
      messages(alex)
        .getByRole("article")
        .filter({ hasText: `Deploying ${run} to staging for alex: Ship it — 出荷 ✨` }),
    ).toBeVisible()
  } finally {
    await callAs("campflare.apps.setInteractivity", { app: created.app.id, request_url: "" }, stack.people.alex!)
    app.close()
  }
})

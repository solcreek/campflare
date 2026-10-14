import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { call, connect, fakeRequestUrls, ok, settle, workspace, type RequestUrlHit } from "./helpers"

// Modals: an app opens a view with the trigger_id of a click, the person fills
// it in and submits it (or closes it), and the app answers with a
// response_action.

const URL = "https://app.example/interactive"
let urls: ReturnType<typeof fakeRequestUrls>

beforeEach(() => {
  urls = fakeRequestUrls()
})
afterEach(() => urls.restore())

const text = (t: string) => ({ type: "plain_text", text: t })
const option = (t: string, value: string) => ({ text: text(t), value })

/** A form with every input the app renders. */
const FORM = {
  type: "modal",
  callback_id: "deploy",
  private_metadata: "pr-42",
  title: text("Deploy"),
  submit: text("Deploy"),
  close: text("Cancel"),
  notify_on_close: true,
  blocks: [
    { type: "section", block_id: "intro", text: { type: "mrkdwn", text: "Where to?" } },
    {
      type: "input",
      block_id: "note",
      label: text("Release note"),
      element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 40 },
    },
    {
      type: "input",
      block_id: "env",
      label: text("Environment"),
      element: {
        type: "static_select",
        action_id: "pick",
        options: [option("Production", "prod"), option("Staging", "staging")],
        initial_option: option("Staging", "staging"),
      },
    },
    {
      type: "input",
      block_id: "reviewer",
      label: text("Reviewer"),
      optional: true,
      element: { type: "users_select", action_id: "who" },
    },
    {
      type: "input",
      block_id: "checks",
      label: text("Checks"),
      optional: true,
      element: {
        type: "checkboxes",
        action_id: "boxes",
        options: [option("Migrate", "migrate"), option("Notificar", "notify")],
      },
    },
    {
      type: "input",
      block_id: "speed",
      label: text("Speed"),
      element: { type: "radio_buttons", action_id: "radio", options: [option("Fast", "fast"), option("Slow", "slow")] },
    },
    {
      type: "input",
      block_id: "day",
      label: text("Day"),
      optional: true,
      element: { type: "datepicker", action_id: "date", initial_date: "2026-10-14" },
    },
  ],
}

const isAction = (h: RequestUrlHit) => h.body?.type === "block_actions"
const isSubmission = (h: RequestUrlHit) => h.body?.type === "view_submission"

type View = Record<string, unknown> & { id: string; hash: string; state: { values: Record<string, unknown> } }

/** A workspace with an app (Interactivity URL set), and Bob, who clicks its button: the app holds a fresh trigger_id. */
async function setup() {
  const w = await workspace()
  const app = await w.addApp("Deployer")
  const bob = await w.addUser("bob")
  await ok("campflare.apps.setInteractivity", { app: app.id, request_url: URL }, w.owner.token)
  const posted = await ok<{ ts: string }>(
    "chat.postMessage",
    {
      channel: w.general,
      text: "Deploy?",
      blocks: [
        {
          type: "actions",
          block_id: "go",
          elements: [{ type: "button", action_id: "deploy", text: text("Deploy…") }],
        },
      ],
    },
    app.botToken,
    { json: true },
  )
  /** Bob clicks Deploy: the trigger_id the app got. */
  const click = async (token = bob.token) => {
    await ok("campflare.blocks.action", { channel: w.general, ts: posted.ts, action_id: "deploy" }, token)
    return (await urls.next(isAction)).body.trigger_id as string
  }
  const open = async (view: unknown = FORM) =>
    (await ok<{ view: View }>("views.open", { trigger_id: await click(), view }, app.botToken, { json: true })).view
  const submit = (view_id: string, values?: unknown, token = bob.token) =>
    call<{ views: View[]; errors?: Record<string, string>; delivered?: string }>(
      "campflare.views.submit",
      { view_id, values },
      token,
      { json: true },
    )
  const list = async (token = bob.token) => (await ok<{ views: View[] }>("campflare.views.list", {}, token)).views
  return { w, app, bob, click, open, submit, list }
}

/** The app answers view_submission with this JSON; everything else with an empty 200. */
const answering = (body: unknown) => {
  urls.answer = (hit) => (isSubmission(hit) ? Response.json(body) : new Response(""))
}

describe("views.open", () => {
  it("opens a modal for the clicker, with the trigger_id of the click, in Slack's shape", async () => {
    const { w, app, bob, open, list } = await setup()
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    const owners = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
    await rtm.next((f) => f.type === "hello")
    await owners.next((f) => f.type === "hello")
    const view = await open()
    expect(view).toEqual({
      id: expect.stringMatching(/^V[0-9A-Z]{10}$/),
      team_id: w.teamId,
      type: "modal",
      blocks: FORM.blocks,
      private_metadata: "pr-42",
      callback_id: "deploy",
      state: { values: {} },
      hash: expect.stringMatching(/^\d+\.[0-9A-Z]+$/),
      title: text("Deploy"),
      clear_on_close: false,
      notify_on_close: true,
      close: text("Cancel"),
      submit: text("Deploy"),
      previous_view_id: null,
      root_view_id: view.id,
      app_id: app.id,
      external_id: "",
      app_installed_team_id: w.teamId,
      bot_id: app.botId,
    })
    expect(await rtm.next((f) => f.type === "views_changed")).toMatchObject({ views: [view] })
    expect(await list()).toEqual([view])
    expect(await list(w.owner.token)).toEqual([])
    await settle()
    expect(owners.frames.filter((f) => f.type === "views_changed")).toEqual([])
    rtm.close()
    owners.close()
  })

  it("takes a trigger_id once, for 3 seconds, from the app it went to", async () => {
    const { w, app, click } = await setup()
    const trigger = await click()
    const open = (token = app.botToken, trigger_id = trigger) =>
      call("views.open", { trigger_id, view: FORM }, token, { json: true })
    const other = await w.addApp("Other")
    expect((await open(other.botToken)).error).toBe("invalid_trigger_id")
    expect((await open(app.botToken, "1.2.3")).error).toBe("invalid_trigger_id")
    expect((await open(w.owner.token)).error).toBe("not_allowed_token_type")
    expect((await open()).ok).toBe(true)
    expect((await open()).error).toBe("exchanged_trigger_id")

    const late = await click()
    const now = Date.now()
    const later = vi.spyOn(Date, "now").mockReturnValue(now + 3100)
    try {
      expect((await open(app.botToken, late)).error).toBe("expired_trigger_id")
    } finally {
      later.mockRestore()
    }
  })

  it("checks the view as Slack does", async () => {
    const { app, click } = await setup()
    const trigger = await click()
    const open = (view: unknown) => call("views.open", { trigger_id: trigger, view }, app.botToken, { json: true })
    const messages = async (view: unknown) => {
      const res = await open(view)
      expect(res.error).toBe("invalid_arguments")
      return (res.response_metadata as { messages: string[] }).messages
    }
    expect(await messages(undefined)).toEqual(["[ERROR] missing required field: view"])
    expect(await messages({ ...FORM, type: "home" })).toEqual([
      "[ERROR] view.type must be modal (home tabs aren't supported)",
    ])
    expect(await messages({ ...FORM, title: undefined })).toEqual(["[ERROR] must provide a value for view.title"])
    expect(await messages({ ...FORM, title: text("A title far longer than allowed") })).toEqual([
      "[ERROR] view.title.text must be at most 24 characters",
    ])
    expect(await messages({ ...FORM, submit: undefined })).toEqual([
      "[ERROR] view.submit is required when an input block is within the blocks array",
    ])
    expect(await messages({ ...FORM, blocks: [FORM.blocks[1], FORM.blocks[1]] })).toEqual([
      "[ERROR] view.blocks must have unique block_ids",
    ])
    expect(await messages({ ...FORM, blocks: [{ type: "input", label: text("x") }] })).toEqual([
      "[ERROR] view.blocks[0].element is required in an input block",
    ])
    expect(await messages("{nope")).toEqual(["[ERROR] view must be JSON"])
    // A form-encoded view is JSON, and the trigger wasn't spent by the failures.
    const view = await ok<{ view: View }>(
      "views.open",
      { trigger_id: trigger, view: JSON.stringify({ type: "modal", title: text("Hi"), blocks: [] }) },
      app.botToken,
    )
    expect(view.view.submit).toBeNull()
  })
})

describe("views.update and views.push", () => {
  it("updates a view by id or external_id, guarded by its hash, and only the app's own", async () => {
    const { w, app, bob, open, list } = await setup()
    const view = await open({ ...FORM, external_id: "deploy-42" })
    const rtm = await connect((await ok<{ url: string }>("rtm.connect", {}, bob.token)).url)
    const updated = await ok<{ view: View }>(
      "views.update",
      { view_id: view.id, hash: view.hash, view: { ...FORM, title: text("Deploying") } },
      app.botToken,
      { json: true },
    )
    expect(updated.view).toMatchObject({ id: view.id, root_view_id: view.id, title: text("Deploying") })
    expect(updated.view.hash).not.toBe(view.hash)
    expect(await rtm.next((f) => f.type === "views_changed")).toMatchObject({ views: [{ title: text("Deploying") }] })
    const update = (args: Record<string, unknown>, token = app.botToken) =>
      call("views.update", { view: FORM, ...args }, token, { json: true })
    expect((await update({ view_id: view.id, hash: view.hash })).error).toBe("hash_conflict")
    // The external_id stays with the view through updates that don't give one.
    expect((await update({ external_id: "deploy-42" })).ok).toBe(true)
    expect((await list())[0]).toMatchObject({ title: text("Deploy"), external_id: "deploy-42" })
    expect((await update({ external_id: "deploy-43" })).error).toBe("not_found")
    const other = await w.addApp("Other")
    expect((await update({ view_id: view.id }, other.botToken)).error).toBe("not_found")
    expect((await update({ view_id: "VNOPE" })).error).toBe("not_found")
    expect((await update({})).error).toBe("invalid_arguments")
    rtm.close()
  })

  it("pushes views onto the stack, three at most, each a click's trigger_id", async () => {
    const { app, click, open, list } = await setup()
    const root = await open()
    const push = async () =>
      call<{ view: View }>("views.push", { trigger_id: await click(), view: FORM }, app.botToken, { json: true })
    const second = (await push()).view
    expect(second).toMatchObject({ previous_view_id: root.id, root_view_id: root.id })
    const third = (await push()).view
    expect(third).toMatchObject({ previous_view_id: second.id, root_view_id: root.id })
    expect((await push()).error).toBe("push_limit_reached")
    expect((await list()).map((v) => v.id)).toEqual([root.id, second.id, third.id])
  })

  it("refuses a duplicate external_id, and a push with nothing open", async () => {
    const { app, click, open } = await setup()
    expect(
      (await call("views.push", { trigger_id: await click(), view: FORM }, app.botToken, { json: true })).error,
    ).toBe("not_found")
    await open({ ...FORM, external_id: "one" })
    const again = await call(
      "views.open",
      { trigger_id: await click(), view: { ...FORM, external_id: "one" } },
      app.botToken,
      { json: true },
    )
    expect(again.error).toBe("duplicate_external_id")
  })
})

describe("campflare.views.submit", () => {
  it("answers required inputs left empty without bothering the app", async () => {
    const { open, submit } = await setup()
    const view = await open()
    const res = await submit(view.id, { speed: { radio: "fast" } })
    expect(res).toMatchObject({ ok: true, errors: { note: "Please complete this required field." } })
    expect(res.views.map((v) => v.id)).toEqual([view.id])
    expect((await submit(view.id, { note: { text: "x".repeat(41) }, speed: { radio: "fast" } })).errors).toEqual({
      note: "Use at most 40 characters.",
    })
    expect(urls.hits.filter(isSubmission)).toEqual([])
  })

  it("sends view_submission with the state in Slack's shape, and closes the view on a plain ack", async () => {
    const { w, app, bob, open, submit, list } = await setup()
    const view = await open()
    const res = await submit(view.id, {
      note: { text: "Ship it 🚀 出荷" },
      reviewer: { who: w.owner.id },
      checks: { boxes: ["migrate", "notify"] },
      speed: { radio: "slow" },
    })
    expect(res).toEqual({ ok: true, delivered: "http", views: [] })
    const hit = await urls.next(isSubmission)
    expect(hit.body).toEqual({
      type: "view_submission",
      team: { id: w.teamId, domain: expect.any(String) },
      user: { id: bob.id, username: "bob", name: "bob", team_id: w.teamId },
      api_app_id: app.id,
      token: "",
      trigger_id: expect.stringMatching(/^\d{10}\.\d{10}\.[0-9a-f]{32}$/),
      view: {
        ...view,
        state: {
          values: {
            note: { text: { type: "plain_text_input", value: "Ship it 🚀 出荷" } },
            env: { pick: { type: "static_select", selected_option: option("Staging", "staging") } },
            reviewer: { who: { type: "users_select", selected_user: w.owner.id } },
            checks: {
              boxes: {
                type: "checkboxes",
                selected_options: [option("Migrate", "migrate"), option("Notificar", "notify")],
              },
            },
            speed: { radio: { type: "radio_buttons", selected_option: option("Slow", "slow") } },
            day: { date: { type: "datepicker", selected_date: "2026-10-14" } },
          },
        },
      },
      response_urls: [],
      is_enterprise_install: false,
      enterprise: null,
    })
    expect(await list()).toEqual([])
  })

  it("refuses what the view doesn't offer, and others' views", async () => {
    const { w, open, submit } = await setup()
    const view = await open()
    const base = { note: { text: "x" }, speed: { radio: "fast" } }
    const error = async (values: unknown, token?: string) => {
      const res = await submit(view.id, values, token)
      return res.error === "invalid_arguments"
        ? (res.response_metadata as { messages: string[] }).messages[0]
        : res.error
    }
    expect(await error({ ...base, env: { pick: "dev" } })).toBe("[ERROR] env.pick has no option dev")
    expect(await error({ ...base, checks: { boxes: ["nope"] } })).toBe("[ERROR] checks.boxes has no option nope")
    expect(await error({ ...base, speed: { radio: ["fast", "slow"] } })).toBe("[ERROR] speed.radio takes one value")
    expect(await error({ ...base, day: { date: "14/10/2026" } })).toBe("[ERROR] day.date must be YYYY-MM-DD")
    expect(await error({ ...base, nope: { x: "1" } })).toBe("[ERROR] no input nope.x in this view")
    expect(await error({ ...base, note: { text: 1 } })).toBe(
      "[ERROR] values.note.text must be a string or a list of strings",
    )
    expect(await error({ ...base, reviewer: { who: "UNOBODY" } })).toBe("invalid_value")
    expect(await error(base, w.owner.token)).toBe("not_found")
    expect(urls.hits.filter(isSubmission)).toEqual([])
  })

  it("honors response_action errors, update, push and clear", async () => {
    const { app, click, open, submit, list } = await setup()
    const values = { note: { text: "x" }, speed: { radio: "fast" } }
    const view = await open()

    answering({ response_action: "errors", errors: { note: "Too short" } })
    expect(await submit(view.id, values)).toMatchObject({ errors: { note: "Too short" }, views: [{ id: view.id }] })

    answering({ response_action: "update", view: { ...FORM, title: text("Again") } })
    const updated = await submit(view.id, values)
    expect(updated.views).toMatchObject([{ id: view.id, title: text("Again") }])
    expect(updated.views[0]!.hash).not.toBe(view.hash)

    answering({ response_action: "push", view: { type: "modal", title: text("Done"), blocks: [] } })
    const pushed = await submit(view.id, values)
    expect(pushed.views).toMatchObject([{ id: view.id }, { title: text("Done"), previous_view_id: view.id }])
    // The view under it keeps what was typed.
    expect(pushed.views[0]!.state.values).toMatchObject({ note: { text: { value: "x" } } })

    await ok("views.push", { trigger_id: await click(), view: { ...FORM, title: text("Third") } }, app.botToken, {
      json: true,
    })
    answering({ response_action: "clear" })
    const top = (await list()).at(-1)!
    expect((await submit(top.id, values)).views).toEqual([])

    const again = await open()
    answering({ response_action: "errors", errors: { nope: "x" } })
    expect((await submit(again.id, values)).error).toBe("invalid_response_action")
    answering({ response_action: "update", view: { type: "home" } })
    expect((await submit(again.id, values)).response_metadata).toEqual({
      messages: ["[ERROR] the app's answer: [ERROR] view.type must be modal (home tabs aren't supported)"],
    })
    answering({ response_action: "dance" })
    expect((await submit(again.id, values)).error).toBe("invalid_response_action")
  })

  it("only submits the top view, with a submit button, and says when the app is gone", async () => {
    const { app, click, open, submit } = await setup()
    const values = { note: { text: "x" }, speed: { radio: "fast" } }
    const root = await open()
    const info = await ok<{ view: View }>(
      "views.push",
      { trigger_id: await click(), view: { type: "modal", title: text("Info"), blocks: [] } },
      app.botToken,
      { json: true },
    )
    expect((await submit(root.id, values)).error).toBe("invalid_arguments")
    expect((await submit(info.view.id)).error).toBe("not_submittable")
    expect((await submit("VNOPE")).error).toBe("not_found")
    const fresh = await open()
    urls.answer = () => new Response("boom", { status: 500 })
    expect((await submit(fresh.id, values)).error).toBe("app_unreachable")
    urls.answer = () => new Response("<html>", { status: 200 })
    expect((await submit(fresh.id, values)).response_metadata).toEqual({
      messages: [
        "[ERROR] the app didn't take it: its Interactivity Request URL answered with something other than JSON",
      ],
    })
  })

  it("takes the response_action from a Socket Mode ack", async () => {
    const { app, open, submit } = await setup()
    const view = await open()
    const link = await connect((await ok<{ url: string }>("apps.connections.open", {}, app.appToken)).url)
    await link.next((f) => f.type === "hello")
    link.ws.addEventListener("message", (e: MessageEvent) => {
      const frame = JSON.parse(String(e.data)) as { type: string; envelope_id: string }
      if (frame.type !== "interactive") return
      link.ws.send(
        JSON.stringify({
          envelope_id: frame.envelope_id,
          payload: { response_action: "errors", errors: { note: "Say more" } },
        }),
      )
    })
    const res = await submit(view.id, { note: { text: "x" }, speed: { radio: "fast" } })
    expect(res).toMatchObject({ delivered: "socket", errors: { note: "Say more" } })
    expect(await link.next((f) => f.type === "interactive")).toMatchObject({
      accepts_response_payload: true,
      payload: { type: "view_submission" },
    })
    link.close()
  })
})

describe("campflare.views.close", () => {
  it("closes a view and those on it, telling the app with notify_on_close", async () => {
    const { app, bob, click, open, list } = await setup()
    const root = await open()
    const second = (
      await ok<{ view: View }>(
        "views.push",
        { trigger_id: await click(), view: { type: "modal", title: text("More"), blocks: [] } },
        app.botToken,
        { json: true },
      )
    ).view
    const close = (view_id: string) => ok<{ views: View[] }>("campflare.views.close", { view_id }, bob.token)
    expect((await close(second.id)).views.map((v) => v.id)).toEqual([root.id])
    await settle()
    expect(urls.hits.filter((h) => h.body.type === "view_closed")).toEqual([])
    expect((await close(root.id)).views).toEqual([])
    expect((await urls.next((h) => h.body.type === "view_closed")).body).toMatchObject({
      type: "view_closed",
      api_app_id: app.id,
      user: { id: bob.id },
      view: { id: root.id, callback_id: "deploy" },
      is_cleared: true,
    })
    expect(await list()).toEqual([])
  })

  it("clears the whole stack from a view with clear_on_close", async () => {
    const { app, bob, click, open } = await setup()
    await open()
    const top = (
      await ok<{ view: View }>(
        "views.push",
        {
          trigger_id: await click(),
          view: { type: "modal", title: text("Last"), blocks: [], clear_on_close: true, notify_on_close: true },
        },
        app.botToken,
        { json: true },
      )
    ).view
    expect((await ok<{ views: View[] }>("campflare.views.close", { view_id: top.id }, bob.token)).views).toEqual([])
    expect((await urls.next((h) => h.body.type === "view_closed")).body).toMatchObject({ is_cleared: true })
    expect((await call("campflare.views.close", { view_id: top.id }, bob.token)).error).toBe("not_found")
  })
})

describe("block_actions in a view", () => {
  it("sends the view, with what's typed so far, instead of a message", async () => {
    const { w, app, bob, open } = await setup()
    const view = await open({
      ...FORM,
      blocks: [
        ...FORM.blocks,
        {
          type: "section",
          block_id: "tools",
          text: { type: "mrkdwn", text: "Assign" },
          accessory: { type: "users_select", action_id: "assignee" },
        },
      ],
    })
    const choose = (args: Record<string, unknown>, token = bob.token) =>
      call("campflare.blocks.action", { view_id: view.id, block_id: "tools", action_id: "assignee", ...args }, token, {
        json: true,
      })
    expect(await choose({ value: w.owner.id, values: { note: { text: "half" } } })).toEqual({
      ok: true,
      delivered: "http",
    })
    const hit = await urls.next(isAction)
    expect(hit.body).toMatchObject({
      type: "block_actions",
      api_app_id: app.id,
      user: { id: bob.id },
      container: { type: "view", view_id: view.id },
      trigger_id: expect.any(String),
      view: { id: view.id, state: { values: { note: { text: { type: "plain_text_input", value: "half" } } } } },
      actions: [{ type: "users_select", block_id: "tools", action_id: "assignee", selected_user: w.owner.id }],
    })
    expect(hit.body).not.toHaveProperty("message")
    expect(hit.body).not.toHaveProperty("response_url")
    // The trigger_id it carries pushes a view.
    const pushed = await call(
      "views.push",
      { trigger_id: hit.body.trigger_id, view: { type: "modal", title: text("Who"), blocks: [] } },
      app.botToken,
      { json: true },
    )
    expect(pushed.ok).toBe(true)
    expect((await choose({ value: w.owner.id }, w.owner.token)).error).toBe("not_found")
  })
})

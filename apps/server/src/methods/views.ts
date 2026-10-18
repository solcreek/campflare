import { method, type Actor, type Ctx } from "../api/context"
import { CampflareError, invalidArguments } from "../api/errors"
import { first } from "../db/query"
import { hubOf } from "../events"
import type { AppRow } from "../db/rows"
import { deliverInteraction, interactor, requireChoices, triggerId } from "../interactivity"
import {
  errorsOf,
  findView,
  formState,
  givenValues,
  MAX_STACK,
  newView,
  saveStack,
  stackOf,
  updatedView,
  viewInput,
  type ViewInput,
  type ViewJson,
  type ViewRecord,
} from "../views"

// Modals. Apps open, update and push views (views.*, with their bot token);
// the person they're for lists, submits and closes them (campflare.views.*,
// with theirs), which reaches the app as view_submission and view_closed.

/** Spends a trigger_id for the calling app: whom it opens a view for. */
async function spendTrigger(ctx: Ctx<Actor>): Promise<string> {
  const trigger = ctx.args.str("trigger_id") ?? ctx.args.str("interactivity_pointer")
  if (!trigger) throw invalidArguments("missing required field: trigger_id")
  const taken = await hubOf(ctx, ctx.auth.team.id).takeTrigger(trigger, ctx.auth.app!.id)
  if ("error" in taken) throw new CampflareError(taken.error)
  return taken.userId
}

async function requireNewExternalId(ctx: Ctx<Actor>, input: ViewInput) {
  if (input.external_id && (await findView(ctx, { externalId: input.external_id, appId: ctx.auth.app!.id }))) {
    throw new CampflareError("duplicate_external_id")
  }
}

/** Opens a modal for the person whose interaction gave the app this trigger_id; it replaces what they had open. */
method("views.open", "bot", async (ctx) => {
  const input = viewInput(ctx.args.values.view)
  await requireNewExternalId(ctx, input)
  const userId = await spendTrigger(ctx)
  const view = newView(ctx.auth.app!, input)
  await saveStack(ctx, userId, [{ user_id: userId, view }])
  return { view }
})

/** Stacks a modal on the one the person has open (3 at most). */
method("views.push", "bot", async (ctx) => {
  const input = viewInput(ctx.args.values.view)
  await requireNewExternalId(ctx, input)
  const userId = await spendTrigger(ctx)
  const stack = await stackOf(ctx, userId)
  const top = stack.at(-1)
  if (!top) throw new CampflareError("not_found")
  if (stack.length >= MAX_STACK) throw new CampflareError("push_limit_reached")
  const view = newView(ctx.auth.app!, input, top.view)
  await saveStack(ctx, userId, [...stack, { user_id: userId, view }])
  return { view }
})

/** Replaces an open view of the app's, by view_id or external_id; with `hash`, only if nobody changed it since. */
method("views.update", "bot", async (ctx) => {
  const app = ctx.auth.app!
  const id = ctx.args.str("view_id")
  const externalId = ctx.args.str("external_id")
  if (!id && !externalId) throw invalidArguments("missing required field: view_id or external_id")
  const input = viewInput(ctx.args.values.view)
  const found = await findView(ctx, id ? { id } : { externalId, appId: app.id })
  const record = found?.stack[found.index]
  if (!found || !record || record.view.app_id !== app.id) throw new CampflareError("not_found")
  const hash = ctx.args.str("hash")
  if (hash && hash !== record.view.hash) throw new CampflareError("hash_conflict")
  if (input.external_id && input.external_id !== record.view.external_id) await requireNewExternalId(ctx, input)
  const view = updatedView(record.view, input)
  const stack = found.stack.with(found.index, { ...record, view })
  await saveStack(ctx, found.userId, stack)
  return { view }
})

/** The caller's open views, bottom of the stack first: the last is the one shown. */
method("campflare.views.list", "user", async (ctx) => {
  return { views: (await stackOf(ctx, ctx.auth.user.id)).map((r) => r.view) }
})

/** One of the caller's open views, by `view_id`. */
async function ownView(ctx: Ctx<Actor>) {
  const id = ctx.args.req("view_id")
  const found = await findView(ctx, { id })
  if (!found || found.userId !== ctx.auth.user.id) throw new CampflareError("not_found")
  return { ...found, view: found.stack[found.index]!.view }
}

async function appOf(ctx: Ctx<Actor>, view: ViewJson): Promise<AppRow> {
  const app = await first<AppRow>(
    ctx.env.DB,
    "SELECT * FROM apps WHERE id = ? AND team_id = ?",
    view.app_id,
    ctx.auth.team.id,
  )
  if (!app) throw new CampflareError("not_found")
  return app
}

/** The fields every view interaction payload starts with. */
const viewPayload = (ctx: Ctx<Actor>, app: AppRow) => ({
  team: { id: ctx.auth.team.id, domain: ctx.auth.team.domain },
  user: interactor(ctx.auth.user, ctx.auth.team.id),
  api_app_id: app.id,
  token: "",
  is_enterprise_install: false,
  enterprise: null,
})

/** A view_submission's response_action that isn't one, or names a view Slack wouldn't take. */
const badResponse = (why: string) =>
  new CampflareError("invalid_response_action", {
    response_metadata: { messages: [`[ERROR] the app's answer: ${why}`] },
  })

function responseView(raw: unknown): ViewInput {
  try {
    return viewInput(raw)
  } catch (error) {
    const messages = (error as CampflareError).extra?.response_metadata as { messages?: string[] } | undefined
    throw badResponse(messages?.messages?.join("; ") ?? "an invalid view")
  }
}

/**
 * The caller submits their top view: `view_id`, and `values` (JSON,
 * `{ block_id: { action_id: value } }`: text, an option's value, an id, or a
 * list of them for checkboxes and multi-selects; an input left out keeps its
 * initial value). Required inputs left empty answer `errors` without
 * bothering the app, as Slack's client does. Else the app gets
 * view_submission, and its ack's response_action decides: `errors` (shown,
 * the view stays), `update`, `push`, `clear` (every view closes), or nothing
 * (this view closes, showing the one under it).
 */
method("campflare.views.submit", "user", async (ctx) => {
  const { stack, index, view } = await ownView(ctx)
  if (index !== stack.length - 1) throw invalidArguments("only the top view of a stack can be submitted")
  if (!view.submit) throw new CampflareError("not_submittable")
  const form = formState(view, givenValues(ctx.args.json("values")))
  await requireChoices(ctx, form.choices)
  if (Object.keys(form.errors).length > 0) return { views: stack.map((r) => r.view), errors: form.errors }

  const app = await appOf(ctx, view)
  const submitted: ViewJson = { ...view, state: { values: form.values } }
  const { delivered, response } = await deliverInteraction(
    ctx,
    app,
    { type: "view_submission", ...viewPayload(ctx, app), trigger_id: triggerId(), view: submitted, response_urls: [] },
    { acceptsResponse: true },
  )

  // The app may have changed the stack before it answered (views.update): what's there now is what the answer applies to.
  const now = await stackOf(ctx, ctx.auth.user.id)
  const at = now.findIndex((r) => r.view.id === view.id)
  const answer = response && typeof response === "object" ? (response as Record<string, unknown>) : {}
  const action = answer.response_action
  let next: ViewRecord[] = now
  if (action === "errors") {
    const errors = errorsOf(answer.errors, view)
    return { delivered, views: now.map((r) => r.view), errors }
  }
  const mine = (v: ViewJson): ViewRecord => ({ user_id: ctx.auth.user.id, view: v })
  if (action === "clear") next = []
  else if (action === "update") {
    const input = responseView(answer.view)
    if (at >= 0) next = now.with(at, mine({ ...updatedView(now[at]!.view, input), state: submitted.state }))
  } else if (action === "push") {
    const input = responseView(answer.view)
    if (now.length >= MAX_STACK) throw new CampflareError("push_limit_reached")
    const kept = at >= 0 ? now.with(at, mine({ ...now[at]!.view, state: submitted.state })) : now
    next = [...kept, mine(newView(app, input, kept.at(-1)?.view))]
  } else if (action === undefined || action === null || action === "") {
    if (at >= 0) next = now.slice(0, at)
  } else throw badResponse(`unknown response_action ${JSON.stringify(action)}`)
  if (next !== now) await saveStack(ctx, ctx.auth.user.id, next)
  return { delivered, views: next.map((r) => r.view) }
})

/**
 * The caller closes one of their views (`view_id`) and those on top of it;
 * all of them when it has clear_on_close. With notify_on_close, the app gets
 * view_closed (`is_cleared` when the whole stack went), best effort: a close
 * isn't the app's to refuse.
 */
method("campflare.views.close", "user", async (ctx) => {
  const { stack, index, view } = await ownView(ctx)
  const cleared = view.clear_on_close || index === 0
  const next = view.clear_on_close ? [] : stack.slice(0, index)
  await saveStack(ctx, ctx.auth.user.id, next)
  if (view.notify_on_close) {
    const app = await appOf(ctx, view)
    ctx.waitUntil(
      deliverInteraction(ctx, app, { type: "view_closed", ...viewPayload(ctx, app), view, is_cleared: cleared }).catch(
        () => undefined,
      ),
    )
  }
  return { views: next.map((r) => r.view) }
})

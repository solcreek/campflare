import type { Actor, Ctx } from "./api/context"
import { CampflareError, invalidArguments } from "./api/errors"
import { randomId } from "./api/ids"
import type { AppRow } from "./db/rows"
import { ID_SELECTS, optionOut, optionsOf, type Choice } from "./interactivity"
import { hubOf } from "./events"
import { withBlockIds } from "./methods/chat"

// Modals (views): an app opens one for the person whose click gave it a
// trigger_id (views.open), changes it (views.update), or stacks another on it
// (views.push). They live in the workspace's hub, a stack per person; each
// change reaches the person's clients as a `views_changed` RTM event. The
// person submits (view_submission) or closes (view_closed) through
// campflare.views.*; see methods/views.ts.

type Json = Record<string, unknown>

const isJson = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v)

/** A view as Slack hands it to apps (views.open's answer, view_submission's `view`). */
export interface ViewJson extends Json {
  id: string
  team_id: string
  type: "modal"
  blocks: Json[]
  private_metadata: string
  callback_id: string
  state: { values: StateValues }
  hash: string
  title: Json
  clear_on_close: boolean
  notify_on_close: boolean
  close: Json | null
  submit: Json | null
  previous_view_id: string | null
  root_view_id: string
  app_id: string
  external_id: string
  app_installed_team_id: string
  bot_id: string
}

/** state.values: by block_id, then action_id, the element's type and what's chosen or typed. */
export type StateValues = Record<string, Record<string, Json>>

/** A view in a person's stack, as the hub keeps it. */
export interface ViewRecord {
  user_id: string
  view: ViewJson
}

/** Slack allows 3 views in a stack. */
export const MAX_STACK = 3

/** A view's hash, which changes with every update: views.update with an older one is a hash_conflict. */
export const viewHash = () => `${Math.floor(Date.now() / 1000)}.${randomId("", 8)}`

const plainText = (v: unknown, name: string, max: number, required: boolean): Json | null => {
  if (v === undefined || v === null) {
    if (required) throw invalidArguments(`must provide a value for ${name}`)
    return null
  }
  if (!isJson(v) || v.type !== "plain_text" || typeof v.text !== "string") {
    throw invalidArguments(`${name} must be a plain_text object`)
  }
  if (v.text.length > max) throw invalidArguments(`${name}.text must be at most ${max} characters`)
  return v
}

const shortString = (v: unknown, name: string, max: number): string => {
  if (v === undefined || v === null) return ""
  if (typeof v !== "string") throw invalidArguments(`${name} must be a string`)
  if (v.length > max) throw invalidArguments(`${name} must be at most ${max} characters`)
  return v
}

/** What an app gives for a view (views.open, views.update, a response_action), checked as Slack checks it. */
export type ViewInput = Pick<
  ViewJson,
  | "type"
  | "title"
  | "blocks"
  | "close"
  | "submit"
  | "private_metadata"
  | "callback_id"
  | "clear_on_close"
  | "notify_on_close"
  | "external_id"
>

/** The `view` argument of views.open/update/push (an object, or JSON in a form), or a response_action's. */
export function viewInput(raw: unknown): ViewInput {
  let view = raw
  if (typeof raw === "string") {
    try {
      view = JSON.parse(raw)
    } catch {
      throw invalidArguments("view must be JSON")
    }
  }
  if (!isJson(view)) throw invalidArguments("missing required field: view")
  if (view.type !== "modal") throw invalidArguments("view.type must be modal (home tabs aren't supported)")
  if (!Array.isArray(view.blocks)) throw invalidArguments("view.blocks must be an array")
  if (view.blocks.length > 100) throw invalidArguments("view.blocks must have at most 100 blocks")
  const blocks = withBlockIds(view.blocks) as Json[]
  for (const [i, block] of blocks.entries()) {
    if (!isJson(block) || typeof block.type !== "string") throw invalidArguments(`view.blocks[${i}] must be a block`)
    if (block.type === "input") {
      plainText(block.label, `view.blocks[${i}].label`, 2000, true)
      if (!isJson(block.element) || typeof block.element.type !== "string") {
        throw invalidArguments(`view.blocks[${i}].element is required in an input block`)
      }
    }
  }
  const ids = blocks.map((b) => b.block_id)
  if (new Set(ids).size !== ids.length) throw invalidArguments("view.blocks must have unique block_ids")
  const submit = plainText(view.submit, "view.submit", 24, false)
  if (!submit && blocks.some((b) => b.type === "input")) {
    throw invalidArguments("view.submit is required when an input block is within the blocks array")
  }
  return {
    type: "modal",
    title: plainText(view.title, "view.title", 24, true)!,
    blocks,
    close: plainText(view.close, "view.close", 24, false),
    submit,
    private_metadata: shortString(view.private_metadata, "view.private_metadata", 3000),
    callback_id: shortString(view.callback_id, "view.callback_id", 255),
    clear_on_close: view.clear_on_close === true,
    notify_on_close: view.notify_on_close === true,
    external_id: shortString(view.external_id, "view.external_id", 255),
  }
}

/** A new view of an app's, for a person, on top of `previous` (or a new stack). */
export function newView(
  app: Pick<AppRow, "id" | "team_id" | "bot_id">,
  input: ViewInput,
  previous?: ViewJson,
): ViewJson {
  const id = randomId("V")
  return {
    id,
    team_id: app.team_id,
    ...input,
    state: { values: {} },
    hash: viewHash(),
    previous_view_id: previous?.id ?? null,
    root_view_id: previous?.root_view_id ?? id,
    app_id: app.id,
    app_installed_team_id: app.team_id,
    bot_id: app.bot_id,
  }
}

/**
 * A view replaced by an update: the same place in its stack, a new hash, the
 * state kept, and its external_id unless the new view brings its own.
 */
export const updatedView = (view: ViewJson, input: ViewInput): ViewJson => ({
  ...view,
  ...input,
  external_id: input.external_id || view.external_id,
  hash: viewHash(),
})

/** The hub of the actor's workspace. */

/** A person's open views, bottom first. */
export async function stackOf(ctx: Ctx<Actor>, userId: string): Promise<ViewRecord[]> {
  return (await hubOf(ctx, ctx.auth.team.id).viewStack(userId)).map((body) => JSON.parse(body) as ViewRecord)
}

/** Replaces a person's stack, and shows it on their clients. */
export async function saveStack(ctx: Ctx<Actor>, userId: string, stack: ViewRecord[]): Promise<void> {
  await hubOf(ctx, ctx.auth.team.id).saveViews(
    ctx.auth.team.id,
    userId,
    stack.map((r) => JSON.stringify(r)),
    JSON.stringify(stack.map((r) => r.view)),
  )
}

/** The stack holding a view (found by id, or by external_id for its app), and where in it. */
export async function findView(
  ctx: Ctx<Actor>,
  by: { id?: string; externalId?: string; appId?: string },
): Promise<{ userId: string; stack: ViewRecord[]; index: number } | undefined> {
  const userId = await hubOf(ctx, ctx.auth.team.id).findView(by)
  if (!userId) return undefined
  const stack = await stackOf(ctx, userId)
  const index = stack.findIndex((r) =>
    by.id ? r.view.id === by.id : r.view.external_id === by.externalId && r.view.app_id === by.appId,
  )
  return index < 0 ? undefined : { userId, stack, index }
}

/** What a person's client says an input holds: a value, an option's value or an id, several for multi-selects. */
export type Given = Record<string, Record<string, string | string[] | null | undefined>>

/** Elements whose value is text the person typed. */
const TEXT_INPUTS = new Set(["plain_text_input", "email_text_input", "url_text_input", "number_input"])
/** Multi-selects of people or conversations: the field Slack names the choices by, and what each one is. */
const MULTI_ID_SELECTS: Record<string, { field: string; each: Choice["field"] }> = {
  multi_users_select: { field: "selected_users", each: "selected_user" },
  multi_conversations_select: { field: "selected_conversations", each: "selected_conversation" },
  multi_channels_select: { field: "selected_channels", each: "selected_channel" },
}

export interface FormState {
  values: StateValues
  /** Inputs left empty that aren't optional, by block_id: Slack's client says so before sending anything. */
  errors: Record<string, string>
  /** People and conversations chosen, to check they were on offer (requireChoices). */
  choices: Choice[]
}

const asList = (v: string | string[] | null | undefined) => (v === undefined || v === null ? [] : [v].flat())

/**
 * The state of a view's inputs, in Slack's shape, from what the person's
 * client says each holds; an input it doesn't mention keeps its initial
 * value. Something the view doesn't offer (an option, an unknown input) is
 * `invalid_arguments`; a required input left empty is an error for its block.
 */
export function formState(view: Pick<ViewJson, "blocks">, given: Given = {}): FormState {
  const values: StateValues = {}
  const errors: Record<string, string> = {}
  const choices: Choice[] = []
  const known = new Set<string>()
  for (const block of view.blocks) {
    if (block.type !== "input" || !isJson(block.element)) continue
    const blockId = block.block_id as string
    const element = block.element
    const type = element.type as string
    const actionId = element.action_id as string
    known.add(`${blockId}.${actionId}`)
    const raw = given[blockId]?.[actionId]
    const said = raw !== undefined
    const name = `${blockId}.${actionId}`
    const one = (v: string | string[] | null | undefined) => {
      const list = asList(v)
      if (list.length > 1) throw invalidArguments(`${name} takes one value`)
      return list[0] || undefined
    }
    let value: Json
    let empty: boolean
    if (TEXT_INPUTS.has(type)) {
      const initial = typeof element.initial_value === "string" ? element.initial_value : undefined
      const text = said ? one(raw) : initial
      if (text !== undefined && type === "number_input") {
        const n = Number(text)
        if (!Number.isFinite(n) || (!element.is_decimal_allowed && !Number.isInteger(n))) {
          errors[blockId] = element.is_decimal_allowed ? "Enter a number." : "Enter a whole number."
        }
      }
      if (text !== undefined && type === "plain_text_input") {
        const max = typeof element.max_length === "number" ? element.max_length : 3000
        const min = typeof element.min_length === "number" ? element.min_length : 0
        if (text.length > max) errors[blockId] = `Use at most ${max} characters.`
        else if (text.length < min) errors[blockId] = `Use at least ${min} characters.`
      }
      value = { value: text ?? null }
      empty = !text
    } else if (type === "static_select" || type === "radio_buttons") {
      const initial = isJson(element.initial_option) ? (element.initial_option.value as string) : undefined
      const chosen = said ? one(raw) : initial
      const option = chosen === undefined ? undefined : optionsOf(element).find((o) => o.value === chosen)
      if (chosen !== undefined && !option) throw invalidArguments(`${name} has no option ${chosen}`)
      value = { selected_option: option ? optionOut(option) : null }
      empty = !option
    } else if (type === "multi_static_select" || type === "checkboxes") {
      const initial = Array.isArray(element.initial_options)
        ? element.initial_options.filter(isJson).map((o) => o.value as string)
        : []
      const chosen = said ? asList(raw).filter(Boolean) : initial
      const options = optionsOf(element)
      const selected = chosen.map((v) => {
        const option = options.find((o) => o.value === v)
        if (!option) throw invalidArguments(`${name} has no option ${v}`)
        return optionOut(option)
      })
      value = { selected_options: selected }
      empty = selected.length === 0
    } else if (ID_SELECTS[type]) {
      const field = ID_SELECTS[type]
      const initial = element[field.replace("selected_", "initial_")]
      const id = said ? one(raw) : typeof initial === "string" ? initial : undefined
      if (id) choices.push({ field, id })
      value = { [field]: id ?? null }
      empty = !id
    } else if (MULTI_ID_SELECTS[type]) {
      const { field, each } = MULTI_ID_SELECTS[type]
      const initial = element[field.replace("selected_", "initial_")]
      const ids = said ? asList(raw).filter(Boolean) : Array.isArray(initial) ? initial.map(String) : []
      for (const id of ids) choices.push({ field: each, id })
      value = { [field]: ids }
      empty = ids.length === 0
    } else if (type === "datepicker") {
      const date = said ? one(raw) : typeof element.initial_date === "string" ? element.initial_date : undefined
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalidArguments(`${name} must be YYYY-MM-DD`)
      value = { selected_date: date ?? null }
      empty = !date
    } else if (type === "timepicker") {
      const time = said ? one(raw) : typeof element.initial_time === "string" ? element.initial_time : undefined
      if (time !== undefined && !/^\d{2}:\d{2}$/.test(time)) throw invalidArguments(`${name} must be HH:mm`)
      value = { selected_time: time ?? null }
      empty = !time
    } else {
      if (said) throw invalidArguments(`${name} is a ${type}, which can't be filled in yet`)
      value = {}
      empty = false
    }
    values[blockId] = { ...values[blockId], [actionId]: { type, ...value } }
    if (empty && block.optional !== true && !errors[blockId]) errors[blockId] = "Please complete this required field."
  }
  for (const [blockId, actions] of Object.entries(given)) {
    for (const actionId of Object.keys(actions ?? {})) {
      if (!known.has(`${blockId}.${actionId}`)) throw invalidArguments(`no input ${blockId}.${actionId} in this view`)
    }
  }
  return { values, errors, choices }
}

/** The `values` argument: `{ block_id: { action_id: value } }`, as JSON. */
export function givenValues(raw: unknown): Given {
  if (raw === undefined) return {}
  if (!isJson(raw)) throw invalidArguments("values must be an object of block_ids, each an object of action_ids")
  for (const [blockId, actions] of Object.entries(raw)) {
    if (!isJson(actions)) throw invalidArguments(`values.${blockId} must be an object of action_ids`)
    for (const [actionId, v] of Object.entries(actions)) {
      const fine = v === null || typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))
      if (!fine) throw invalidArguments(`values.${blockId}.${actionId} must be a string or a list of strings`)
    }
  }
  return raw as Given
}

/** Errors for the view as a response_action gives them: `{ block_id: message }`. */
export function errorsOf(raw: unknown, view: ViewJson): Record<string, string> {
  if (!isJson(raw)) throw new CampflareError("invalid_response_action")
  const blocks = new Set(view.blocks.map((b) => b.block_id))
  const errors: Record<string, string> = {}
  for (const [blockId, message] of Object.entries(raw)) {
    if (typeof message !== "string" || !blocks.has(blockId)) throw new CampflareError("invalid_response_action")
    errors[blockId] = message
  }
  return errors
}

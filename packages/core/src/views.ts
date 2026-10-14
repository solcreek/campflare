import { isObject, optionsOf, textOf, type MenuOption } from "./blocks"
import type { MessageBlock } from "./types"

// Modals (views) an app opened for you, and their forms as a UI shows them.
// The server keeps the stack (the last one is shown); it arrives over RTM as
// `views_changed`, and campflare.views.list after a (re)connect. What you type
// stays in the UI until you submit: `FormValues`, as campflare.views.submit
// takes them.

/** A view as Slack hands it out (views.open's answer), as far as a UI reads it. */
export interface View {
  id: string
  type: string
  title?: { text: string }
  submit?: { text: string } | null
  close?: { text: string } | null
  blocks: MessageBlock[]
  callback_id?: string
  /** Changes with every update: a form showing another hash starts again from the view's initial values. */
  hash?: string
  [key: string]: unknown
}

/** What a form's inputs hold, by block_id then action_id: text, an option's value, an id, or several. */
export type FormValues = Record<string, Record<string, string | string[]>>

/** A view's input, as the UI draws it. */
export type FormField = {
  blockId: string
  actionId: string
  label: string
  /** The hint under it. */
  hint?: string
  optional: boolean
} & (
  | {
      kind: "text"
      multiline: boolean
      inputType: "text" | "email" | "url" | "number"
      placeholder?: string
      minLength?: number
      maxLength?: number
      initial?: string
    }
  | {
      kind: "select"
      select: "static" | "users" | "conversations" | "channels"
      placeholder?: string
      /** static only. */
      options: MenuOption[]
      initial?: string
    }
  | { kind: "checkboxes"; options: MenuOption[]; initial: string[] }
  | { kind: "radio"; options: MenuOption[]; initial?: string }
  | { kind: "date"; initial?: string }
  /** An element the UI can't fill in: shown as such, left as it is. */
  | { kind: "unsupported"; type: string }
)

const TEXT_TYPES = {
  plain_text_input: "text",
  email_text_input: "email",
  url_text_input: "url",
  number_input: "number",
} as const

const SELECT_TYPES = {
  static_select: { select: "static", initial: "initial_option" },
  users_select: { select: "users", initial: "initial_user" },
  conversations_select: { select: "conversations", initial: "initial_conversation" },
  channels_select: { select: "channels", initial: "initial_channel" },
} as const

const num = (v: unknown) => (typeof v === "number" ? v : undefined)
const valueOf = (v: unknown) => (isObject(v) && typeof v.value === "string" ? v.value : undefined)

/** An input block's field; undefined for any other block. */
export function formField(block: MessageBlock): FormField | undefined {
  if (block.type !== "input" || !isObject(block.element) || typeof block.block_id !== "string") return undefined
  const e = block.element
  if (typeof e.action_id !== "string") return undefined
  const hint = textOf(block.hint)
  const base = {
    blockId: block.block_id,
    actionId: e.action_id,
    label: textOf(block.label),
    ...(hint ? { hint } : {}),
    optional: block.optional === true,
  }
  const type = String(e.type)
  const placeholder = textOf(e.placeholder) || undefined
  const textType = TEXT_TYPES[type as keyof typeof TEXT_TYPES]
  if (textType) {
    const initial = typeof e.initial_value === "string" ? e.initial_value : undefined
    return {
      ...base,
      kind: "text",
      multiline: e.multiline === true,
      inputType: textType,
      ...(placeholder ? { placeholder } : {}),
      ...(num(e.min_length) !== undefined ? { minLength: num(e.min_length) } : {}),
      ...(num(e.max_length) !== undefined ? { maxLength: num(e.max_length) } : {}),
      ...(initial !== undefined ? { initial } : {}),
    }
  }
  const select = SELECT_TYPES[type as keyof typeof SELECT_TYPES]
  if (select) {
    const raw = e[select.initial]
    const initial = select.select === "static" ? valueOf(raw) : typeof raw === "string" ? raw : undefined
    return {
      ...base,
      kind: "select",
      select: select.select,
      options: select.select === "static" ? optionsOf(e) : [],
      ...(placeholder ? { placeholder } : {}),
      ...(initial ? { initial } : {}),
    }
  }
  if (type === "checkboxes") {
    const initial = Array.isArray(e.initial_options)
      ? e.initial_options.map(valueOf).filter((v) => v !== undefined)
      : []
    return { ...base, kind: "checkboxes", options: optionsOf(e), initial: initial as string[] }
  }
  if (type === "radio_buttons") {
    const initial = valueOf(e.initial_option)
    return { ...base, kind: "radio", options: optionsOf(e), ...(initial ? { initial } : {}) }
  }
  if (type === "datepicker") {
    const initial = typeof e.initial_date === "string" ? e.initial_date : undefined
    return { ...base, kind: "date", ...(initial ? { initial } : {}) }
  }
  return { ...base, kind: "unsupported", type }
}

/** A field's starting value, as FormValues holds it: undefined when it starts empty. */
export function initialValue(field: FormField): string | string[] | undefined {
  switch (field.kind) {
    case "checkboxes":
      return field.initial.length > 0 ? field.initial : undefined
    case "unsupported":
      return undefined
    default:
      return field.initial
  }
}

/** Each of a view's fields with its starting value: what a fresh form holds. */
export function initialValues(view: View): FormValues {
  const values: FormValues = {}
  for (const block of view.blocks) {
    const field = formField(block)
    const value = field && initialValue(field)
    if (field && value !== undefined) values[field.blockId] = { ...values[field.blockId], [field.actionId]: value }
  }
  return values
}

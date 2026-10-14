// The interactive parts of Block Kit blocks, as a UI shows them: `actions`
// blocks of buttons, icon buttons, select menus and overflow menus, a
// section's accessory (one of those), and `context_actions` blocks of
// feedback buttons. Other elements (date pickers in a message…) aren't
// clickable here yet and are left out. The same goes for a view's blocks.

/** A button in an `actions` block (or a section's accessory). */
export interface ActionButton {
  kind: "button"
  actionId: string
  label: string
  /** What a screen reader says, when the app gave one; else the label. */
  accessibilityLabel?: string
  value?: string
  style?: "primary" | "danger"
  /** A link button: the UI opens it and still tells the app. http(s) only. */
  url?: string
}

/** A button drawn as an icon (Slack's icon_button: "trash", …). */
export interface IconButton {
  kind: "icon"
  actionId: string
  icon: string
  label: string
  accessibilityLabel?: string
  value?: string
}

/** One of a menu's options. */
export interface MenuOption {
  label: string
  value: string
  description?: string
  /** The option group it's in, if the menu has groups. */
  group?: string
}

/**
 * A select menu: of the app's options (`static`), or of people, conversations
 * or public channels, which the UI lists from what it knows. The choice is the
 * click's value: an option's value, or an id.
 */
export interface SelectMenu {
  kind: "select"
  actionId: string
  select: "static" | "users" | "conversations" | "channels"
  placeholder?: string
  /** static only. */
  options: MenuOption[]
  /** The choice it starts with: an option's value, or an id. */
  initial?: string
}

/** An overflow menu ("…"): a choice among the app's options, each one an action. */
export interface OverflowMenu {
  kind: "overflow"
  actionId: string
  options: MenuOption[]
}

export type ActionElement = ActionButton | IconButton | SelectMenu | OverflowMenu

/** One of a feedback_buttons pair. */
export interface FeedbackButton {
  label: string
  accessibilityLabel?: string
  value: string
}

export type InteractiveBlock =
  | { type: "actions"; blockId: string; elements: ActionElement[] }
  | { type: "feedback"; blockId: string; actionId: string; positive: FeedbackButton; negative: FeedbackButton }

/** What a click names: the method's block_id, action_id and value (a button's, an option's, an id). */
export interface Click {
  blockId: string
  actionId: string
  value?: string
}

type Json = Record<string, unknown>

export const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v)
export const textOf = (v: unknown) => (isObject(v) && typeof v.text === "string" ? v.text : "")
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

function feedbackButton(v: unknown): FeedbackButton | undefined {
  if (!isObject(v) || typeof v.value !== "string") return undefined
  const accessibilityLabel = str(v.accessibility_label)
  return { label: textOf(v.text), value: v.value, ...(accessibilityLabel ? { accessibilityLabel } : {}) }
}

function option(v: unknown, group?: string): MenuOption | undefined {
  if (!isObject(v) || typeof v.value !== "string") return undefined
  const description = textOf(v.description)
  return { label: textOf(v.text), value: v.value, ...(description ? { description } : {}), ...(group ? { group } : {}) }
}

/** An element's options, in order, those in option groups with their group's label. */
export function optionsOf(e: Json): MenuOption[] {
  const flat = Array.isArray(e.options) ? e.options.map((o) => option(o)) : []
  const grouped = Array.isArray(e.option_groups)
    ? e.option_groups
        .filter(isObject)
        .flatMap((g) => (Array.isArray(g.options) ? g.options : []).map((o) => option(o, textOf(g.label))))
    : []
  return [...flat, ...grouped].filter((o): o is MenuOption => Boolean(o))
}

const SELECTS = {
  static_select: "static",
  users_select: "users",
  conversations_select: "conversations",
  channels_select: "channels",
} as const

/** Where a select menu's choice starts, by its kind: initial_option's value, or initial_user and the like. */
function initialOf(e: Json, select: SelectMenu["select"]): string | undefined {
  if (select === "static") return isObject(e.initial_option) ? str(e.initial_option.value) : undefined
  return str(e[{ users: "initial_user", conversations: "initial_conversation", channels: "initial_channel" }[select]])
}

/** An interactive element as the UI shows it; undefined for the ones it can't. */
export function actionElement(e: Json): ActionElement | undefined {
  if (typeof e.action_id !== "string") return undefined
  const actionId = e.action_id
  const accessibilityLabel = str(e.accessibility_label)
  const label = { label: textOf(e.text), ...(accessibilityLabel ? { accessibilityLabel } : {}) }
  const value = typeof e.value === "string" ? { value: e.value } : {}
  if (e.type === "button") {
    const url = str(e.url)
    return {
      kind: "button",
      actionId,
      ...label,
      ...value,
      ...(e.style === "primary" || e.style === "danger" ? { style: e.style } : {}),
      ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
    }
  }
  if (e.type === "icon_button") return { kind: "icon", actionId, icon: str(e.icon) ?? "", ...label, ...value }
  if (e.type === "overflow") return { kind: "overflow", actionId, options: optionsOf(e) }
  const select = SELECTS[e.type as keyof typeof SELECTS]
  if (select) {
    const placeholder = textOf(e.placeholder)
    const initial = initialOf(e, select)
    return {
      kind: "select",
      actionId,
      select,
      options: select === "static" ? optionsOf(e) : [],
      ...(placeholder ? { placeholder } : {}),
      ...(initial ? { initial } : {}),
    }
  }
  return undefined
}

/** The interactive blocks of a message's (or a view's) `blocks`, in order; none for anything else. */
export function interactiveBlocks(blocks: unknown): InteractiveBlock[] {
  if (!Array.isArray(blocks)) return []
  const found: InteractiveBlock[] = []
  for (const block of blocks) {
    if (!isObject(block) || typeof block.block_id !== "string") continue
    if (block.type === "section" && isObject(block.accessory)) {
      const element = actionElement(block.accessory)
      if (element) found.push({ type: "actions", blockId: block.block_id, elements: [element] })
      continue
    }
    if (!Array.isArray(block.elements)) continue
    const elements = block.elements.filter(isObject)
    if (block.type === "actions") {
      const shown = elements.map(actionElement).filter((e): e is ActionElement => Boolean(e))
      if (shown.length > 0) found.push({ type: "actions", blockId: block.block_id, elements: shown })
    } else if (block.type === "context_actions") {
      for (const e of elements) {
        if (e.type !== "feedback_buttons" || typeof e.action_id !== "string") continue
        const positive = feedbackButton(e.positive_button)
        const negative = feedbackButton(e.negative_button)
        if (positive && negative) {
          found.push({ type: "feedback", blockId: block.block_id, actionId: e.action_id, positive, negative })
        }
      }
    }
  }
  return found
}

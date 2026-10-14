// The interactive parts of a message's Block Kit blocks, as a UI shows them:
// `actions` blocks of buttons, and `context_actions` blocks of feedback
// buttons. Other elements (selects, date pickers…) aren't clickable here yet
// and are left out.

/** A button in an `actions` block. */
export interface ActionButton {
  actionId: string
  label: string
  /** What a screen reader says, when the app gave one; else the label. */
  accessibilityLabel?: string
  value?: string
  style?: "primary" | "danger"
  /** A link button: the UI opens it and still tells the app. http(s) only. */
  url?: string
}

/** One of a feedback_buttons pair. */
export interface FeedbackButton {
  label: string
  accessibilityLabel?: string
  value: string
}

export type InteractiveBlock =
  | { type: "actions"; blockId: string; buttons: ActionButton[] }
  | { type: "feedback"; blockId: string; actionId: string; positive: FeedbackButton; negative: FeedbackButton }

/** What a click names: the method's block_id, action_id and value. */
export interface Click {
  blockId: string
  actionId: string
  value?: string
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v)
const textOf = (v: unknown) => (isObject(v) && typeof v.text === "string" ? v.text : "")
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined)

function feedbackButton(v: unknown): FeedbackButton | undefined {
  if (!isObject(v) || typeof v.value !== "string") return undefined
  const accessibilityLabel = str(v.accessibility_label)
  return { label: textOf(v.text), value: v.value, ...(accessibilityLabel ? { accessibilityLabel } : {}) }
}

/** The interactive blocks of a message's `blocks`, in order; none for anything else. */
export function interactiveBlocks(blocks: unknown): InteractiveBlock[] {
  if (!Array.isArray(blocks)) return []
  const found: InteractiveBlock[] = []
  for (const block of blocks) {
    if (!isObject(block) || !Array.isArray(block.elements) || typeof block.block_id !== "string") continue
    const elements = block.elements.filter(isObject)
    if (block.type === "actions") {
      const buttons: ActionButton[] = []
      for (const e of elements) {
        if (e.type !== "button" || typeof e.action_id !== "string") continue
        const url = str(e.url)
        const accessibilityLabel = str(e.accessibility_label)
        buttons.push({
          actionId: e.action_id,
          label: textOf(e.text),
          ...(accessibilityLabel ? { accessibilityLabel } : {}),
          ...(typeof e.value === "string" ? { value: e.value } : {}),
          ...(e.style === "primary" || e.style === "danger" ? { style: e.style } : {}),
          ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
        })
      }
      if (buttons.length > 0) found.push({ type: "actions", blockId: block.block_id, buttons })
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

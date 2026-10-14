// What an app's agent is doing, as Slack's `task_card` and `plan` blocks hold
// it: a streamed reply's task_update chunks become task cards (among the text,
// or the tasks of one plan block, whose title plan_update sets). A UI shows
// each task's title and status, and its details, output and sources.

export type TaskStatus = "pending" | "in_progress" | "complete" | "error"

export interface TaskSource {
  url: string
  text: string
}

export interface Task {
  id: string
  title: string
  status: TaskStatus
  /** The task's details and output, as plain text. */
  details?: string
  output?: string
  /** Links the task used, http(s) only. */
  sources: TaskSource[]
}

export interface Plan {
  title: string
  tasks: Task[]
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v)
const STATUSES = new Set<string>(["pending", "in_progress", "complete", "error"])

/** The text of a rich_text block (or any element tree): its text, link and emoji leaves, joined. */
export function richTextPlain(value: unknown): string {
  if (Array.isArray(value)) return value.map(richTextPlain).join("")
  if (!isObject(value)) return ""
  if (value.type === "text" && typeof value.text === "string") return value.text
  if (value.type === "link" && typeof value.url === "string")
    return typeof value.text === "string" && value.text ? value.text : value.url
  if (value.type === "emoji" && typeof value.name === "string") return `:${value.name}:`
  // The sections, lists and quotes of a rich_text block are lines of their own.
  if (value.type === "rich_text" && Array.isArray(value.elements)) return value.elements.map(richTextPlain).join("\n")
  return richTextPlain(value.elements)
}

/** A task_card block as a task; undefined for anything else. */
export function taskOf(block: unknown): Task | undefined {
  if (!isObject(block) || block.type !== "task_card" || typeof block.task_id !== "string") return undefined
  const status = (STATUSES.has(String(block.status)) ? block.status : "pending") as TaskStatus
  const details = richTextPlain(block.details).trim()
  const output = richTextPlain(block.output).trim()
  const sources = Array.isArray(block.sources)
    ? block.sources.filter(
        (s): s is TaskSource => isObject(s) && typeof s.url === "string" && /^https?:\/\//i.test(s.url),
      )
    : []
  return {
    id: block.task_id,
    title: typeof block.title === "string" ? block.title : "",
    status,
    ...(details ? { details } : {}),
    ...(output ? { output } : {}),
    sources: sources.map((s) => ({ url: s.url, text: typeof s.text === "string" && s.text ? s.text : s.url })),
  }
}

/** A plan block as its title and tasks; undefined for anything else. */
export function planOf(block: unknown): Plan | undefined {
  if (!isObject(block) || block.type !== "plan") return undefined
  const tasks = Array.isArray(block.tasks) ? block.tasks.map(taskOf).filter((t): t is Task => Boolean(t)) : []
  return { title: typeof block.title === "string" ? block.title : "", tasks }
}

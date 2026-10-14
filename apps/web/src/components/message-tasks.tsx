import type { Plan, Task, TaskStatus } from "@campflare/core"
import { CheckCircle2Icon, CircleIcon, Loader2Icon, XCircleIcon } from "lucide-react"
import { cn } from "@/lib/utils"

// What an app's agent is doing, from the task_card and plan blocks its
// streamed reply holds: each task with its status, details, output and
// sources; a plan is its title over its tasks.

const STATUS: Record<TaskStatus, { label: string; icon: typeof CircleIcon; className: string }> = {
  pending: { label: "Pending", icon: CircleIcon, className: "text-muted-foreground" },
  in_progress: { label: "In progress", icon: Loader2Icon, className: "animate-spin text-primary" },
  complete: { label: "Done", icon: CheckCircle2Icon, className: "text-green-600 dark:text-green-500" },
  error: { label: "Failed", icon: XCircleIcon, className: "text-destructive" },
}

function TaskItem({ task }: { task: Task }) {
  const status = STATUS[task.status]
  const Icon = status.icon
  return (
    <li className="flex gap-2" data-status={task.status}>
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", status.className)} />
      <div className="min-w-0">
        <div>
          {task.title}
          <span className="sr-only">, {status.label}</span>
        </div>
        {task.details && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{task.details}</p>}
        {task.output && <p className="text-sm whitespace-pre-wrap">{task.output}</p>}
        {task.sources.length > 0 && (
          <div className="flex flex-wrap gap-x-2 text-xs">
            {task.sources.map((s) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                {s.text}
              </a>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

/** Tasks shown among a reply's text, consecutive ones as one list. */
export function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <ul aria-label="Tasks" className="my-1 space-y-1">
      {tasks.map((t) => (
        <TaskItem key={t.id} task={t} />
      ))}
    </ul>
  )
}

/** A plan: its title, how far along it is, and its tasks in order. */
export function PlanView({ plan }: { plan: Plan }) {
  const done = plan.tasks.filter((t) => t.status === "complete").length
  const title = plan.title || "Plan"
  return (
    <section aria-label={title} className="my-1 rounded-md border px-3 py-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-semibold">{title}</span>
        {plan.tasks.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {done} of {plan.tasks.length} done
          </span>
        )}
      </div>
      {plan.tasks.length > 0 && (
        <ol aria-label="Tasks" className="space-y-1">
          {plan.tasks.map((t) => (
            <TaskItem key={t.id} task={t} />
          ))}
        </ol>
      )}
    </section>
  )
}

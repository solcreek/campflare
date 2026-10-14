import { displayName, keyOf, threadStatus } from "@campflare/core"
import { useEffect, useState } from "react"
import { useWorkspaceState } from "@/workspace"

/** How long each of an app's loading messages shows before the next. */
export const LOADING_MESSAGE_MS = 3000

const nowSeconds = () => Date.now() / 1000

/**
 * An app's status in a thread ("Answer Bot is thinking…"), from
 * assistant.threads.setStatus, until the app replies, clears it or it runs out.
 * Loading messages, when the app gave some, take turns beside it.
 */
export function ThreadStatusLine({ channel, threadTs }: { channel: string; threadTs: string }) {
  const statuses = useWorkspaceState((s) => s.statuses)
  const users = useWorkspaceState((s) => s.users)
  const raw = statuses[keyOf(channel, threadTs)]
  const [now, setNow] = useState(nowSeconds)
  const [turn, setTurn] = useState(0)

  // Look again when it runs out.
  useEffect(() => {
    if (!raw) return
    const timer = setTimeout(() => setNow(nowSeconds()), Math.max(0, raw.expires - nowSeconds()) * 1000)
    return () => clearTimeout(timer)
  }, [raw])

  const loading = raw?.loadingMessages
  useEffect(() => {
    if (!loading) return
    const timer = setInterval(() => setTurn((t) => t + 1), LOADING_MESSAGE_MS)
    return () => clearInterval(timer)
  }, [loading])

  const status = threadStatus(statuses, channel, threadTs, Math.max(now, nowSeconds()))
  if (!status) return null
  const name = displayName(users[status.user])
  return (
    <p role="status" className="flex items-center gap-2 px-4 py-1 text-sm text-muted-foreground">
      <span aria-hidden className="flex gap-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
            style={{ animationDelay: `${i * 200}ms` }}
          />
        ))}
      </span>
      <span>
        <span className="font-medium">{name}</span> {status.status}
        {status.loadingMessages && ` · ${status.loadingMessages[turn % status.loadingMessages.length]}`}
      </span>
    </p>
  )
}

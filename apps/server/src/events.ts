import { all } from "./db/query"
import type { ConversationRow } from "./db/rows"
import type { PublishInput } from "./hub"
import type { Ctx } from "./api/context"

/** Sends an event to the workspace's live connections, after the response. */
export function publish(ctx: Pick<Ctx, "env" | "waitUntil">, input: PublishInput): void {
  const stub = ctx.env.HUB.get(ctx.env.HUB.idFromName(input.teamId))
  ctx.waitUntil(
    stub.publish(input).catch((error: unknown) => {
      console.error("publish failed", input.event.type, error)
    }),
  )
}

/** Everyone who sees a conversation's events: its members. */
export async function audienceOf(ctx: Pick<Ctx, "env">, conversationId: string): Promise<string[]> {
  const rows = await all<{ user_id: string }>(
    ctx.env.DB,
    "SELECT user_id FROM members WHERE conversation_id = ?",
    conversationId,
  )
  return rows.map((r) => r.user_id)
}

export function channelType(c: Pick<ConversationRow, "kind" | "is_private">): string {
  if (c.kind === "im") return "im"
  if (c.kind === "mpim") return "mpim"
  return c.is_private ? "group" : "channel"
}

import { all } from "./db/query"
import type { ConversationRow, UserRow } from "./db/rows"
import type { PublishInput } from "./hub"
import type { Actor, Ctx } from "./api/context"
import { userJson } from "./api/shapes"

/** Sends an event to the workspace's live connections, after the response. */
export function publish(ctx: Pick<Ctx, "env" | "waitUntil">, input: PublishInput): void {
  const stub = ctx.env.HUB.get(ctx.env.HUB.idFromName(input.teamId))
  ctx.waitUntil(
    stub.publish(input).catch((error: unknown) => {
      console.error("publish failed", input.event.type, error)
    }),
  )
}

/** Everyone in the workspace learns of a change to a person (role, profile, photo), as Slack's user_change. */
export function userChanged(ctx: Pick<Ctx<Actor>, "env" | "waitUntil" | "origin" | "auth">, user: UserRow): void {
  publish(ctx, {
    teamId: ctx.auth.team.id,
    event: { type: "user_change", user: userJson(user, ctx.origin) },
    audience: "team",
  })
}

/** audienceOf() as a statement, to read the audience in the same batch as a change. */
export const audienceStatement = (db: D1Database, conversationId: string) =>
  db.prepare("SELECT user_id FROM members WHERE conversation_id = ?").bind(conversationId)

/** The user ids from an audienceStatement's result. */
export const audienceFrom = (result: D1Result) => (result.results as { user_id: string }[]).map((r) => r.user_id)

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

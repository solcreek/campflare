import type { Actor } from "../api/context"
import { nowSeconds } from "../api/ids"
import { run } from "../db/query"
import type { TeamRow } from "../db/rows"
import type { Env } from "../env"
import { builtInBot, type BuiltIn } from "../system-bot"

export const SCRIBE_NAME = "Huddle Scribe"

/** The bot that posts transcripts: built in, found by its mark (system-bot.ts), never by name. */
export const SCRIBE: BuiltIn = { key: "huddle-scribe", name: SCRIBE_NAME, handle: "huddle-scribe" }

/** The Huddle Scribe as an actor, made on first use. */
export const scribeActor = (env: Env, team: TeamRow): Promise<Actor> => builtInBot(env, team, SCRIBE)

/** Puts the bot in a conversation it must post to (private channels and DMs included). */
export async function seatScribe(env: Env, conversationId: string, botUserId: string) {
  await run(
    env.DB,
    "INSERT OR IGNORE INTO members (conversation_id, user_id, joined) VALUES (?, ?, ?)",
    conversationId,
    botUserId,
    nowSeconds(),
  )
}

import type { ConversationRow } from "../db/rows"
import type { Auth } from "./context"
import { CampflareError } from "./errors"

// What each method needs of a token (docs/scopes-and-roles.md). Every method
// registered with method() has an entry: a test checks, so none ships unguarded.

/** What a conversation method does to the conversation it names. */
export type Verb = "read" | "history" | "write"

/** No scope; any one of these; every one of these; or the verb's scope for the conversation's type. */
export type Need = string[] | { all: string[] } | { conversation: Verb }

const CONVERSATION_PREFIXES = ["channels", "groups", "im", "mpim"] as const

/** Scopes that also count for a verb on public channels, as Slack's newer granular scopes do. */
const ALSO: Record<string, string[]> = { "channels:write": ["channels:manage"] }

/** The scopes accepted for a verb on a conversation of this type. */
export function conversationScopes(c: Pick<ConversationRow, "kind" | "is_private">, verb: Verb): string[] {
  const prefix = c.kind === "im" ? "im" : c.kind === "mpim" ? "mpim" : c.is_private ? "groups" : "channels"
  const scope = `${prefix}:${verb}`
  return [scope, ...(ALSO[scope] ?? [])]
}

const conversation = (verb: Verb): Need => ({ conversation: verb })

const HISTORY = ["channels:history", "groups:history", "im:history", "mpim:history"]

export const NEEDS: Record<string, Need> = {
  "api.test": [],
  "auth.test": [],
  "auth.revoke": [],
  "oauth.v2.access": [],
  "chat.getPermalink": [],
  "views.open": [],
  "views.push": [],
  "views.update": [],
  "campflare.bootstrap": [],
  "campflare.methods.list": [],

  "conversations.info": conversation("read"),
  "conversations.list": conversation("read"),
  "conversations.members": conversation("read"),
  "users.conversations": conversation("read"),
  "conversations.history": conversation("history"),
  "conversations.replies": conversation("history"),
  "conversations.create": conversation("write"),
  "conversations.archive": conversation("write"),
  "conversations.unarchive": conversation("write"),
  "conversations.rename": conversation("write"),
  "conversations.setTopic": conversation("write"),
  "conversations.setPurpose": conversation("write"),
  "conversations.invite": conversation("write"),
  "conversations.kick": conversation("write"),
  "conversations.leave": conversation("write"),
  "conversations.mark": conversation("write"),
  "conversations.open": conversation("write"),
  "conversations.close": conversation("write"),
  "conversations.join": ["channels:join", "channels:write", "channels:manage"],

  "chat.postMessage": ["chat:write"],
  "chat.update": ["chat:write"],
  "chat.delete": ["chat:write"],
  "chat.meMessage": ["chat:write"],
  "chat.postEphemeral": ["chat:write"],
  "chat.startStream": ["chat:write"],
  "chat.appendStream": ["chat:write"],
  "chat.stopStream": ["chat:write"],
  "campflare.chat.stopStream": ["chat:write"],
  "campflare.blocks.action": ["chat:write"],
  "assistant.threads.setStatus": ["assistant:write", "chat:write"],

  "reactions.add": ["reactions:write"],
  "reactions.remove": ["reactions:write"],
  "reactions.get": ["reactions:read"],

  "files.getUploadURLExternal": ["files:write"],
  "files.completeUploadExternal": ["files:write"],
  "files.delete": ["files:write"],
  "files.info": ["files:read"],
  "files.list": ["files:read"],

  "search.messages": ["search:read"],

  "users.info": ["users:read"],
  "users.list": ["users:read"],
  "users.getPresence": ["users:read"],
  "bots.info": ["users:read"],
  "users.lookupByEmail": ["users:read.email"],
  "users.setPresence": ["users:write"],
  "users.profile.get": ["users.profile:read"],
  "users.profile.set": ["users.profile:write"],
  "users.setPhoto": ["users.profile:write"],
  "users.deletePhoto": ["users.profile:write"],

  "usergroups.list": ["usergroups:read"],
  "usergroups.users.list": ["usergroups:read"],
  "usergroups.create": ["usergroups:write"],
  "usergroups.update": ["usergroups:write"],
  "usergroups.disable": ["usergroups:write"],
  "usergroups.enable": ["usergroups:write"],
  "usergroups.users.update": ["usergroups:write"],

  "team.info": ["team:read"],
  "emoji.list": ["emoji:read"],

  "dnd.info": ["dnd:read"],
  "dnd.teamInfo": ["dnd:read"],
  "dnd.setSnooze": ["dnd:write"],
  "dnd.endSnooze": ["dnd:write"],
  "dnd.endDnd": ["dnd:write"],

  "apps.connections.open": ["connections:write"],
  // The live feeds carry every message the person sees, so they want every type's :history too.
  "rtm.connect": { all: ["rtm:stream", ...HISTORY] },
  "campflare.events.poll": { all: ["events:read", ...HISTORY] },

  "campflare.huddles.ice_servers": ["calls:read"],
  "campflare.huddles.info": ["calls:read"],
  "campflare.huddles.join": ["calls:write"],
  "campflare.huddles.publish": ["calls:write"],
  "campflare.huddles.unpublish": ["calls:write"],
  "campflare.huddles.subscribe": ["calls:write"],
  "campflare.huddles.layer": ["calls:write"],
  "campflare.huddles.answer": ["calls:write"],
  "campflare.huddles.leave": ["calls:write"],
  "campflare.huddles.transcribe": ["calls:write"],

  "campflare.views.list": ["views:read"],
  "campflare.views.submit": ["views:write"],
  "campflare.views.close": ["views:write"],

  "apps.list": ["apps:read"],
  "campflare.apps.create": ["apps:write"],
  "campflare.apps.info": ["apps:write"],
  "campflare.apps.setEventSubscriptions": ["apps:write"],
  "campflare.apps.setInteractivity": ["apps:write"],
  "campflare.apps.rotateSigningSecret": ["apps:write"],

  "campflare.tokens.list": ["tokens:read"],
  "campflare.tokens.create": ["tokens:write"],
  "campflare.tokens.revoke": ["tokens:write"],
  "campflare.users.setPassword": ["users.password:write"],
  "campflare.users.create": ["admin.users:write"],
  "campflare.users.deactivate": ["admin.users:write"],
  "campflare.users.setRole": ["admin.users:write"],
}

/** The scopes a method accepts, any one of which will do, for x-accepted-oauth-scopes and missing_scope. */
export function acceptedScopes(need: Need): string[] {
  if (Array.isArray(need)) return need
  if ("all" in need) return need.all
  return CONVERSATION_PREFIXES.flatMap((p) => conversationScopes(kindOf(p), need.conversation))
}

function kindOf(prefix: (typeof CONVERSATION_PREFIXES)[number]): Pick<ConversationRow, "kind" | "is_private"> {
  if (prefix === "im" || prefix === "mpim") return { kind: prefix, is_private: 1 }
  return { kind: "channel", is_private: prefix === "groups" ? 1 : 0 }
}

/** missing_scope, as Slack answers it: what would do, and what the token has. */
export function missingScope(auth: Pick<Auth, "scopes">, accepted: string[]): CampflareError {
  return new CampflareError("missing_scope", { needed: accepted.join(","), provided: auth.scopes.join(",") })
}

export function requireScope(auth: Pick<Auth, "scopes">, accepted: string[]): void {
  if (accepted.length && !accepted.some((s) => auth.scopes.includes(s))) throw missingScope(auth, accepted)
}

/** The up-front check: the token holds a scope the method accepts (for some conversation type, for those). */
export function checkMethodScopes(auth: Pick<Auth, "scopes">, need: Need): void {
  if (!Array.isArray(need) && "all" in need) {
    const missing = need.all.filter((s) => !auth.scopes.includes(s))
    if (missing.length) throw missingScope(auth, missing)
    return
  }
  requireScope(auth, acceptedScopes(need))
}

/** The per-type check, once the conversation is known. */
export function requireConversationScope(
  auth: Pick<Auth, "scopes">,
  c: Pick<ConversationRow, "kind" | "is_private">,
  verb: Verb,
): void {
  requireScope(auth, conversationScopes(c, verb))
}

// The scopes a token can hold.

const CONVERSATION_SCOPES = CONVERSATION_PREFIXES.flatMap((p) => [`${p}:read`, `${p}:history`, `${p}:write`])

const READ = [
  ...CONVERSATION_SCOPES.filter((s) => !s.endsWith(":write")),
  "search:read",
  "files:read",
  "reactions:read",
  "emoji:read",
  "dnd:read",
  "team:read",
  "users:read",
  "users.profile:read",
  "usergroups:read",
  "rtm:stream",
  "events:read",
  "views:read",
  "calls:read",
]

const WRITE = [
  ...READ,
  ...CONVERSATION_SCOPES.filter((s) => s.endsWith(":write")),
  "chat:write",
  "reactions:write",
  "files:write",
  "views:write",
]

/** Every scope a user token can hold: what a person's own sign-in gets. */
export const FULL_USER_SCOPES = [
  ...WRITE,
  "channels:manage",
  "calls:write",
  "dnd:write",
  "users:read.email",
  "users:write",
  "users.profile:write",
  "usergroups:write",
  "apps:read",
  "apps:write",
  "tokens:read",
  "tokens:write",
  "users.password:write",
  "admin.users:write",
]

export const DEFAULT_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "assistant:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "team:read",
  "users:read",
  "users.profile:read",
  "usergroups:read",
  "rtm:stream",
  "events:read",
]

export const APP_SCOPES = ["connections:write"]

/**
 * Named sets of user scopes. A token may store a name in place of a list
 * (migration 0018): it is expanded when the token is used, so the token gains
 * what later features add to the set.
 */
export const PRESETS: Record<string, string[]> = { read: READ, write: WRITE, full: FULL_USER_SCOPES }

/** The stored names a token's scopes may use: the presets, and `bot` for an app's bot token. */
const STORED: Record<string, string[]> = { ...PRESETS, bot: DEFAULT_BOT_SCOPES }

/** A token's stored scopes (comma-separated scopes and preset names) as the scopes they grant. */
export function expandScopes(stored: string): string[] {
  const out = new Set<string>()
  for (const s of stored.split(",")) {
    if (!s) continue
    for (const scope of STORED[s] ?? [s]) out.add(scope)
  }
  return [...out]
}

/** The scopes and presets a person may grant (OAuth consent, tokens.create). */
export const GRANTABLE_USER_SCOPES = new Set([...FULL_USER_SCOPES, ...Object.keys(PRESETS)])

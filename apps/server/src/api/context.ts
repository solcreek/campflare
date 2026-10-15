import type { AppRow, TeamRow, UserRow } from "../db/rows"
import type { Env } from "../env"
import type { Args } from "./args"
import { CampflareError } from "./errors"
import { checkMethodScopes, NEEDS, type Verb } from "./scopes"

export type TokenKind = "user" | "bot" | "app"

export interface Auth {
  kind: TokenKind
  team: TeamRow
  /** The acting user: the person for a user token, the bot user for a bot token. Absent for app tokens. */
  user?: UserRow
  app?: AppRow
  scopes: string[]
}

/** The acting identity of a user or bot token. */
export interface Actor extends Auth {
  user: UserRow
}

export interface Ctx<A extends Auth | undefined = Auth> {
  env: Env
  args: Args
  auth: A
  request: Request
  /** "https://campflare.example.com", for URLs handed back to clients. */
  origin: string
  waitUntil(promise: Promise<unknown>): void
  /**
   * What the method does to the conversation it names, for a conversation method
   * (scopes.ts): the conversation's fetch checks the token's scope for its type.
   */
  verb?: Verb
}

/** user: xoxp only; bot: xoxb only; actor: either; app: xapp only; none: no token. */
export type Access = "user" | "bot" | "actor" | "app" | "none"

export type Result = Record<string, unknown>

export type Handler<A extends Auth | undefined> = (ctx: Ctx<A>) => Promise<Result>

export interface MethodDef {
  access: Access
  handler: Handler<Auth | undefined>
}

export const methods = new Map<string, MethodDef>()

export function method(name: string, access: "none", handler: Handler<undefined>): void
export function method(name: string, access: "app", handler: Handler<Auth>): void
export function method(name: string, access: "user" | "bot" | "actor", handler: Handler<Actor>): void
export function method(name: string, access: Access, handler: Handler<never>): void {
  methods.set(name, { access, handler: handler as Handler<Auth | undefined> })
}

/**
 * Whether this token may call the method: its type, then its scopes
 * (scopes.ts). /api/:method and MCP tools both ask here.
 */
export function authorize(name: string, def: MethodDef, auth: Auth): Verb | undefined {
  const allowed = def.access === "actor" ? auth.kind === "user" || auth.kind === "bot" : auth.kind === def.access
  if (!allowed) throw new CampflareError("not_allowed_token_type")
  const need = NEEDS[name] ?? []
  checkMethodScopes(auth, need)
  return Array.isArray(need) ? undefined : need.conversation
}

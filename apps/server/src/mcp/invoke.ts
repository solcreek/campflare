import { Args } from "../api/args"
import { authorize, methods, type Actor, type Ctx, type Result } from "../api/context"
import type { Env } from "../env"

/** What a tool needs to act as the caller: their identity and the request around it. */
export interface Caller {
  env: Env
  auth: Actor
  origin: string
  request: Request
  waitUntil(promise: Promise<unknown>): void
}

/**
 * Runs a Web API method as the caller. Tools go through the same handlers as
 * /api/<method>, so permissions, events and error codes stay identical.
 */
export async function invoke<T extends Result = Result>(
  caller: Caller,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const def = methods.get(name)
  if (!def) throw new Error(`no method ${name}`)
  const verb = authorize(name, def, caller.auth)
  const ctx: Ctx<Actor> = {
    env: caller.env,
    args: new Args(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))),
    auth: caller.auth,
    request: caller.request,
    origin: caller.origin,
    waitUntil: caller.waitUntil,
    verb,
  }
  return (await def.handler(ctx as Ctx<Actor | undefined>)) as T
}

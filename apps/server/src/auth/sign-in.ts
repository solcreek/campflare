import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthEndpoint } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import * as z from "zod"
import { FULL_USER_SCOPES } from "../api/scopes"
import { authenticate } from "../api/auth"
import { CampflareError } from "../api/errors"
import { first } from "../db/query"
import type { UserRow } from "../db/rows"
import type { Env } from "../env"
import { nowSeconds } from "../api/ids"
import { checkCredentials } from "./password"
import { addressChecks, clientAddress, countFailure, IP_FREE_FAILURES, keys, waitFor } from "./throttle"

export const CAMPFLARE_PROVIDER = "campflare"

type EndpointContext = Parameters<typeof setSessionCookie>[0]

/** 429 with Retry-After: this address has tried too often (src/auth/throttle.ts). */
const tooManyAttempts = (seconds: number) =>
  new APIError("TOO_MANY_REQUESTS", { message: "too_many_attempts" }, { "retry-after": String(seconds) })

/**
 * Starts a Better Auth session for a Campflare user. The Better Auth user is
 * created on first sign-in and linked as an account (providerId "campflare",
 * accountId = the Campflare user id), so every way of signing in leads to the
 * same session and the access tokens issued afterwards map to exactly that
 * user in that workspace.
 */
async function signInAs(ctx: EndpointContext, person: Pick<UserRow, "id" | "name" | "real_name">, method: string) {
  const key = { providerId: CAMPFLARE_PROVIDER, accountId: person.id }
  const linked = await ctx.context.internalAdapter.findAccountByKey(key)
  let user = linked ? await ctx.context.internalAdapter.findUserById(linked.userId) : null
  if (!user) {
    // Campflare emails are unique per workspace, not globally: a synthetic address keeps one account per person.
    user = await ctx.context.internalAdapter.createUser(
      {
        email: `${person.id.toLowerCase()}@users.campflare.invalid`,
        name: person.real_name || person.name,
        emailVerified: true,
      },
      { method },
    )
    await ctx.context.internalAdapter.linkAccount({ ...key, userId: user.id })
  }
  const session = await ctx.context.internalAdapter.createSession(user.id)
  await setSessionCookie(ctx, { session, user })
  return { id: user.id, name: user.name }
}

/**
 * How a person proves who they are during an OAuth authorization (/login):
 * an email address and the password they set (campflare.users.setPassword),
 * or a Campflare user token (xoxp-).
 */
export function campflareSignIn(env: Env) {
  return {
    id: "campflare-sign-in",
    endpoints: {
      signInCampflareToken: createAuthEndpoint(
        "/sign-in/campflare-token",
        {
          method: "POST",
          body: z.object({ token: z.string().min(1), oauth_query: z.string().optional() }),
        },
        async (ctx) => {
          // A token can't be guessed, but each try still counts against the address.
          const ip = clientAddress(ctx.headers)
          const now = nowSeconds()
          const wait = waitFor(await env.DB.batch(addressChecks(env.DB, ip, now)), now)
          if (wait !== undefined) throw tooManyAttempts(wait)
          const refuse = async (message: string) => {
            await countFailure(env.DB, keys.ip(ip), now, IP_FREE_FAILURES).run()
            return new APIError("UNAUTHORIZED", { message })
          }
          let actor
          try {
            actor = await authenticate(env, ctx.body.token.trim())
          } catch (error) {
            if (error instanceof CampflareError) throw await refuse(error.code)
            throw error
          }
          if (actor.kind !== "user" || !actor.user) throw await refuse("a user token (xoxp-) is needed")
          // A session signs in OAuth clients, which may ask for every scope: only a token that is
          // the whole person may start one, or a narrow or expiring token could be traded for more.
          if (actor.expires !== undefined || !FULL_USER_SCOPES.every((s) => actor.scopes.includes(s))) {
            throw await refuse("this token can't sign in: it is limited (scopes or expiry); use your own sign-in token")
          }
          const user = await signInAs(ctx, actor.user, "campflare-token")
          return ctx.json({ user, campflare_user: actor.user.id, team: actor.team.id })
        },
      ),
      /**
       * Signs in a person who has just proven themselves another way (an
       * invitation accepted at /join, src/invites.ts). Server-only: never on
       * the HTTP router, so it is reached through auth.api alone.
       */
      signInCampflareUser: createAuthEndpoint.serverOnly(
        { method: "POST", body: z.object({ user_id: z.string().min(1) }) },
        async (ctx) => {
          const person = await first<UserRow>(
            env.DB,
            "SELECT * FROM users WHERE id = ? AND deleted = 0 AND is_bot = 0",
            ctx.body.user_id,
          )
          if (!person) throw new APIError("UNAUTHORIZED", { message: "account_inactive" })
          const user = await signInAs(ctx, person, "campflare-invite")
          return ctx.json({ user, campflare_user: person.id, team: person.team_id })
        },
      ),
      signInCampflarePassword: createAuthEndpoint(
        "/sign-in/campflare-password",
        {
          method: "POST",
          body: z.object({
            email: z.string().min(1).max(320),
            password: z.string().min(1).max(4096),
            workspace: z.string().max(200).optional(),
            oauth_query: z.string().optional(),
          }),
        },
        async (ctx) => {
          const found = await checkCredentials(
            env,
            ctx.body.email,
            ctx.body.password,
            clientAddress(ctx.headers),
            ctx.body.workspace || undefined,
          )
          if (!found.ok) {
            if (found.error === "too_many_attempts") throw tooManyAttempts(found.retryAfter)
            throw new APIError(found.error === "workspace_required" ? "BAD_REQUEST" : "UNAUTHORIZED", {
              message: found.error,
            })
          }
          const person = (await first<UserRow>(env.DB, "SELECT * FROM users WHERE id = ?", found.userId))!
          const user = await signInAs(ctx, person, "campflare-password")
          return ctx.json({ user, campflare_user: person.id, team: person.team_id })
        },
      ),
    },
  } satisfies BetterAuthPlugin
}

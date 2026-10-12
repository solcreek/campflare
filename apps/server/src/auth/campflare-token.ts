import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthEndpoint } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import * as z from "zod"
import { authenticate } from "../api/auth"
import { CampflareError } from "../api/errors"
import type { Env } from "../env"

export const CAMPFLARE_PROVIDER = "campflare"

/**
 * Sign in with a Campflare user token (xoxp-). Until there's a UI with
 * passwords or passkeys, this is how a person proves who they are during an
 * OAuth authorization: the token names one user in one workspace, so the
 * access token issued afterwards maps to exactly that user. The Better Auth
 * user is created on first sign-in and linked as an account
 * (providerId "campflare", accountId = the Campflare user id).
 */
export function campflareTokenSignIn(env: Env) {
  return {
    id: "campflare-token",
    endpoints: {
      signInCampflareToken: createAuthEndpoint(
        "/sign-in/campflare-token",
        {
          method: "POST",
          body: z.object({ token: z.string().min(1), oauth_query: z.string().optional() }),
        },
        async (ctx) => {
          let actor
          try {
            actor = await authenticate(env, ctx.body.token.trim())
          } catch (error) {
            if (error instanceof CampflareError) throw new APIError("UNAUTHORIZED", { message: error.code })
            throw error
          }
          if (actor.kind !== "user" || !actor.user) {
            throw new APIError("UNAUTHORIZED", { message: "a user token (xoxp-) is needed" })
          }
          const person = actor.user
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
              { method: "campflare-token" },
            )
            await ctx.context.internalAdapter.linkAccount({ ...key, userId: user.id })
          }
          const session = await ctx.context.internalAdapter.createSession(user.id)
          await setSessionCookie(ctx, { session, user })
          return ctx.json({ user: { id: user.id, name: user.name }, campflare_user: person.id, team: actor.team.id })
        },
      ),
    },
  } satisfies BetterAuthPlugin
}

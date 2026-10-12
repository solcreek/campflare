import type { Io } from "./io"
import { UsageError } from "./io"

// Profiles in ~/.config/campflare/config.json, one per server and identity:
// { "current": "work", "profiles": { "work": { "url": …, "token": …, "appToken": …, "via": "oauth" } } }
// CAMPFLARE_URL / CAMPFLARE_TOKEN / CAMPFLARE_APP_TOKEN override the profile.

export interface Profile {
  url: string
  token?: string
  appToken?: string
  /**
   * How `token` was obtained: "oauth" from `login --oauth`, so the CLI revokes
   * it when it forgets it (logout, or a login over it); "token" (or absent, in
   * older configs) given by hand, perhaps shared with scripts, so never revoked.
   */
  via?: "oauth" | "token"
}

export interface Config {
  current?: string
  profiles: Record<string, Profile>
}

export async function loadConfig(io: Io): Promise<Config> {
  const text = await io.readConfig()
  if (!text) return { profiles: {} }
  try {
    const parsed = JSON.parse(text) as Partial<Config>
    return { current: parsed.current, profiles: parsed.profiles ?? {} }
  } catch {
    throw new UsageError(`${io.configPath} is not valid JSON`)
  }
}

export async function saveConfig(io: Io, config: Config): Promise<void> {
  await io.writeConfig(`${JSON.stringify(config, null, 2)}\n`)
}

/** The profile in effect: --profile, else the current one, with the environment on top. */
export async function activeProfile(io: Io, name?: string): Promise<Profile> {
  const config = await loadConfig(io)
  const chosen = name ?? io.env.CAMPFLARE_PROFILE ?? config.current
  const profile = chosen ? config.profiles[chosen] : undefined
  if (name && !profile) throw new UsageError(`no profile named ${name}`)
  const url = io.env.CAMPFLARE_URL ?? profile?.url
  if (!url) throw new UsageError("not logged in: run `campflare login --url <server> --token <token>`")
  return {
    url,
    token: io.env.CAMPFLARE_TOKEN ?? profile?.token,
    appToken: io.env.CAMPFLARE_APP_TOKEN ?? profile?.appToken,
  }
}

// What e2e/run.ts hands every test file: the seeded server (CAMPFLARE_E2E_STACK),
// and a way to wait for something outside the window.

export interface Stack {
  apiUrl: string
  /** A seeded person's user token. */
  token: string
  /** #general's id. */
  general: string
}

export const stack = JSON.parse(process.env.CAMPFLARE_E2E_STACK ?? "null") as Stack | null

/** Waits until `check` holds, polling, for up to `ms`. */
export async function until(what: string, check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; !(await check());) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

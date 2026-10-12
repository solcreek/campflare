import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"

// A Cloudflare quick tunnel (cloudflared, no account) to a local server, for
// live tests where Cloudflare must reach us: the SFU's WebSocket adapter dials
// out to a public endpoint.

export const CLOUDFLARED = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find(existsSync)

/** Opens a quick tunnel; one whose name never comes up (it happens) is replaced by a fresh one. */
export async function openTunnel(target: string, attempts = 3): Promise<{ url: string; close: () => void }> {
  for (let i = 1; ; i++) {
    try {
      return await openOnce(target)
    } catch (error) {
      if (i >= attempts) throw error
      console.warn(
        `quick tunnel attempt ${i} failed, trying another: ${error instanceof Error ? error.message : error}`,
      )
    }
  }
}

async function openOnce(target: string): Promise<{ url: string; close: () => void }> {
  if (!CLOUDFLARED) throw new Error("cloudflared isn't installed")
  const child: ChildProcess = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", target], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const url = await new Promise<string>((resolve, reject) => {
    let log = ""
    const timer = setTimeout(() => reject(new Error(`no tunnel URL from cloudflared:\n${log}`)), 30_000)
    const read = (chunk: Buffer) => {
      log += chunk
      const found = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (found) {
        clearTimeout(timer)
        resolve(found[0])
      }
    }
    child.stdout?.on("data", read)
    child.stderr?.on("data", read)
    child.on("exit", (code) => reject(new Error(`cloudflared exited (${code}):\n${log}`)))
  })
  // The name exists a few seconds after cloudflared prints it. Asking the system
  // resolver too early caches "no such name" (and Chrome shares that cache), so
  // wait for it over DNS-over-HTTPS first, then check it serves.
  const host = new URL(url).hostname
  const ready = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
          headers: { accept: "application/dns-json" },
        })
        if (((await res.json()) as { Answer?: unknown[] }).Answer?.length) return
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    child.kill("SIGTERM")
    throw new Error(`${host} never resolved`)
  }
  await ready()
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(5000) })).ok) break
    } catch (error) {
      if (i >= 20) {
        child.kill("SIGTERM")
        throw new Error(`tunnel ${url} never served`, { cause: error })
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return { url, close: () => child.kill("SIGTERM") }
}

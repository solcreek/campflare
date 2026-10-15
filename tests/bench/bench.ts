import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { arch, cpus, platform, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { buildSeed, SIZES, type Dataset } from "./seed.ts"

// End-to-end benchmark of the Worker under `wrangler dev`: per-method latency,
// throughput and D1 queries per request, against a seeded workspace.
//
//   pnpm bench                        standard dataset, local D1
//   pnpm bench --d1-delay 5           + 5 ms per D1 query, as a remote database would add
//   pnpm bench --quick                small dataset, fewer iterations
//   pnpm bench --only search          scenarios whose name contains "search"
//   pnpm bench --compare results/x.json

const { values: opts } = parseArgs({
  options: {
    quick: { type: "boolean", default: false },
    "d1-delay": { type: "string", default: "0" },
    iterations: { type: "string" },
    concurrency: { type: "string", default: "16" },
    duration: { type: "string" },
    only: { type: "string" },
    out: { type: "string" },
    compare: { type: "string" },
  },
})

const here = import.meta.dirname
const wrangler = join(here, "node_modules/.bin/wrangler")
const size = SIZES[opts.quick ? "quick" : "standard"]
const iterations = Number(opts.iterations ?? (opts.quick ? 50 : 200))
const concurrency = Number(opts.concurrency)
const durationMs = Number(opts.duration ?? (opts.quick ? 1000 : 3000))
const d1Delay = Number(opts["d1-delay"])

// ── server ──────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
}

/** wrangler dev's output, shown when a request fails. */
let log = ""

async function startServer(state: string): Promise<{ base: string; child: ChildProcess }> {
  const port = await freePort()
  const child = spawn(
    wrangler,
    [
      "dev",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--var",
      "SIGNING_KEY:bench",
      "--var",
      `BENCH_D1_DELAY_MS:${d1Delay}`,
    ],
    { cwd: here, stdio: ["ignore", "pipe", "pipe"] },
  )
  child.stdout?.on("data", (d) => (log += d))
  child.stderr?.on("data", (d) => (log += d))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base)).ok) break
    } catch {
      // not up yet
    }
    if (i > 240) throw new Error(`wrangler dev did not start:\n${log}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  return { base, child }
}

// ── measuring ───────────────────────────────────────────────────────────────

interface Call {
  method: string
  args?: Record<string, string>
  token?: string
}

interface Sample {
  ms: number
  queries: number
  rounds: number
  rowsRead: number
  bytes: number
}

let base = ""

async function call({ method, args = {}, token }: Call): Promise<Sample> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  const start = performance.now()
  const res = await fetch(`${base}/api/${method}`, { method: "POST", headers, body: new URLSearchParams(args) })
  const text = await res.text()
  const ms = performance.now() - start
  const body = JSON.parse(text) as { ok: boolean; error?: string }
  if (!body.ok) throw new Error(`${method} ${JSON.stringify(args)}: ${body.error}`)
  return {
    ms,
    queries: Number(res.headers.get("x-bench-d1-queries")),
    rounds: Number(res.headers.get("x-bench-d1-rounds")),
    rowsRead: Number(res.headers.get("x-bench-d1-rows-read")),
    bytes: text.length,
  }
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits

function summarise(xs: number[]) {
  const sorted = xs.toSorted((a, b) => a - b)
  return {
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    p99: round(quantile(sorted, 0.99)),
    mean: round(mean(sorted)),
  }
}

interface Result {
  p50: number
  p95: number
  p99: number
  mean: number
  rps?: number
  queries?: number
  rounds?: number
  rowsRead?: number
  bytes?: number
}

/** Latency one request at a time, then throughput with `concurrency` in flight. */
async function measure(make: (i: number) => Call, { throughput = true } = {}): Promise<Result> {
  let i = 0
  for (const end = i + Math.min(20, iterations); i < end; i++) await call(make(i))
  const samples: Sample[] = []
  for (const end = i + iterations; i < end; i++) samples.push(await call(make(i)))
  const result: Result = {
    ...summarise(samples.map((s) => s.ms)),
    queries: round(mean(samples.map((s) => s.queries)), 1),
    rounds: round(mean(samples.map((s) => s.rounds)), 1),
    rowsRead: Math.round(mean(samples.map((s) => s.rowsRead))),
    bytes: Math.round(mean(samples.map((s) => s.bytes))),
  }
  if (throughput) {
    let done = 0
    const deadline = performance.now() + durationMs
    const start = performance.now()
    await Promise.all(
      // Each worker numbers its own requests, so a scenario's i-th and (i+1)-th stay in order.
      Array.from({ length: concurrency }, async (_, worker) => {
        for (let n = (worker + 1) * 1_000_000; performance.now() < deadline; n++) {
          await call(make(n))
          done++
        }
      }),
    )
    result.rps = Math.round(done / ((performance.now() - start) / 1000))
  }
  return result
}

// ── scenarios ───────────────────────────────────────────────────────────────

type Scenario = [name: string, make: (i: number) => Call, options?: { throughput?: boolean }]

function scenarios(d: Dataset): Scenario[] {
  const owner = d.owner.token
  const user = (i: number) => d.users[1 + (i % Math.min(199, d.users.length - 1))]!.token
  return [
    ["api.test (no auth)", () => ({ method: "api.test" })],
    ["auth.test", () => ({ method: "auth.test", token: owner })],
    ["users.info", (i) => ({ method: "users.info", token: owner, args: { user: d.users[i % d.users.length]!.id } })],
    ["users.list (all)", () => ({ method: "users.list", token: owner })],
    ["conversations.list", () => ({ method: "conversations.list", token: owner })],
    ["users.conversations", () => ({ method: "users.conversations", token: owner })],
    ["conversations.info #busy", () => ({ method: "conversations.info", token: owner, args: { channel: d.busy } })],
    [
      "conversations.history 100",
      () => ({ method: "conversations.history", token: owner, args: { channel: d.busy, limit: "100" } }),
    ],
    [
      "conversations.replies (long thread)",
      () => ({ method: "conversations.replies", token: owner, args: { channel: d.busy, ts: d.threadTs } }),
    ],
    ["search: one word", () => ({ method: "search.messages", token: owner, args: { query: "deploy" } })],
    [
      "search: words + in: + from:",
      () => ({ method: "search.messages", token: owner, args: { query: "deploy review in:#busy from:@user1" } }),
    ],
    ["search: short term (LIKE)", () => ({ method: "search.messages", token: owner, args: { query: "ok" } })],
    ["search: 2-char CJK (LIKE)", () => ({ method: "search.messages", token: owner, args: { query: "部署" } })],
    ["search: no accents (FTS)", () => ({ method: "search.messages", token: owner, args: { query: "reunion" } })],
    [
      "conversations.mark",
      () => ({ method: "conversations.mark", token: owner, args: { channel: d.busy, ts: d.reactTs } }),
    ],
    [
      "reactions.add/remove",
      (i) => ({
        method: i % 2 ? "reactions.remove" : "reactions.add",
        token: owner,
        args: { channel: d.busy, timestamp: d.reactTs, name: `bench_${Math.floor(i / 2)}` },
      }),
    ],
    [
      "chat.postMessage (user)",
      (i) => ({ method: "chat.postMessage", token: user(i), args: { channel: d.busy, text: `bench message ${i}` } }),
    ],
    [
      "chat.postMessage (bot)",
      (i) => ({ method: "chat.postMessage", token: d.bot.token, args: { channel: d.busy, text: `bot message ${i}` } }),
    ],
    [
      "chat.postMessage (thread reply)",
      (i) => ({
        method: "chat.postMessage",
        token: user(i),
        args: { channel: d.busy, thread_ts: d.threadTs, text: `reply ${i}` },
      }),
    ],
    [
      "chat.postMessage by #name",
      (i) => ({ method: "chat.postMessage", token: owner, args: { channel: "#busy", text: `by name ${i}` } }),
    ],
    [
      "chat.postMessage (mention)",
      (i) => ({
        method: "chat.postMessage",
        token: user(i),
        args: { channel: d.busy, text: `<@${d.owner.id}> look ${i}` },
      }),
    ],
    // The owner's inbox: the mentions above, a few hundred items.
    ["campflare.activity.list 50", () => ({ method: "campflare.activity.list", token: owner, args: { limit: "50" } })],
    [
      "campflare.activity.mark",
      (i) => ({ method: "campflare.activity.mark", token: owner, args: { up_to: String(i + 1) } }),
    ],
    [
      "chat.update",
      (i) => ({
        method: "chat.update",
        token: owner,
        args: { channel: d.scratch, ts: d.scratchTs[0]!, text: `edit ${i}` },
      }),
    ],
    [
      "chat.delete",
      (i) => {
        // Each request deletes another of the owner's seeded messages; there are only so many, so no throughput run.
        const ts = d.scratchTs[1 + i]
        if (!ts) throw new Error(`chat.delete: only ${d.scratchTs.length - 1} messages seeded to delete`)
        return { method: "chat.delete", token: owner, args: { channel: d.scratch, ts } }
      },
      { throughput: false },
    ],
  ]
}

/** chat.postMessage to #fanout while every member holds an RTM link: time until the first and the last one has it. */
async function fanout(d: Dataset): Promise<Record<string, Result>> {
  const listeners = d.users.slice(1, size.fanout + 1)
  const sockets: WebSocket[] = []
  const arrivals = new Map<string, number[]>()
  await Promise.all(
    listeners.map(async (u) => {
      const res = await fetch(`${base}/api/rtm.connect`, {
        method: "POST",
        headers: { authorization: `Bearer ${u.token}` },
      })
      const { url } = (await res.json()) as { url: string }
      const ws = new WebSocket(url)
      await new Promise<void>((ok, fail) => {
        ws.addEventListener("message", (e) => {
          const event = JSON.parse(String(e.data)) as { type: string; text?: string }
          if (event.type === "hello") ok()
          if (event.type === "message" && event.text) arrivals.get(event.text)?.push(performance.now())
        })
        ws.addEventListener("error", () => fail(new Error("websocket failed")))
      })
      sockets.push(ws)
    }),
  )
  const first: number[] = []
  const last: number[] = []
  const rounds = opts.quick ? 20 : 50
  for (let i = 0; i < rounds + 5; i++) {
    const text = `fanout ${i}`
    arrivals.set(text, [])
    const start = performance.now()
    await call({ method: "chat.postMessage", token: d.owner.token, args: { channel: d.fanout, text } })
    const deadline = performance.now() + 5000
    while (arrivals.get(text)!.length < listeners.length) {
      if (performance.now() > deadline)
        throw new Error(`fanout: ${arrivals.get(text)!.length}/${listeners.length} arrived`)
      await new Promise((r) => setTimeout(r, 0.5))
    }
    if (i < 5) continue // warm-up
    const times = arrivals.get(text)!.map((t) => t - start)
    first.push(Math.min(...times))
    last.push(Math.max(...times))
  }
  for (const ws of sockets) ws.close()
  return {
    [`fan-out to ${listeners.length} RTM: first`]: summarise(first),
    [`fan-out to ${listeners.length} RTM: last`]: summarise(last),
  }
}

// ── report ──────────────────────────────────────────────────────────────────

interface Report {
  meta: Record<string, unknown>
  results: Record<string, Result>
}

function delta(now: number | undefined, then: number | undefined) {
  if (now === undefined || then === undefined || then === 0) return ""
  const pct = ((now - then) / then) * 100
  return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`
}

function table(report: Report, baseline?: Report) {
  const rows = Object.entries(report.results).map(([name, r]) => {
    const b = baseline?.results[name]
    return [
      name,
      `${r.p50.toFixed(2)}${delta(r.p50, b?.p50)}`,
      r.p95.toFixed(2),
      r.p99.toFixed(2),
      r.rps === undefined ? "" : `${r.rps}${delta(r.rps, b?.rps)}`,
      r.queries === undefined
        ? ""
        : `${r.queries}${b?.queries !== undefined && b.queries !== r.queries ? ` (was ${b.queries})` : ""}`,
      r.rounds === undefined ? "" : String(r.rounds),
      r.rowsRead === undefined ? "" : `${r.rowsRead}${delta(r.rowsRead, b?.rowsRead)}`,
      r.bytes === undefined ? "" : String(r.bytes),
    ]
  })
  const header = ["scenario", "p50 ms", "p95 ms", "p99 ms", "req/s", "D1 queries", "D1 rounds", "rows read", "bytes"]
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)))
  const line = (cells: string[]) =>
    cells.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join("  ")
  console.log(line(header))
  console.log(widths.map((w) => "─".repeat(w)).join("  "))
  for (const r of rows) console.log(line(r))
}

// ── main ────────────────────────────────────────────────────────────────────

const state = mkdtempSync(join(tmpdir(), "campflare-bench-"))
let server: ChildProcess | undefined
try {
  const { sql, dataset } = buildSeed(size)
  console.log(`seeding: ${size.users} users, ${dataset.messages} messages ...`)
  execFileSync(wrangler, ["d1", "migrations", "apply", "campflare", "--local", "--persist-to", state], {
    cwd: here,
    stdio: "ignore",
  })
  writeFileSync(join(state, "seed.sql"), sql)
  execFileSync(
    wrangler,
    ["d1", "execute", "campflare", "--local", "--persist-to", state, "--file", join(state, "seed.sql")],
    {
      cwd: here,
      stdio: "ignore",
    },
  )
  const started = await startServer(state)
  server = started.child
  base = started.base
  console.log(
    `bench: ${iterations} sequential requests per scenario, then ${concurrency} concurrent for ${durationMs} ms; D1 delay ${d1Delay} ms\n`,
  )

  const results: Record<string, Result> = {}
  for (const [name, make, options] of scenarios(dataset)) {
    if (opts.only && !name.includes(opts.only)) continue
    results[name] = await measure(make, options)
    process.stderr.write(`  ${name}: p50 ${results[name].p50} ms\n`)
  }
  if (!opts.only || "fan-out".includes(opts.only)) Object.assign(results, await fanout(dataset))

  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim()
  const report: Report = {
    meta: {
      date: new Date().toISOString(),
      // Hardware, not the machine's name: results are committed to a public repo.
      machine: `${cpus()[0]?.model ?? "unknown"}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()}-${arch()}`,
      commit,
      node: process.version,
      dataset: opts.quick ? "quick" : "standard",
      size,
      messages: dataset.messages,
      d1DelayMs: d1Delay,
      iterations,
      concurrency,
      durationMs,
    },
    results,
  }
  console.log()
  table(report, opts.compare ? (JSON.parse(readFileSync(opts.compare, "utf8")) as Report) : undefined)
  const out = opts.out ?? join(here, "results", `${commit}-${report.meta.dataset}-d1-${d1Delay}ms.json`)
  mkdirSync(join(out, ".."), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\nwrote ${out}`)
} catch (error) {
  await new Promise((r) => setTimeout(r, 500)) // let wrangler flush the request's log
  console.error(`\nwrangler dev output (tail):\n${log.slice(-4000)}`)
  throw error
} finally {
  server?.kill("SIGTERM")
  rmSync(state, { recursive: true, force: true })
}

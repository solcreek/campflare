import app from "../../apps/server/src/index"
import type { Env } from "../../apps/server/src/env"

export { TeamHub } from "../../apps/server/src/index"

// apps/server's Worker with its D1 binding wrapped, so each response says how
// many queries it made (x-bench-d1-queries) and in how many sequential round
// trips (x-bench-d1-rounds: queries issued while others were in flight share
// one). BENCH_D1_DELAY_MS adds that much latency to every query, to model a
// Worker that is not next to its database, as local D1 always is.

interface Trace {
  delay: number
  queries: number
  rounds: number
  inflight: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function traced<T>(trace: Trace, query: () => Promise<T>): Promise<T> {
  trace.queries++
  if (trace.inflight++ === 0) trace.rounds++
  try {
    if (trace.delay > 0) await sleep(trace.delay)
    return await query()
  } finally {
    trace.inflight--
  }
}

class TracedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    private readonly trace: Trace,
  ) {}
  bind(...values: unknown[]) {
    return new TracedStatement(this.inner.bind(...values), this.trace)
  }
  first<T>(column?: string) {
    return traced(this.trace, () => (column ? this.inner.first<T>(column) : this.inner.first<T>()))
  }
  all<T>() {
    return traced(this.trace, () => this.inner.all<T>())
  }
  run<T>() {
    return traced(this.trace, () => this.inner.run<T>())
  }
  raw<T>() {
    return traced(this.trace, () => this.inner.raw<T>())
  }
}

function tracedDb(db: D1Database, trace: Trace): D1Database {
  return {
    prepare: (sql: string) => new TracedStatement(db.prepare(sql), trace),
    batch: (statements: TracedStatement[]) => traced(trace, () => db.batch(statements.map((s) => s.inner))),
    exec: (sql: string) => traced(trace, () => db.exec(sql)),
    dump: () => db.dump(),
    withSession: () => db.withSession(),
  } as unknown as D1Database
}

export default {
  async fetch(request: Request, env: Env & { BENCH_D1_DELAY_MS?: string }, ctx: ExecutionContext) {
    const trace: Trace = { delay: Number(env.BENCH_D1_DELAY_MS ?? 0), queries: 0, rounds: 0, inflight: 0 }
    const response = await app.fetch(request, { ...env, DB: tracedDb(env.DB, trace) }, ctx)
    if (response.status === 101) return response
    const out = new Response(response.body, response)
    out.headers.set("x-bench-d1-queries", String(trace.queries))
    out.headers.set("x-bench-d1-rounds", String(trace.rounds))
    return out
  },
} satisfies ExportedHandler<Env & { BENCH_D1_DELAY_MS?: string }>

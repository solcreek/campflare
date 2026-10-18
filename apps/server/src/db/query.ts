// Thin helpers over D1 prepared statements.

export async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | undefined> {
  return (
    (await db
      .prepare(sql)
      .bind(...params)
      .first<T>()) ?? undefined
  )
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...params)
      .all<T>()
  ).results
}

/**
 * One row of a join of whole tables, split back into one object per table:
 * `SELECT 1 AS "#hook", w.*, (a.id IS NOT NULL) AS "#app", a.* FROM … LEFT JOIN …`.
 * Each `"#name"` column starts the columns of `name`, up to the next marker;
 * a falsy marker (a LEFT JOIN that found nothing) makes it null. Tables share
 * column names (`id`), which a plain row object would merge, so it reads the
 * row raw, with its column names. One query, one round trip; undefined when
 * there's no row.
 */
export async function joinedRow<T extends Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<{ [K in keyof T]: T[K] | null } | undefined> {
  const [names, row] = (await db
    .prepare(sql)
    .bind(...params)
    .raw<unknown[]>({ columnNames: true })) as [string[], unknown[] | undefined]
  if (!row) return undefined
  const out: Record<string, Record<string, unknown> | null> = {}
  let current: Record<string, unknown> | null = null
  names.forEach((name, i) => {
    if (name.startsWith("#")) {
      current = row[i] ? {} : null
      out[name.slice(1)] = current
    } else if (current) current[name] = row[i]
  })
  return out as { [K in keyof T]: T[K] | null }
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db
    .prepare(sql)
    .bind(...params)
    .run()
}

export const stmt = (db: D1Database, sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params)

// Lists go in as one JSON argument, `IN (SELECT value FROM json_each(?))`: D1 binds at most 100 parameters.

/** A UNIQUE or PRIMARY KEY clash; not other constraints (NOT NULL, CHECK), which a retry won't fix. */
export const isUniqueViolation = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY)/.test(error.message)

/**
 * A person's handle that is taken: by another person (a UNIQUE clash) or by a
 * user group, which migration 0021's trigger refuses by name.
 */
export const isNameClash = (error: unknown) =>
  isUniqueViolation(error) || (error instanceof Error && error.message.includes("name_taken_by_usergroup"))

/** A SQL condition with its parameters, for writes in a batch that happen only where it holds. */
export interface Guard {
  sql: string
  params: unknown[]
}

/** The guard that always holds. */
export const ALWAYS: Guard = { sql: "1", params: [] }

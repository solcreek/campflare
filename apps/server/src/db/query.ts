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

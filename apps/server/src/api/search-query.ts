// Slack's search syntax: words, "phrases", -exclusions and modifiers
// (in:, from:, before:, after:, on:, during:, has:, is:).

export interface SearchQuery {
  terms: string[]
  excluded: string[]
  in: string[]
  from: string[]
  /** Unix seconds: messages at or after `since` and before `until`. */
  since?: number
  until?: number
  has: string[]
  is: string[]
}

const DAY = 86_400

/** A date modifier's day as Unix seconds (UTC midnight), or undefined. */
function day(value: string, now: number): number | undefined {
  const today = Math.floor(now / DAY) * DAY
  if (value === "today") return today
  if (value === "yesterday") return today - DAY
  const m = value.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/)
  if (!m) return undefined
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? "1")) / 1000
}

export function parseSearch(query: string, now = Date.now() / 1000): SearchQuery {
  const q: SearchQuery = { terms: [], excluded: [], in: [], from: [], has: [], is: [] }
  const tokens = query.match(/-?"[^"]*"|\S+/g) ?? []
  for (const token of tokens) {
    const negative = token.startsWith("-") && token.length > 1
    const raw = negative ? token.slice(1) : token
    if (raw.startsWith('"')) {
      const phrase = raw.replace(/^"|"$/g, "").trim()
      if (phrase) (negative ? q.excluded : q.terms).push(phrase)
      continue
    }
    const modifier = raw.match(/^(in|from|before|after|on|during|has|is):(.+)$/i)
    if (modifier && !negative) {
      const [, key, value] = modifier as unknown as [string, string, string]
      const k = key.toLowerCase()
      if (k === "in" || k === "from" || k === "has" || k === "is") {
        q[k].push(value)
        continue
      }
      const d = day(value.toLowerCase(), now)
      if (d !== undefined) {
        if (k === "before") q.until = d
        else if (k === "after") q.since = d + DAY
        else {
          // on: one day; during: a day, or a whole month for YYYY-MM.
          q.since = d
          const start = new Date(d * 1000)
          q.until = /^\d{4}-\d{2}$/.test(value)
            ? Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) / 1000
            : d + DAY
        }
        continue
      }
    }
    ;(negative ? q.excluded : q.terms).push(raw)
  }
  return q
}

/** One term as an FTS5 trigram string: quoted, so its punctuation is literal. */
export const ftsString = (term: string) => `"${term.replace(/"/g, '""')}"`

/** The trigram index needs three characters; shorter terms fall back to LIKE. */
export const indexable = (term: string) => [...term].length >= 3

export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

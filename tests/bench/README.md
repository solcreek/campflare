# Benchmark

End-to-end numbers for the Worker under `wrangler dev`: latency, throughput,
D1 queries and rows read per request, and RTM fan-out.

```sh
pnpm --filter @campflare/bench bench                    # standard dataset, local D1
pnpm --filter @campflare/bench bench --d1-delay 5       # + 5 ms per D1 query
pnpm --filter @campflare/bench bench --quick            # small dataset, about a minute
pnpm --filter @campflare/bench bench --only search      # scenarios whose name contains "search"
pnpm --filter @campflare/bench bench --compare results/<file>.json
```

How it works:

- `seed.ts` builds a deterministic workspace as SQL and loads it into a fresh
  local D1 before the server starts. Standard: 500 users, 34 channels, 20 DMs,
  50,206 messages (20k in `#busy`, threads every 25 messages, one 200-reply
  thread), reactions on a third of them.
- `worker.ts` runs apps/server's Worker with its D1 binding wrapped. Each
  response reports its queries, its **sequential round trips** (queries in
  flight together count once) and the **rows read** (what D1 bills by).
- Local D1 is in-process, so a query costs well under a millisecond. Deployed,
  every round trip to D1 costs real network time. `--d1-delay N` adds N ms to
  each query to show that; in workerd a 5 ms timer lands at about 7.5 ms per
  round trip.
- Each scenario: 20 warm-up requests, 200 timed one at a time (p50/p95/p99),
  then 16 concurrent for 3 s (req/s). Fan-out: 100 users hold RTM links, the
  owner posts to their channel, and the bench times the first and last
  delivery.
- Results go to `results/<commit>-<dataset>-d1-<delay>ms.json`. They record the
  hardware but never the host name.

Laptop numbers are noisy: p50 moves by ±50% from run to run, more under load.
Compare query counts, round trips and rows read, which don't move. Use latency
only for differences much larger than that.

## Results (Apple M3, standard dataset)

Before: `results/1f0b6b8-*` (main at the time). After: `results/0a5ea45-*`.
p50 is with 5 ms added per D1 query, about 7.5 ms per round trip in workerd.

| scenario                         | p50 before → after | round trips |        rows read |
| -------------------------------- | -----------------: | ----------: | ---------------: |
| auth.test                        |          26 → 8 ms |       3 → 1 |            3 → 6 |
| conversations.info #busy         |         73 → 24 ms |       7 → 3 |   20,213 → 1,257 |
| conversations.history 100        |         81 → 32 ms |       7 → 4 |        738 → 741 |
| conversations.replies (200)      |         71 → 50 ms |       8 → 5 |        964 → 967 |
| search: one word (FTS)           |         82 → 40 ms |       7 → 3 |  62,245 → 42,659 |
| search: short term (LIKE)        |        120 → 31 ms |       7 → 3 | 135,605 → 18,917 |
| search: 2-char CJK (LIKE)        |        127 → 30 ms |       7 → 3 | 135,343 → 18,895 |
| reactions.add/remove             |         90 → 31 ms |     8.5 → 4 |        209 → 213 |
| chat.postMessage                 |  91–107 → 24–32 ms | 11–13 → 3–4 |      ~216 → ~213 |
| fan-out to 100 RTM, last arrival |         83 → 27 ms |             |                  |

What changed, one commit each:

- **Authentication** reads the token, team, user and app in one batch.
- **Conversations** come with the actor's membership row, so access checks
  and `conversationOut` need no query of their own.
- **chat.postMessage** writes the message, thread summary and conversation
  time, reads the row back and loads the audience in one batch (also atomic
  now), and serialises the new message once, without `loadExtras`.
- **Search** filters on `m.team_id` with a new `messages(team_id, ts)` index
  (migration 0004), so time-ordered and LIKE searches stop at the page. The
  total counts up to the last reachable page (100 × `count`), in the same batch
  as the page. Authors and reactions load in parallel.
- **unread_count** stops at 1,000 (`MAX_UNREAD`).
- **reactions.add/remove**: the 50-name limit is part of the INSERT, batched
  with the audience.
- **TeamHub.publish** serialises an event once for the log and every RTM link,
  and checks the audience with a Set.
- **files.list** checks visibility in its query, not with one query per file.
  Id lists everywhere bind as one `json_each` argument, because D1 allows 100
  parameters per query. That limit made `conversations.history` fail at its
  default limit (fixed first, in its own commit), and `conversations.invite`
  of 100 or more people.
- **MCP tools** run their Web API call and the user directory in parallel.

## Follow-ups

Then the items left open, compared against `results/0a5ea45-*`; after is
`results/4696762-*`. The seed gained `#scratch` for chat.update and
chat.delete in between (fixed text, no reactions, so no other result moves),
which adds one channel to conversations.list and users.conversations.

| scenario                    | round trips |       rows read |
| --------------------------- | ----------: | --------------: |
| chat.update                 |       9 → 4 |             213 |
| chat.delete                 |       6 → 4 |             212 |
| conversations.history 100   |       4 → 3 |       741 → 968 |
| conversations.replies (200) |       5 → 3 |       967 → 968 |
| search: one word (FTS)      |           3 | 42,659 → 25,095 |
| search: no accents (FTS)    |           3 | 72,625 → 43,072 |
| search: short term (LIKE)   |           3 | 18,917 → 15,347 |

chat.update and chat.delete before are from a `--quick` run, the commit that
added them to the bench. With 5 ms per query they take 30 ms now.

- **chat.update / chat.delete**: the change, the changed row, the audience and
  the reactions are one batch, and one set of extras serves the event's
  before and after and the answer. A deleted reply's thread is recounted in
  SQL in the same batch, instead of reading every reply first.
- **History and replies**: the reactions query takes the page as a subquery
  and goes in the page's batch; replies batches the thread head too. The page
  is read twice, so history reads about 30% more rows for one fewer round trip.
  `loadExtras` loads a page's files and bot apps in parallel.
- **Search** works out the conversations the caller can read once, as a CTE,
  instead of joining every match to its conversation and membership. The page's
  conversations load afterwards, in parallel with its authors and reactions.

Looked into and left as they are:

- **bm25 ranks every match.** A search sorted by score has to score every
  matching message before it can return the best twenty, so its rows read grow
  with the matches. Ranking inside the FTS index first and filtering after
  would return short or wrong pages whenever the top matches are in
  conversations the caller can't read.
- **A bigram index for two-character CJK terms.** Those searches use LIKE,
  which now walks the time index and stops at the page, with a bounded count:
  about 15k rows over 50k messages. Through FTS, a search sorted by score
  would rank every match instead, so it would read more, not less, and every
  write would have to maintain a second index. What a bigram index would add
  is ranking by relevance for those terms: a feature, not a speed-up.
- **users.list with no limit.** Building 500 users' JSON takes 0.2 ms in V8 and
  stringifying it 0.6 ms (measured 2026-10-12). The time in the bench is
  reading 1,000 rows and moving 565 KB, which is the size of Slack's user
  object, and Cloudflare compresses JSON responses on the way out. The earlier
  note here that blamed `userJson` was wrong.

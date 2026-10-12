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

## Still open

- **FTS searches sorted by score** still read every match: bm25 ranks them
  all. A one-word search over 50k messages reads about 43k rows.
- **Two-character CJK terms** (`部署`) can't use the trigram index and fall
  back to LIKE. They are fast now when sorted by time, but still scan for
  the count. A bigram index for CJK would let them use FTS.
- **users.list with no limit** returns everyone, about 1.1 KB a person
  (565 KB for 500). That is Slack's behaviour; `userJson` is the cost.
- **chat.update / chat.delete** are not in the bench yet. They still read the
  message back and run `loadExtras` twice for `message_changed`.
- **conversations.history and replies** take 4 and 5 round trips: auth, the
  conversation, the messages, then their reactions. The reactions could join
  the messages query.

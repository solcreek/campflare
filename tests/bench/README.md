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

## Baseline (fee6564, Apple M3, standard dataset)

| scenario                         | p50 local | p50 +5 ms/query | queries | round trips | rows read |
| -------------------------------- | --------: | --------------: | ------: | ----------: | --------: |
| api.test (no auth)               |       1–4 |               2 |       0 |           0 |         0 |
| auth.test                        |         4 |              24 |       3 |           3 |         3 |
| users.list (all 500)             |        11 |              46 |       4 |           4 |     1,005 |
| conversations.info #busy         |        11 |              57 |       7 |           7 |    20,213 |
| conversations.history 100        |        11 |              55 |       7 |           7 |       738 |
| conversations.replies (200)      |         9 |              66 |       8 |           8 |       964 |
| search: one word (FTS)           |        24 |              74 |       7 |           7 |    76,459 |
| search: short term / CJK (LIKE)  |    71–109 |             113 |       7 |           7 |   142,697 |
| reactions.add/remove             |         6 |              67 |     8.5 |         8.5 |       209 |
| chat.postMessage                 |      7–10 |           86–98 |   11–13 |       11–13 |       216 |
| fan-out to 100 RTM, last arrival |        12 |              77 |         |             |           |

Full tables: `results/fee6564-standard-d1-0ms.json` and `…-d1-5ms.json`.

## Where the time goes

1. **Sequential D1 round trips decide deployed latency.** Every query is
   awaited before the next one starts: round trips equal queries in every
   scenario. Authentication alone is 3 (token, team, user; 4 for a bot's
   app) before the method runs. `chat.postMessage` takes 11 to 13: auth,
   resolve the channel, membership, INSERT, UPDATE the parent, UPDATE the
   conversation, re-SELECT the row, its reactions, the audience, then
   `messageOut` loads the reactions again for the response. Fixes: one JOIN for
   auth (or a short in-isolate cache by token hash); channel and membership in
   one query; the writes and the audience in one `DB.batch` (one round trip,
   and atomic); build the response from the row already in hand. That takes a
   post to about 4 round trips: at 7.5 ms each, from about 90 ms to about 35 ms.
2. **Search reads every matching row twice.** `COUNT(*)` and the page query
   each run the full match. With a term under 3 characters, which includes
   any two-character CJK word such as `部署`, the trigram index can't help and
   both scans read every message in the workspace: 142,697 rows for one search
   over 50k messages. Fixes: cap the count (`SELECT COUNT(*) FROM (… LIMIT
1000)`) or count only on page 1; index CJK bigrams so short CJK terms use
   FTS too.
3. **`unread_count` counts all unread messages.** `conversations.info` on a
   busy channel you've never read reads 20,213 rows, and the cost grows with
   the backlog. Cap the count with a LIMIT subquery, or keep a counter per
   member.
4. **`users.list` with no limit returns everyone**, at about 1.1 KB a user
   (565 KB for 500). That matches Slack's API, but `userJson` is the cost
   (six avatar URLs a user). Worth watching as teams grow.
5. **Hub fan-out is linear in connections.** `publish` deserialises the
   attachment of every socket in the workspace and checks audience membership
   with `Array.includes`, per event. At 100 connections the last delivery is
   2–3 ms after the first; a Set for the audience and per-user socket tags
   (already set) would keep that flat.
6. **`files.list` checks visibility one file at a time** (`canSee` in a loop,
   one query each): a page of 100 files is 100 more round trips. Not in the
   bench yet; one query with the visibility join would do.

Fixed along the way (b2eedc6): `conversations.history` at its default limit
of 100 failed on any channel with more than 100 messages. `loadExtras` bound
one parameter per message plus the channel, and D1 allows 100 per query.
`conversations.invite` (`id IN (…)`, one parameter per invited user) and
`canSee` in `files.ts` (one per channel a file is shared in) still have the
same limit.

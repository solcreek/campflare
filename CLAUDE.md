# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Campflare is a team chat server that speaks the Slack Web API, on Cloudflare
Workers + D1 + R2 + Durable Objects. API and CLI first; a UI comes later.
Existing Slack clients and SDKs must work against it after a base-URL change.

## Commands

```sh
pnpm ready                 # is the checkout ready (deps, secrets, bundles, migrations)? --fix repairs it, --json
pnpm check                 # oxfmt --check, oxlint, tsc (all packages), every test suite with coverage
pnpm fmt                   # format in place (oxfmt)
pnpm dev:all               # migrations + wrangler dev on :8787 + seed; --port 0, --state <dir>, --fresh, --no-seed
pnpm otui                  # opentui-slack against the dev:all server (reads .wrangler/campflare-dev.env)
pnpm dev                   # just wrangler dev on :8787 (apply migrations first: see below)
pnpm build                 # tsdown bundles for packages/client and apps/cli

cd apps/server
pnpm db:migrate:local      # apply migrations/ to local D1 (.wrangler/state)
npx vitest run test/chat.test.ts            # one file
npx vitest run test/chat.test.ts -t "tombstone"   # one test
```

- `pnpm test` in a package adds `--coverage` with thresholds, so a partial run
  fails the thresholds. Use `npx vitest run <file>` for a subset.
- `apps/cli` and `tests/conformance` tests start a real `wrangler dev` on a free
  port with fresh state (`tests/conformance/global-setup.ts`), so they're slower
  and need nothing running.
- Don't pipe `oxlint` into `tail`/`grep` before `&&`: the pipe hides its exit
  code and lint errors slip through.

## Agent loop

`.claude/settings.json` wires hooks from `scripts/agent/`: SessionStart puts the
Nix flake's toolchain (`.dev/dev-tools/bin`) on PATH via `CLAUDE_ENV_FILE` and
prints what `pnpm ready --quick` finds wrong (nothing when all is well);
PostToolUse formats and lints each edited file, returning lint errors (exit 2);
Stop runs format, lint and typecheck when tracked or untracked code changed.
So: don't run oxfmt by hand after edits, and expect the Stop check. Tests are
not in the hooks: run the affected suite yourself. In a fresh worktree, run
`pnpm ready --fix` first.

## Layout

- `apps/server`: the Worker (Hono). Migrations in `migrations/`, tests in `test/`.
  `src/mcp/` is the remote MCP server at `/mcp`.
- `packages/client`: `@campflare/client`, a dependency-free Web API, Socket Mode and RTM client.
- `apps/cli`: the `campflare` CLI, bundled by tsdown into one file with the client inlined.
- `tests/conformance`: the official `@slack/web-api` and `@slack/socket-mode`,
  unmodified, against `wrangler dev`. This is the compatibility oracle.

## Server architecture

**Method registry.** Each file in `src/methods/` calls `method(name, access, handler)`
(`src/api/context.ts`) at import time; `src/index.ts` imports them all for
their side effects. `access` is `user` (xoxp), `bot` (xoxb), `actor` (either),
`app` (xapp) or `none`. One route, `/api/:method`, parses args from query/form/
multipart/JSON (`Args` in `src/api/args.ts`), authenticates, runs the handler,
and wraps the result as `{ ok: true, ...result }`.

**Errors.** Throw `CampflareError(code)` with Slack's error code; it is answered
as HTTP 200 `{ ok: false, error }`, as Slack does. `invalidArguments()` adds
`response_metadata.messages`.

**Shapes.** `src/api/shapes.ts` turns DB rows into Slack's JSON. It sends every
field Slack always sends, with neutral values where Campflare has no concept.
Messages are serialised in batches through `loadExtras()` (reactions, files,
bot apps in one query each).

**Data.** D1 via thin helpers in `src/db/query.ts` (no ORM). Message `ts` is a
fixed-width `"##########.######"` string so text order is time order; it's
unique per channel by primary key, and `postMessage` retries with `nextTs()` on
a clash. Search is FTS5 with the **trigram** tokenizer and `remove_diacritics`
(migration 0002), so CJK substrings match and Latin text matches without case or
accents; terms under 3 characters fall back to LIKE. A thread head with replies is
tombstoned on delete, not removed. Tokens are stored as SHA-256 hashes only.

**Realtime.** After a write, handlers call `publish()` (`src/events.ts`), which
sends the event to the workspace's `TeamHub` Durable Object (`src/hub.ts`) over
RPC inside `waitUntil`. The audience is the conversation's members (or the whole
team). The hub holds hibernating WebSockets of two kinds:

- Socket Mode (`apps.connections.open`): `events_api` envelopes, one connection
  per app per event (round robin), as Slack does. An app sees what its installer
  or its bot user can see.
- RTM (`rtm.connect`): raw events to every connection of the user, including
  `rtmOnly` client-state events (`*_marked`, ephemeral messages).
  WebSocket URLs carry a signed, single-use, 60-second ticket (`src/api/tickets.ts`)
  that the hub checks against its own SQLite storage.

The hub's SQLite also holds:

- `events`: every published event for a week, numbered (`seq`), with its
  audience. `campflare.events.poll` (`src/methods/events.ts` → `TeamHub.poll`)
  reads it from a cursor and long-polls by parking a waiter that `record()`
  wakes. RPC return values must be serialisable, so events cross as JSON strings.
- `unacked`: Socket Mode envelopes until their `envelope_id` is acked; the DO
  `alarm()` resends overdue ones (3 s, up to 3 retries) on the app's next link.

**Files.** `files.getUploadURLExternal` reserves a row and returns a signed
`/upload/v1/:token` URL; bytes go to R2 at `<team>/<file>`;
`files.completeUploadExternal` shares them and posts the message. `url_private`
is served by `handleDownload` with the same Bearer tokens, with range support,
and `content-security-policy: sandbox`.

**MCP.** `/mcp` (`src/mcp/`) uses `@modelcontextprotocol/server` v2:
`createMcpHandler` builds a fresh `McpServer` per request (2026-07-28 spec, with
the stateless fallback for 2025 clients). `requireBearerAuth` gates it with a
verifier over `authenticate()`; the verified `Actor` rides in `authInfo.extra`.
Tools call Web API handlers through `invoke()` (`src/mcp/invoke.ts`) rather than
reimplementing them, then shape results compactly (`src/mcp/format.ts`). Tool
errors are `CampflareError` codes returned as `isError` results. Tests use the
official `@modelcontextprotocol/client` in workerd (`test/mcp.test.ts`) and in
Node over HTTP (`tests/conformance/mcp.test.ts`), in both protocol eras.

**OAuth (Better Auth).** `src/auth/` makes the Worker an OAuth 2.1
authorization server for MCP clients. `createAuth()` builds Better Auth per
request (its URLs follow the request's origin) with `jwt()`, `mcp()` (tokens
bound to `<origin>/mcp`, RFC 9728 metadata), `cimd()` (MCP 2026-07-28 profile;
DCR off) and `campflareTokenSignIn()`, a plugin that signs a person in with an
xoxp token and links them as an `account` (providerId `campflare`, accountId =
Campflare user id). Routes (`src/auth/routes.ts`): `/auth/*` and
`/.well-known/*` go to Better Auth; `/login` and `/consent` render script-free
forms whose POSTs are forwarded to Better Auth as JSON (the only body type it
accepts), turning its `{ url }` answer into a redirect. `/mcp` verifies those
JWTs locally against `auth.api.getJwks()` (issuer `<origin>/auth`), maps `sub`
through `account` to a Campflare user (`actorFor()`), and still accepts
xoxp/xoxb. Better Auth's tables (migration 0003, generated by its
`getMigrations`) are singular camelCase: `user`, `session`, `account`,
`oauthClient`… CIMD fetches go through `src/auth/cimd-fetch.ts`; tests replace
it with `setAuthOverrides()`, which works because tests share the Worker's
isolate.

**Admin.** `campflare.*` methods (`src/methods/admin.ts`) do what Slack's admin
UI and OAuth do: `campflare.bootstrap` (needs `BOOTSTRAP_SECRET`) creates a
workspace, its owner and #general; others add people, tokens and apps (an app is
a bot user + xoxb + xapp).

## Conventions

- **Naming:** our own identifiers, files and directories never contain "slack";
  use `campflare` or a neutral name (`CampflareError`, `x-campflare-req-id`,
  `src/api/`). The wire surface stays Slack's: method names, token prefixes
  (`xoxp-`/`xoxb-`/`xapp-`), JSON fields, error codes.
- **Adding a Slack method:** a handler in `src/methods/`, shapes in `shapes.ts`
  if new, events via `publish()` if Slack emits any, a server test in
  `apps/server/test/`, and a conformance case when an official SDK method covers it.
- **D1 round trips:** deployed, every awaited query is a network round trip, and
  they dominate latency. Put independent statements in one `DB.batch` (one trip,
  and atomic for writes) or `Promise.all`; `authenticate()` and
  `getConversation()`/`resolveConversation()` already bring the token's team,
  user and app, and the actor's membership. Pass id lists as one JSON argument,
  `IN (SELECT value FROM json_each(?))`: D1 binds at most 100 parameters.
  `pnpm --filter @campflare/bench bench` (`tests/bench/README.md`) shows
  queries, round trips and rows read per method; use `--compare` against
  `tests/bench/results/`.
- **Commits:** atomic and frequent, one topic each, with the tests for that change.
  Keep the coverage thresholds passing.
- Style is set by oxfmt: no semicolons, double quotes, width 120. Code,
  comments and commit messages are in English.
- **Languages in data and tests:** no single non-English language. When text in
  other languages is needed (seed data, search tests, examples), cover scripts
  evenly: CJK (Chinese, Japanese, Korean) and accented Latin (Spanish, French,
  German) at least.
- `compatibility_date` is 2026-08-15, the newest that the workerd in
  `@cloudflare/vitest-pool-workers` 0.22 supports; vitest stays on 4.x for the same reason.

## Running a Slack client against it

opentui-slack (`~/Projects/solcreek/opentui-slack`) reads `SLACK_API_URL`.
`pnpm otui` (`scripts/otui.sh`) launches it against the `dev:all` server with
its own config dir and daemon socket under `.wrangler/`. Its repo `.env` holds
real Slack tokens, which Bun auto-loads; exported environment variables win
over it, so the script exports the Campflare ones. A daemon started without
them keeps the wrong tokens: `pnpm otui daemon stop`.
`~/.local/bin/campflare` wraps the built CLI (`apps/cli/dist/index.mjs`).

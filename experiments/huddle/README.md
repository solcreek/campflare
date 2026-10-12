# Huddles: audio calls on Cloudflare Realtime (experiment, step 1)

Branch `experiments/huddle-1v1`. Can a conversation have a voice call, with
media through Cloudflare's Realtime SFU and signalling through Campflare's
own API and events? Step 1 answers this for audio between two or more people.
Result (2026-10-12): yes.

## Run it

```sh
pnpm dev:all                     # apps/server/.dev.vars needs REALTIME_* (see below)
open http://localhost:8787/huddle
```

Paste a user token (two people: two browsers, or a normal and a private
window), type `#general`, join. Each side should hear the other.

## How it works

- **Media:** each browser keeps two PeerConnections to the SFU: one publishes
  its microphone (`campflare.huddles.join`: its offer in, the SFU's answer
  out), one receives everyone else (`campflare.huddles.subscribe`: the SFU's
  offer out, `campflare.huddles.answer`: the browser's answer in).
- **Signalling:** `TeamHub` keeps who is in each conversation's call and which
  user owns each SFU session; members hear `huddle_joined` and `huddle_left`
  over RTM and subscribe to newcomers.
- **Permissions:** only members of the conversation join or subscribe; only
  what's published in that call can be subscribed to; only a session's owner
  answers on it. The SFU App Secret never leaves the Worker.
- **Code:** `apps/server/src/huddle/` (`sfu.ts` the Connection API client,
  `methods.ts` the API, `page.ts` the test page).

## Tests, in three layers

| Layer             | Where                                             | Runs                                           | What it proves                                                                                                                           |
| ----------------- | ------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded fixtures | `apps/server/test/fixtures/sfu/exchanges.json`    | recorded by `RECORD_FIXTURES=1 pnpm test:live` | the real API's shapes, including its errors (per-track `not_found_track_error` with HTTP 200; `425 session_error`)                       |
| Offline           | `apps/server/test/huddle.test.ts` + `fake-sfu.ts` | `pnpm check`                                   | the API's behaviour and permissions, against a fake SFU built from the fixtures                                                          |
| Live              | `tests/live/`                                     | `pnpm test:live` (opt-in)                      | real WebRTC: werift peers in Node carry RTP through the SFU; two real Chrome pages on `/huddle` hear each other and see each other leave |

MSW was considered and left out: the server tests run inside workerd, where
its interceptors don't apply, and the SFU client already takes a `fetch`.

## Measured

- Round trip from a MacBook Air in Taiwan to the SFU: about 20 ms (Chrome's
  `candidate-pair.currentRoundTripTime`, 2026-10-12).
- Audio at Opus rates is about 15 MB per listener per hour: inside the SFU's
  1,000 GB monthly free egress for anything experimental.

## Cloudflare resources

Created with the `cf` CLI in the Kaik, Inc. account (2026-10-12), for local
development:

```sh
cf realtime sfu apps create --name campflare-dev     # → REALTIME_APP_ID, REALTIME_APP_SECRET
cf realtime turn keys create --name campflare-dev    # → REALTIME_TURN_KEY_ID, REALTIME_TURN_KEY_TOKEN
```

Their secrets are only in `apps/server/.dev.vars` (gitignored). Delete with
`cf realtime sfu apps delete` / `cf realtime turn keys delete`.

## Not yet

- A seat outlives a browser that dies without `pagehide`; nothing expires it
  (the SFU itself drops tracks after 30 s without media).
- No mute, no device picker, no reconnect after a network change.
- Video, simulcast and active-speaker subscription (step 2), and transcription
  through the WebSocket adapter (step 3).
- Slack's `calls.*` metadata API, so Slack clients see that a call is on.

# Huddles: calls on Cloudflare Realtime (experiment)

Branch `experiments/huddle-1v1`. Can a conversation have a call, with media
through Cloudflare's Realtime SFU and signalling through Campflare's own API
and events?

- Step 1, audio between people: yes (2026-10-12).
- Step 2, video and several people: yes, four people with cameras tested
  live (2026-10-12).

## Run it

```sh
pnpm dev:all                     # apps/server/.dev.vars needs REALTIME_* (see below)
open http://localhost:8787/huddle
```

Paste a user token (two people: two browsers, or a normal and a private
window), type `#general`, join. Each side should hear the other.

## How it works

- **Media:** each browser keeps two PeerConnections to the SFU: one publishes
  its microphone and camera (`campflare.huddles.join`: its offer in, the SFU's
  answer out), one receives everyone else (`campflare.huddles.subscribe`: the
  SFU's offer out, `campflare.huddles.answer`: the browser's answer in).
- **Video:** cameras publish as simulcast in three encodings (`f` full, `h`
  half, `q` quarter). Each subscription picks one, and `campflare.huddles.layer`
  switches it in place (`tracks/update`, no renegotiation). The page asks for
  `f` with up to two video tiles, `h` up to four, `q` beyond, and a step up for
  whoever is loudest. `publish` and `unpublish` turn a camera on and off
  mid-call (announced as `huddle_tracks`); a camera that comes back is a new
  transceiver and track name, never a force-closed one reused.
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

- Simulcast: a subscriber received 1280 px on `f`, then 320 px seconds after
  switching to `q` in place (Chrome publishing a 1280×720 fake camera).
- Four people with cameras: each decodes the other three at 640 px (`h`), the
  loudest at 1280 px (`f`), as the page's policy asks.

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

## Found along the way

- **Subscribing can beat the publisher's connection.** `huddle_joined` goes
  out when `join` returns, before the newcomer's PeerConnection is up; the SFU
  then refuses the subscription with `not_found_track_error` ("make sure the
  publisher peer is connected and sending packets"). The page retries with
  backoff for about 10 s. A server-side alternative would be announcing only
  after the publisher reports it is connected.
- The SFU answers `tracks/update` for a subscription that doesn't exist with
  HTTP 200 and a per-track `internal_error`.

## Not yet

- A seat outlives a browser that dies without `pagehide`; nothing expires it
  (the SFU itself drops tracks after 30 s without media).
- Mute only silences the track locally (others aren't told); no device
  picker, no screen sharing, no reconnect after a network change.
- Layers don't react to the subscriber's bandwidth (`priorityOrdering: none`);
  tiles that are off screen still receive video.
- Transcription through the WebSocket adapter (step 3).
- Slack's `calls.*` metadata API, so Slack clients see that a call is on.

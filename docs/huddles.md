# Huddles: calls on Cloudflare Realtime

A conversation can have a call, with media through Cloudflare's Realtime SFU
and signalling through Campflare's own API (`campflare.huddles.*`) and RTM
events. Huddles are off until `apps/server/.dev.vars` (or the Worker's
secrets) has a Realtime SFU app; transcription also needs a Workers AI token.
There is no UI yet: `/huddle` is a test page.

Built and verified live in three steps (2026-10-12):

- Audio between people.
- Video and several people: four people with cameras.
- Transcription and a summary: two people speaking Spanish and Japanese,
  transcribed live, attributed, labelled with their language, and summarised.

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

## Transcription

```
browser mic ─WebRTC→ SFU ─WebSocket adapter (48 kHz stereo PCM, protobuf)→ /huddle/scribe/<ticket>
  → HuddleScribe (one per call): per speaker, 16 kHz mono, cut into utterances by loudness
  → Whisper (Workers AI) → "*Name*: text" in the call's thread, by the Huddle Scribe bot
stop (by request, or the last leaver) → last words → summary (Llama 3.3 70B) in the same thread
```

- `campflare.huddles.transcribe` turns it on and off. One adapter per
  microphone, so every line knows its speaker without diarisation; newcomers
  are added, retried while their connection comes up (the same race as subscribing).
- Each line and the summary carry message `metadata` (`huddle_transcript`:
  user, text, language; `huddle_summary`: text, line count, language), so an
  agent reads the call without parsing text.
- The summary is written in the call's dominant language, decided from what
  Whisper heard (weighted by text), not guessed by the model: asked to guess, it
  summarised a mostly Chinese call half in English.
- The SFU dials out to the endpoint, so it must be public: `HUDDLE_PUBLIC_URL`,
  or the request's own origin. In development, a quick tunnel
  (`cloudflared tunnel --url http://localhost:8787`) and opening `/huddle`
  through it works with no setting at all.
- Workers AI is called over REST with an account token scoped to Workers AI
  Read (no `wrangler login` needed), the same way in tests and live.

## Tests, in three layers

| Layer             | Where                                                                     | Runs                                           | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded fixtures | `apps/server/test/fixtures/sfu/exchanges*.json`, `fixtures/speech/*.json` | recorded by `RECORD_FIXTURES=1 pnpm test:live` | the real APIs' shapes, including their errors (per-track `not_found_track_error` and `internal_error` with HTTP 200; `425 session_error`; the adapter's `websocket_handshake_failed` and 503), and Whisper's and the summary model's answers in several languages                                                                                                                                                                                                                                    |
| Offline           | `apps/server/test/huddle.test.ts` + `fake-sfu.ts`                         | `pnpm check`                                   | the API's behaviour and permissions, against a fake SFU built from the fixtures                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Live              | `tests/live/`                                                             | `pnpm test:live` (opt-in)                      | real WebRTC: werift peers in Node carry RTP through the SFU; Chrome simulcast layers switch in place; two Chrome pages hear each other; four see and hear each other at the expected layers, and a camera turned off and on again shows on the others' screens; Whisper transcribes seven languages; the summary model follows the call's language; and end to end, two Chrome browsers whose fake microphones play speech (Spanish, Japanese) are transcribed through a quick tunnel and summarised |

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

Create them with the `cf` CLI in your Cloudflare account, and put the
secrets in `apps/server/.dev.vars` (gitignored):

```sh
cf realtime sfu apps create --name campflare-dev     # → REALTIME_APP_ID, REALTIME_APP_SECRET
cf realtime turn keys create --name campflare-dev    # → REALTIME_TURN_KEY_ID, REALTIME_TURN_KEY_TOKEN
```

For transcription, an account token scoped to Workers AI Read
(`cf accounts tokens create`, with an expiry) as `WORKERS_AI_TOKEN`, and the
account's id as `CF_ACCOUNT_ID`. Delete them with `cf realtime sfu apps delete`
/ `cf realtime turn keys delete`.

## Found along the way

- **Behind a tunnel, every URL we built said http.** The tunnel terminates TLS
  and forwards plain HTTP, so `rtm.connect` answered `ws://` to an `https`
  page. `publicOrigin()` now honours `X-Forwarded-Proto` / `CF-Visitor`, for
  any reverse proxy.
- **A quick tunnel's name can be cached as nonexistent.** Asking the system
  resolver before the name exists makes macOS cache the miss, and Chrome
  shares it: the tests wait over DNS-over-HTTPS first.
- Whisper returns Chinese in simplified characters, even for speech read from
  traditional text.

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
- Transcription: overlapping speech isn't separated, the transcript can't be
  edited or deleted as a whole, and Chinese comes out simplified (an
  `initial_prompt` in traditional characters may steer it).
- Slack's `calls.*` metadata API, so Slack clients see that a call is on.

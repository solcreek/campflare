# Push notifications

Status: implemented, 2026-10-15 (the `push` branch).

Nobody leaves Slack for a chat that can't tell them someone needs them. The
activity inbox ([activity.md](activity.md)) already decides, per person and
per item, whether something should interrupt (`notify`). This delivers those
items to people's browsers and installed web apps with standard Web Push, so
a closed tab, a phone in a pocket or a laptop with the app in the background
still rings.

## The pieces

- **Web Push** (RFC 8030) to whatever push service the browser chose (FCM for
  Chrome, Mozilla's autopush, Apple's for Safari and iOS 16.4+ home-screen
  apps), with **VAPID** (RFC 8292) to identify the server and **aes128gcm
  message encryption** (RFC 8291, RFC 8188), all in `apps/server/src/push/`
  on WebCrypto alone: no Node library, nothing that won't run in a Worker.
- **Subscriptions** in D1 (`push_subscriptions`, migration 0028), one row per
  browser, per person: a person has as many as they have browsers and phones.
- **Delivery** in the workspace's `TeamHub` Durable Object, which already
  receives every `activity_added` event after the response (`publishEach()`).
  Posting a message adds no round trip and no awaited work.
- **The app** (`apps/web`) registers a service worker and a web app manifest,
  so it can be installed (which iOS requires before it allows push), asks for
  permission from a menu item, and subscribes.

## Keys and configuration

Three variables, all optional: without the keys, push is off and the push
methods answer `push_not_configured`.

- `VAPID_PUBLIC_KEY`: the P-256 public key, uncompressed (65 bytes), base64url.
  This is the `applicationServerKey` browsers subscribe with.
- `VAPID_PRIVATE_KEY`: its private scalar `d` (32 bytes), base64url. A secret.
- `VAPID_SUBJECT`: a `mailto:` or `https:` URL push services can reach the
  operator at; defaults to the request's origin.

The format is the one the `web-push` tools print, so keys made by them work.
`pnpm vapid-keys` prints a fresh pair; `pnpm ready` reports a `.dev.vars`
without them and `pnpm ready --fix` writes a pair into it. Changing the keys
invalidates every subscription (push services refuse a subscription made with
another key, 403); browsers subscribe again the next time the app loads,
because it compares the key it subscribed with to the server's.

## Methods

| method                       | access | scope        |
| ---------------------------- | ------ | ------------ |
| `campflare.push.vapidKey`    | none   | none         |
| `campflare.push.subscribe`   | user   | `push:write` |
| `campflare.push.unsubscribe` | user   | `push:write` |
| `campflare.push.list`        | user   | `push:read`  |
| `campflare.push.test`        | user   | `push:write` |

`push:read` is in the `read` preset (the list never reveals an endpoint, see
below); `push:write` only in `full`: registering where a person's
notifications go is a job for that person's own client, not for an agent
acting for them. User tokens only: a bot has no browser.

- **`campflare.push.vapidKey`** answers `{ key }`: the public key, before
  sign-in or with any token, as the app needs it to subscribe.
- **`campflare.push.subscribe`** takes `subscription` (what
  `PushSubscription.toJSON()` gives: `{ endpoint, keys: { p256dh, auth } }`),
  or `endpoint`, `p256dh` and `auth` separately, and an optional `label` ("Firefox
  on Linux"; up to 100 characters). The endpoint must be `https`; `p256dh` a
  65-byte uncompressed P-256 point and `auth` 16 bytes, base64url. An endpoint
  is one browser: subscribing it again updates its keys and label, and moves it
  to whoever subscribed last (one browser profile, the person signed in now). A
  person keeps at most 20 (`MAX_SUBSCRIPTIONS`); a 21st replaces their oldest.
  Answers `{ subscription }` as the list shows it.
- **`campflare.push.list`** answers `{ subscriptions: [{ id, label, service,
created, last_used }] }`, newest first. `service` is the endpoint's host
  (`fcm.googleapis.com`): the endpoint itself is a capability (anyone holding
  it and the keys can push to that device), so it is never answered.
- **`campflare.push.unsubscribe`** takes `id` or `endpoint` (a browser that
  unsubscribes knows its endpoint, not our id); one of the caller's own, else
  `subscription_not_found`.
- **`campflare.push.test`** sends every device of the caller (or the one `id`)
  a test notification, now, and answers `{ sent, failed, removed }`: the
  quickest way to see that a device works, from the CLI or the app.

## What a notification says

Each item with `notify: true` becomes one push to each of its recipient's
subscriptions. The payload is JSON, encrypted:

```json
{
  "title": "Olive Owner in #general",
  "body": "@bob ¿revisas esto? 確認してください",
  "tag": "C123",
  "route": "#/C123/1760000000.000100?msg=1760000000.000200",
  "item": "42",
  "type": "mention",
  "channel": "C123",
  "ts": "1760000000.000200"
}
```

- `title`: who and where. `Olive Owner in #general`; in a DM, the person alone;
  in a group DM, `Olive Owner in a group DM`; a thread reply, `Olive Owner
replied in #general`; a reaction, `Olive Owner reacted :tada: in #general`.
  The display name, else the real name, else the handle.
- `body`: the message's text as plain text (mentions become `@name`, channel
  links `#name`, links their label, entities decoded), at most 300 characters.
  A message without text says `sent a file` or `sent a message`.
- `tag`: the conversation, so a device shows one notification per conversation,
  the newest replacing the older (the service worker sets `renotify` so it
  still alerts). The push request's `Topic` header is the same, so a push
  service holding pushes for an offline device keeps only the newest per
  conversation.
- `route`: the app's hash route to the message, `#/<channel>?msg=<ts>` or
  `#/<channel>/<thread>?msg=<ts>` for a reply: a click opens it.
- `TTL` is a day: a notification that waited longer is old news, the inbox
  still has it. `Urgency: high` for mentions and DMs (a phone in doze wakes for
  them), `normal` for thread replies and reactions.

## Delivery

`TeamHub.publishEach()` sends the RTM events first, then looks at the
`activity_added` events among them with `notify: true`:

1. **Is the person here?** Slack doesn't push to a phone while its desktop app
   is in use. The rule here: a client may tell its RTM link it is **active**
   (a `{"type": "campflare.active", "active": true}` frame; the app sends it
   while its window is focused and visible, again every minute while it stays
   so, and `false` when it loses focus). An item whose recipient has an RTM
   link that said `active: true` within the last two minutes
   (`ACTIVE_WINDOW_MS`), and not `false` since, isn't pushed: they are looking
   at the app, which shows it. Clients that never say (the CLI, an agent,
   other Slack clients) don't suppress anything.
2. **Who has devices?** The hub reads the workspace's subscriptions from D1
   once per lifetime and keeps them (subscribe and unsubscribe tell it to read
   again), so an item for someone without devices costs nothing.
3. **Names.** One D1 batch reads the names the titles and bodies need: the
   actors, the people mentioned in the texts, the conversations. Only when
   something is to be sent.
4. **A cap.** At most 30 pushes per person per minute (`PUSH_PER_MINUTE`,
   counted in the hub's SQLite); past it items are only in the inbox. A
   runaway bot can't buzz a phone a hundred times.
5. **Send**, all at once, each encrypted for its subscription.

What the push service answers:

- `201`/`2xx`: delivered to the service. The subscription's `last_used` is
  updated (in one batch for all of them).
- `404`/`410`: the subscription is gone (the browser unsubscribed, the app was
  uninstalled). Its row is deleted, as RFC 8030 asks.
- `429` or `5xx` or no answer within 10 s: retried after 10 s, 1 min and 5 min
  (`PUSH_RETRY_DELAYS_MS`), or after `Retry-After` if the service sent one
  (at most an hour), then dropped. Retries are kept in the hub's SQLite
  (`push_retries`) and sent by its alarm, the one that already resends Socket
  Mode envelopes and Events API POSTs, so a hub that is evicted still retries.
- Anything else (`400`, `403`, `413`): dropped, logged. A `403` is usually a
  subscription made with other VAPID keys; the app subscribes afresh when it
  sees the key changed.

VAPID JWTs (ES256, `aud` the push service's origin, `exp` 12 hours) are kept
in the hub's memory per origin for an hour, so a busy workspace signs a few an
hour, not one per push.

Not done: items read elsewhere don't close a notification already shown on a
device (that would need a push per read; Slack does it). A deleted message's
notification stays too.

## The app

- `src/sw.ts` is the service worker, served as `sw.js` at the app's root (so
  its scope is the whole app) by a small Vite plugin (`serviceWorkerPlugin()`
  in `vite.config.ts`: in development from memory, in a build as a file beside
  `index.html`), which strips the types and `export`s into a classic script; it
  imports nothing. Its handlers are plain exported functions that unit tests
  call with fake events, and a test runs the served script itself against a
  fake worker. It has no fetch handler and no caches. `push` shows the
  notification (title, body, tag with `renotify`, the app's icon, the route);
  a click focuses an open window of the app and sends it the route (a
  `postMessage` the app turns into `location.hash`), or opens one there.
  `registerServiceWorker()` (`src/push.ts`) registers it from `main.tsx` in a
  browser (not in the desktop shell, whose webview has no Push API).
- `apps/web/public/manifest.webmanifest` and `public/icons/`: `display:
standalone`, so the app can be installed, and on iOS 16.4+ added to the home
  screen, where Safari allows push only.
- The workspace menu has **Turn on notifications** (or **Turn off**, or says
  why it can't: blocked, unsupported, not configured on the server, or on iOS
  "Add Campflare to your Home Screen"). It asks permission (from the click,
  which browsers require), subscribes with the server's key and calls
  `campflare.push.subscribe` with a label made from the browser and platform
  ("Firefox on Linux"). On every load, a subscription made with another key is
  replaced, and one that matches is sent to the server again (it may have
  dropped it after a 410): a browser that said yes stays subscribed without
  asking again. **Send a test notification** calls `campflare.push.test`.
  Browser APIs come in through a `PushPlatform`, so tests drive the whole path
  with a fake permission, service worker and `PushManager`.
- Active: `reportActivity()` (`src/presence.ts`) tells the server over RTM
  (above), through `setActive()` on core's workspace (`Listener.send()` in the
  client), which says it again on every reconnect.

`pushsubscriptionchange` (a browser rotating a subscription by itself) isn't
handled in the worker, which has no token to tell the server with; the next
load of the app subscribes again.

## CLI

- `campflare push list [--json]`: devices, newest first.
- `campflare push remove <id>`.
- `campflare push test [<id>] [--json]`: a test notification to your devices.

## Desktop

The Tauri webview has no Push API (WKWebView, WebView2 and WebKitGTK don't
expose one to an app's own pages), and an app that is running doesn't need a
push service: it has an RTM link. Native notifications fed by RTM
`activity_added` events with `notify: true` while the window isn't focused
(`tauri-plugin-notification`) are the next step; not done here.

# Invitations and password resets

Status: implemented, 2026-10-15 (the `invites` branch).

Until now an admin added a person with `campflare.users.create`, which answers
with that person's token: the admin then had to pass a secret on by hand, and
the person had no password until they set one. This makes joining self-serve:
an admin (or an agent acting for one) makes a link, hands it over however they
like, and the person picks their own handle and password. The same shape gives
password resets.

There is no email infrastructure. Both features are **links**: the API answers
with the URL, the CLI prints it, and whoever made it passes it on. Email is an
optional seam (below), absent by default.

## Invitations

### Making one

`campflare.invites.create` (xoxp, `admin.invites:write`, admin role):

| argument     | meaning                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `email`      | bind the invite to this address: only it can accept, and it is single use                                       |
| `role`       | `member` (default) or `admin`; an admin invite takes an owner, as `campflare.users.create` with `is_admin` does |
| `channels`   | conversations to join besides #general: public channels, or private ones the inviter is in                      |
| `expires_in` | seconds, default 7 days, at least 60, at most 30 days                                                           |
| `max_uses`   | how many people one open link admits, default 1, at most 1000; an email-bound invite is always 1                |

It answers `{ invite: {…}, url: "<origin>/join/<code>" }`. The code is 32
random bytes (hex); only its SHA-256 is stored (migration 0020, `invites`), so
the URL is shown once, as tokens are. An email already in the workspace is
`already_in_team` up front.

`campflare.invites.list` (`admin.invites:read`, admin) answers the workspace's
invites, newest first, each with `state`: `pending`, `used_up`, `expired` or
`revoked`, and who made it. `campflare.invites.revoke` (`admin.invites:write`,
admin; `invite`: its id) stops one at once; any admin may revoke any invite,
since revoking only ever takes power away.

### Accepting one

Two ways in, sharing one function (`acceptInvite()` in `src/invites.ts`):

- **`/join/<code>`**, a script-free page in the style of `/login` (same
  `page()`, same CSP): the workspace's name, who invited, then handle, full
  name, email (shown, not asked, when the invite is bound to one) and
  password. On success the person is signed in, as `/login` signs in (a Better
  Auth session, through a server-only endpoint of the `campflareSignIn`
  plugin, `signInCampflareUser`, never reachable over HTTP), and sent to
  `APP_URL`; without one, the page says what to do next (the CLI's
  `campflare login --oauth`). The CSP's `form-action` adds `APP_URL`'s origin,
  since browsers apply it to the redirect that answers the POST.
- **`campflare.invites.accept`** (no token: `code`, `name`, `password`,
  `real_name`, `email`), for agents and `campflare join <url>`. It answers the
  user and a `full` token, labelled `invite`: the same thing a person's own
  sign-in gets, and what `campflare.users.create` answered before.

An email is required either way (bound, or given): a password signs in with an
email, so a person without one could never use theirs.

**Is a token over an unauthenticated call safe?** The code is the credential:
the admin who made it chose to let its holder in, as with Slack's invite links.
Its holder can only create a new person (never sign in as an existing one), at
most `max_uses` times, before it expires, with the role the admin chose. What
remains is guessing codes and burning CPU on password hashing, which the
sign-in throttle (`src/auth/throttle.ts`) bounds: every accept counts against
`rate:<ip>` (30 a minute), and an unknown code counts a failure against
`ip:<ip>` (20 free, then backoff), read in the same batch as the invite.
Throttled, the method answers `too_many_attempts` with `retry_after`, the page
a 429 with `Retry-After`.

**Checks at the moment of use**, in one `DB.batch` (atomic):

1. The user row is inserted only if the invite is still pending (not revoked,
   not expired, uses below the maximum) **and its inviter is still an active
   admin** (an owner, for an admin invite): demoting or deactivating someone
   retires their invites, as it would their power to make them.
2. The use is counted only if that row went in; #general and the invite's
   channels (still existing, not archived) are joined; the password is stored.

A handle or email already taken fails the whole batch (`name_taken`,
`already_in_team`) and spends no use. A batch that inserts nothing is then
explained by reading the invite again: `invite_expired`, `invite_revoked`,
`invite_used_up`, else `invalid_invite`. An email-bound invite with another
address is `email_mismatch`, before anything is written.

### Events

`team_join` (Slack's: `{ type: "team_join", user }`) to the whole workspace,
and `member_joined_channel` for each conversation joined, to its members, as
`conversations.join` sends it. Apps subscribed to `team_join` get it as an
`event_callback`, as on Slack.

## Password resets

### An admin makes a link

`campflare.users.createPasswordReset` (xoxp, `admin.users:write`; `user`,
optional `expires_in`, default an hour, 5 minutes to a day) answers
`{ url: "<origin>/reset/<code>", expires }`. Making a reset for someone is
acting for them, so it takes a role above theirs (`requireOutranks()`: an admin
for a member, an owner for an admin, nobody for an owner, who resets their own
with `campflare.users.setPassword`). The person needs an email
(`email_required`): a password signs in with one. A new link replaces any
earlier unused one for the same person. Stored hashed, single use
(`password_resets`, migration 0020).

### The person uses it

`/reset/<code>` is a script-free page asking for the new password twice;
`campflare.users.resetPassword` (no token; `code`, `password`) is the same for
the CLI (`campflare password reset <url>`) and agents. Either one goes through
`setPassword()` (`src/auth/password.ts`), so it ends the person's browser
sessions and MCP grants exactly as setting a password does. A rejected
password (too short) doesn't spend the link; a used, expired or unknown one is
`invalid_reset`, and the person's every outstanding reset is deleted when one
is used. A deactivated person's link does nothing. Attempts are throttled as
invites are.

### A person asks for their own

`campflare.users.requestPasswordReset` (no token; `email`, optional
`workspace`) and the form at `/reset`. It needs an email sender: without one it
answers `email_not_configured`, and the page says to ask an admin for a link
(`campflare admin reset-password @you`). With one, it mails a link (an hour) to
each active person with that address (in that workspace, if given) and always
answers `{}`, so it never says whether an address has an account. Throttled per
address (`rate:`) and per email (`reset:<email>`: 3 free, then backoff), so it
can't be used to flood a mailbox. The `/login` page links to `/reset`.

## The email seam

`src/email.ts`:

```ts
interface EmailSender {
  send(message: { to: string; subject: string; text: string }): Promise<void>
}
```

`emailSender(env)` answers the configured sender, or `undefined`; today it
returns only what a test installed with `setEmailSender()`. A provider (an
HTTP API such as Resend or Postmark, or Cloudflare's `send_email` binding) is
one class implementing `send`, returned from `emailSender(env)` when its
configuration is present in `env`. Nothing else changes: invitations bound to
an email are mailed too when a sender exists (`emailed: true` in the answer;
the URL is still answered, so the admin can hand it over if mail is slow), and
self-service resets start working.

## CLI

- `campflare admin invite [--email e] [--admin] [--channel #c]… [--expires 7d] [--uses N]`:
  prints the URL alone on stdout (so `URL=$(campflare admin invite …)`), what
  it allows on stderr.
- `campflare admin invites`: the list, with states. `campflare admin invite revoke <id>`.
- `campflare join <url> <handle> [--name <real name>] [--email e]`: the
  password hidden twice (or the first line of stdin), accepts, and saves a
  profile as `login` does (`--profile`). `--email` is needed unless the invite
  is bound to one. `campflare join <#channel>` still joins a channel.
- `campflare admin reset-password <@person> [--expires 1h]`: prints the URL.
- `campflare password reset <url>`: sets the new password from the link.

All take `--json`.

## Later

- An email provider behind the seam, and mailing invites in bulk.
- Guests: an invite whose role is a guest limited to its channels.
- A page for admins listing invites (the API has it).

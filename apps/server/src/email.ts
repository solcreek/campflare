import type { Env } from "./env"

// Sending email: a seam with nothing behind it yet (docs/invites.md).
// Invitations and password resets are links that the API answers with; when a
// sender exists, invitations bound to an email are mailed too, and people can
// ask for their own password reset. A provider (an HTTP API, or Cloudflare's
// send_email binding) is one class implementing EmailSender, returned from
// emailSender() when its configuration is in `env`.

export interface EmailMessage {
  to: string
  subject: string
  /** Plain text: links in it are the whole point, and every client shows them. */
  text: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

let installed: EmailSender | undefined

/** For tests, which share the Worker's isolate: a sender that records, or fails. undefined removes it. */
export function setEmailSender(sender: EmailSender | undefined) {
  installed = sender
}

/** The configured sender, or undefined when this server can't send email (the default). */
export function emailSender(_env: Env): EmailSender | undefined {
  return installed
}

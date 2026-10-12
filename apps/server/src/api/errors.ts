/**
 * A Slack Web API error: answered as HTTP 200 `{ ok: false, error: code }`, as
 * Slack does, so clients branch on the code and never on the status.
 */
export class CampflareError extends Error {
  constructor(
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

/** invalid_arguments, with the detail Slack puts in response_metadata.messages. */
export const invalidArguments = (...messages: string[]) =>
  new CampflareError("invalid_arguments", { response_metadata: { messages: messages.map((m) => `[ERROR] ${m}`) } })

// Recording SFU exchanges for the offline fake SFU's fixtures.

/**
 * Addresses in SDP (this machine's, and the SFU's) give way to documentation
 * addresses in the fixtures. Only candidate and connection lines: the
 * fingerprint line also looks like hex separated by colons.
 */
export const scrub = (text: string) =>
  text.replace(/(a=candidate:[^\\]*|c=IN IP[46] [^\\]*)/g, (line) =>
    line
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (ip.startsWith("192.0.2.") ? ip : "192.0.2.1"))
      .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, "2001:db8::1"),
  )

export function recordingFetch(record: { operation: string; request?: unknown; status: number; response: unknown }[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const res = await fetch(input, init)
    const body = await res
      .clone()
      .json()
      .catch(() => undefined)
    const operation = `${init?.method ?? "GET"} ${url.replace(/^.*\/apps\/[^/]+/, "").replace(/\/sessions\/[^/]+\//, "/sessions/{id}/")}`
    record.push({
      operation,
      request: init?.body ? JSON.parse(String(init.body)) : undefined,
      status: res.status,
      response: body,
    })
    return res
  }
}

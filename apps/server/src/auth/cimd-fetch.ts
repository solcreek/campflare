// The network boundary for Client ID Metadata Documents: an MCP client's
// client_id is an HTTPS URL that the authorization server fetches, so a
// careless fetch is an SSRF hole.
//
// @better-auth/cimd asks for: resolve DNS once, reject RFC 6890 special-use
// addresses, pin the approved address, refuse redirects. A Worker can't pin
// an address (fetch resolves names itself), so this does what it can:
// - only https, only DNS names (no IP literals, no localhost/.local/.internal
//   or single-label hosts);
// - every A/AAAA answer, looked up over DNS-over-HTTPS, must be public;
// - redirects are returned, never followed; a timeout bounds each fetch.
// The window between our lookup and fetch's own is covered by the platform:
// assumption, not verified here — Workers' outbound fetch can't reach private
// networks. Under local `wrangler dev` it can, which is a development risk only.

export type Resolver = (hostname: string) => Promise<string[]>

const TIMEOUT_MS = 5_000

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".")
  if (parts.length !== 4) return undefined
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined
    n = n * 256 + Number(p)
  }
  return n
}

// IPv4 special-use blocks (RFC 6890 and the IANA registry), as [base, prefix length].
const V4_SPECIAL: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]

export function isPublicIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === undefined) return false
  return !V4_SPECIAL.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (n & mask) >>> 0 === (ipv4ToInt(base)! & mask) >>> 0
  })
}

/** Expands an IPv6 address to eight 16-bit groups, or undefined if it isn't one. */
function ipv6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "")
  if (s.includes("%")) return undefined // zone ids are link-local by definition
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two groups.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const n = ipv4ToInt(v4[1]!)
    if (n === undefined) return undefined
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split("::")
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail]
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined
  return groups.map((g) => Number.parseInt(g, 16))
}

/** Public IPv6: global unicast (2000::/3) outside its special-use blocks; mapped IPv4 judged as IPv4. */
export function isPublicIpv6(ip: string): boolean {
  const g = ipv6Groups(ip)
  if (!g) return false
  const [a = 0, b = 0] = g
  // ::ffff:0:0/96 — an IPv4 address in IPv6 clothing.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPublicIpv4(`${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`)
  }
  if ((a & 0xe000) !== 0x2000) return false // not 2000::/3: loopback, ULA, link-local, multicast, NAT64…
  if (a === 0x2001 && b < 0x0200) return false // 2001::/23 (IETF protocol assignments, Teredo, ORCHID…)
  if (a === 0x2001 && b === 0x0db8) return false // documentation
  if (a === 0x2002) return false // 6to4
  if (a === 0x3fff && b < 0x1000) return false // documentation (3fff::/20)
  return true
}

/** Why a URL may not be fetched, or undefined if it may. */
export function rejectUrl(url: URL): string | undefined {
  if (url.protocol !== "https:") return "only https"
  if (url.username || url.password) return "credentials in the URL"
  // "localhost." is localhost: a trailing dot (an absolute name) mustn't slip past the checks.
  const host = url.hostname.toLowerCase().replace(/\.$/, "")
  if (host.startsWith("[") || ipv4ToInt(host) !== undefined) return "an IP address, not a name"
  if (!host.includes(".")) return "a single-label host"
  if (/(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)$/.test(host)) return "a local name"
  return undefined
}

/** A/AAAA answers over DNS-over-HTTPS (Cloudflare's resolver). */
export const dohResolver: Resolver = async (hostname) => {
  const lookup = async (type: "A" | "AAAA") => {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`DNS lookup failed: HTTP ${res.status}`)
    const body = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] }
    // Only address records: CNAMEs in the chain are followed by the resolver.
    return (body.Answer ?? []).filter((a) => a.type === (type === "A" ? 1 : 28)).map((a) => a.data)
  }
  const [v4, v6] = await Promise.all([lookup("A"), lookup("AAAA")])
  return [...v4, ...v6]
}

export function createMetadataFetch(
  resolve: Resolver = dohResolver,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const rejected = rejectUrl(url)
    if (rejected) throw new Error(`refusing to fetch ${url.origin}: ${rejected}`)
    const addresses = await resolve(url.hostname)
    if (addresses.length === 0) throw new Error(`refusing to fetch ${url.origin}: no addresses`)
    const special = addresses.find((ip) => !(ip.includes(":") ? isPublicIpv6(ip) : isPublicIpv4(ip)))
    if (special) throw new Error(`refusing to fetch ${url.origin}: it resolves to ${special}`)
    return fetcher(url, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) })
  }
}

export const fetchClientMetadataResource = createMetadataFetch()

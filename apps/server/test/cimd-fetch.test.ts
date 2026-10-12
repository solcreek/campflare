import { describe, expect, it } from "vitest"
import { createMetadataFetch, isPublicIpv4, isPublicIpv6, rejectUrl } from "../src/auth/cimd-fetch"

describe("address checks", () => {
  it("accepts public IPv4 and refuses special-use ranges", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) expect(isPublicIpv4(ip)).toBe(true)
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "203.0.113.5",
      "224.0.0.1",
      "255.255.255.255",
      "300.1.1.1",
      "1.2.3",
    ]) {
      expect(isPublicIpv4(ip)).toBe(false)
    }
    expect(isPublicIpv4("172.32.0.1")).toBe(true)
  })

  it("accepts global IPv6 and refuses the rest", () => {
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "[2001:4860:4860::8888]"])
      expect(isPublicIpv6(ip)).toBe(true)
    for (const ip of [
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "64:ff9b::1.2.3.4",
      "2001:db8::1",
      "2001::1",
      "2002:c000:0204::1",
      "3fff::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "1::2::3",
      "zzzz::1",
      "1:2:3:4:5:6:7",
    ]) {
      expect(isPublicIpv6(ip)).toBe(false)
    }
    expect(isPublicIpv6("::ffff:1.1.1.1")).toBe(true)
    expect(isPublicIpv6("::ffff:999.1.1.1")).toBe(false)
  })
})

describe("URL checks", () => {
  it("allows https DNS names only", () => {
    expect(rejectUrl(new URL("https://client.example.com/oauth.json"))).toBeUndefined()
    expect(rejectUrl(new URL("http://client.example.com/x"))).toBe("only https")
    expect(rejectUrl(new URL("https://u:p@client.example.com/x"))).toBe("credentials in the URL")
    expect(rejectUrl(new URL("https://127.0.0.1/x"))).toBe("an IP address, not a name")
    expect(rejectUrl(new URL("https://[::1]/x"))).toBe("an IP address, not a name")
    expect(rejectUrl(new URL("https://intranet/x"))).toBe("a single-label host")
    // A trailing dot doesn't hide a name.
    expect(rejectUrl(new URL("https://localhost./x"))).toBe("a single-label host")
    expect(rejectUrl(new URL("https://printer.local./x"))).toBe("a local name")
    for (const host of ["app.localhost", "printer.local", "svc.internal", "nas.home.arpa"]) {
      expect(rejectUrl(new URL(`https://${host}/x`))).toBe("a local name")
    }
  })
})

const ok = async () => new Response("{}")

describe("createMetadataFetch", () => {
  it("fetches public names without following redirects", async () => {
    const seen: RequestInit[] = []
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init!)
      return new Response(null, { status: 302, headers: { location: "https://10.0.0.1/" } })
    }) as typeof fetch
    const f = createMetadataFetch(async () => ["93.184.216.34", "2606:2800:220:1::1"], fetcher)
    const res = await f("https://client.example.com/oauth.json")
    expect(res.status).toBe(302) // returned to the caller, not followed
    expect(seen[0]!.redirect).toBe("manual")
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  it("refuses names that resolve anywhere special, or nowhere", async () => {
    await expect(
      createMetadataFetch(async () => ["93.184.216.34", "10.0.0.5"], ok as typeof fetch)("https://a.example.com/"),
    ).rejects.toThrow("it resolves to 10.0.0.5")
    await expect(
      createMetadataFetch(async () => ["::1"], ok as typeof fetch)("https://a.example.com/"),
    ).rejects.toThrow("it resolves to ::1")
    await expect(createMetadataFetch(async () => [], ok as typeof fetch)("https://a.example.com/")).rejects.toThrow(
      "no addresses",
    )
    await expect(
      createMetadataFetch(async () => ["1.1.1.1"], ok as typeof fetch)(new Request("http://a.example.com/")),
    ).rejects.toThrow("only https")
  })
})

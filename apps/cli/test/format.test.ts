import { describe, expect, it } from "vitest"
import { deliveryLines, messageLine, plain, time } from "../src/format"
import { matchUsers } from "../src/resolve"

describe("plain", () => {
  it("renders mrkdwn entities for a terminal", () => {
    const names = new Map([["U1", "bob"]])
    expect(
      plain(
        "<@U1> <@U2|carol> <@U3> <#C1|dev> <#C2> <!here> <https://x.test|site> <https://y.test> &lt;&gt;&amp;",
        names,
      ),
    ).toBe("@bob @carol @U3 #dev #C2 @here site (https://x.test) https://y.test <>&")
    expect(plain("<@U1>")).toBe("@U1")
  })
})

describe("messageLine", () => {
  it("names bots and counts replies and files", () => {
    const names = new Map<string, string>()
    expect(messageLine({ ts: "0", username: "CI", text: "x", reply_count: 2 }, names)).toMatch(/CI: x \(2 replies\)$/)
    expect(messageLine({ ts: "0", bot_profile: { name: "Robot" }, files: [{}] }, names)).toMatch(/Robot: \[file\]$/)
    expect(messageLine({ ts: "0" }, names)).toMatch(/bot:$/)
  })
})

describe("matchUsers", () => {
  const users = [
    { id: "U1", name: "sam", real_name: "Sam Smith" },
    { id: "U2", name: "samantha", profile: { display_name: "Sammy", real_name: "Samantha Jones" } },
    { id: "U3", name: "gone", deleted: true },
  ]
  it("prefers an exact name, then unique word prefixes, and skips the deactivated", () => {
    expect(matchUsers(users, "sam").map((u) => u.id)).toEqual(["U1"])
    expect(matchUsers(users, "sammy").map((u) => u.id)).toEqual(["U2"])
    expect(matchUsers(users, "jon").map((u) => u.id)).toEqual(["U2"])
    expect(matchUsers(users, "gone")).toEqual([])
  })
})

describe("deliveryLines", () => {
  const window = { window_minutes: 60, attempts: 0, failures: 0, pending: 0 }
  const at = 1_760_000_000

  it("says nothing before the first delivery", () => {
    expect(deliveryLines({})).toEqual([])
    expect(deliveryLines({ disabled: null, delivery: { last_attempt: null, ...window } })).toEqual([])
  })

  it("shows the last attempt and the hour's counts", () => {
    const timedOut = { at, ok: false, status: 0, reason: "http_timeout" }
    expect(
      deliveryLines({ delivery: { last_attempt: timedOut, ...window, attempts: 4, failures: 3, pending: 1 } }),
    ).toEqual([
      `Last delivery: ${time(String(at))}, no answer (http_timeout)`,
      "Last 60 min: 4 attempts, 3 failed, 1 waiting to retry",
    ])
    const refused = { at, ok: false, status: 502, reason: "http_error" }
    expect(deliveryLines({ delivery: { last_attempt: refused, ...window } })[0]).toBe(
      `Last delivery: ${time(String(at))}, HTTP 502`,
    )
  })

  it("says when delivery was turned off, why, and how to turn it back on", () => {
    expect(deliveryLines({ disabled: { at, reason: "100% of 20 attempts failed" } })).toEqual([
      `Event delivery: OFF since ${time(String(at))}: 100% of 20 attempts failed`,
      "  Set the Request URL again (--request-url) to turn it back on.",
    ])
  })
})

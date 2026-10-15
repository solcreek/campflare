import { describe, expect, it } from "vitest"
import { emojiChar, emojiLook, parse, parseInline, plainText, unescape } from "../src/mrkdwn"

describe("parseInline", () => {
  it("reads mentions, channels, links and broadcasts", () => {
    expect(parseInline("hi <@U1>, see <#C1|dev> and <https://x.test/?a=1&amp;b=2|the docs> <!here>")).toEqual([
      { type: "text", text: "hi " },
      { type: "user", id: "U1", label: undefined },
      { type: "text", text: ", see " },
      { type: "channel", id: "C1", label: "dev" },
      { type: "text", text: " and " },
      { type: "link", url: "https://x.test/?a=1&b=2", label: "the docs" },
      { type: "text", text: " " },
      { type: "broadcast", name: "here" },
    ])
    expect(parseInline("<!subteam^S1|@ops> <!date^1|fallback>")).toEqual([
      { type: "usergroup", id: "S1", label: "ops" },
      { type: "text", text: " fallback" },
    ])
    expect(parseInline("<!subteam^S2> <!subteam^S3|équipe>")).toEqual([
      { type: "usergroup", id: "S2", label: undefined },
      { type: "text", text: " " },
      { type: "usergroup", id: "S3", label: "équipe" },
    ])
    expect(parseInline("<mailto:a@x.test>")).toEqual([{ type: "link", url: "mailto:a@x.test", label: undefined }])
  })

  it("reads bold, italic, strike and code, nested, at word boundaries only", () => {
    expect(parseInline("*bold _and italic_* ~gone~ `a *b* &lt;c&gt;`")).toEqual([
      {
        type: "bold",
        children: [
          { type: "text", text: "bold " },
          { type: "italic", children: [{ type: "text", text: "and italic" }] },
        ],
      },
      { type: "text", text: " " },
      { type: "strike", children: [{ type: "text", text: "gone" }] },
      { type: "text", text: " " },
      { type: "code", text: "a *b* <c>" },
    ])
    expect(parseInline("snake_case_name and 2*3*4")).toEqual([{ type: "text", text: "snake_case_name and 2*3*4" }])
  })

  it("keeps text in every script intact", () => {
    for (const text of ["大家早安", "皆さん、おはようございます", "좋은 아침입니다", "Buenos días", "Grüße à tous"])
      expect(parseInline(text)).toEqual([{ type: "text", text }])
    expect(parseInline("*早安* _bonjour_")).toEqual([
      { type: "bold", children: [{ type: "text", text: "早安" }] },
      { type: "text", text: " " },
      { type: "italic", children: [{ type: "text", text: "bonjour" }] },
    ])
  })

  it("reads emoji shortcodes", () => {
    expect(parseInline("ship it :rocket::tada:")).toEqual([
      { type: "text", text: "ship it " },
      { type: "emoji", name: "rocket" },
      { type: "emoji", name: "tada" },
    ])
    expect(emojiChar("rocket")).toBe("🚀")
    expect(emojiChar("not_an_emoji")).toBeUndefined()
  })
})

describe("parse", () => {
  it("splits paragraphs, quotes and code blocks", () => {
    expect(parse("intro\n&gt; quoted\n&gt; more\nafter\n```\nconst a = 1 &lt; 2\n```\ntail")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "intro" }] },
      { type: "quote", children: [{ type: "text", text: "quoted\nmore" }] },
      { type: "paragraph", children: [{ type: "text", text: "after" }] },
      { type: "pre", text: "const a = 1 < 2" },
      { type: "paragraph", children: [{ type: "text", text: "tail" }] },
    ])
  })

  it("leaves an unclosed fence as text, and skips blank paragraphs", () => {
    expect(parse("a ```b")).toEqual([{ type: "paragraph", children: [{ type: "text", text: "a ```b" }] }])
    expect(parse("")).toEqual([])
  })
})

describe("plainText", () => {
  it("flattens markup with names filled in", () => {
    const text =
      "*Hi* <@U1> in <#C1> about <https://x.test|this> and <https://y.test> <!channel> :fire: :nope: `x`\n```code```"
    expect(plainText(text, { user: () => "alex", channel: () => "dev" })).toBe(
      "Hi @alex in #dev about this and https://y.test @channel 🔥 :nope: x\ncode",
    )
    expect(plainText("<@U1|ada> <#C1> _it_ ~st~")).toBe("@ada #C1 it st")
    expect(
      plainText("<!subteam^S1|@ops> <!subteam^S2> <!subteam^S3>", {
        usergroup: (id) => (id === "S2" ? "設計" : undefined),
      }),
    ).toBe("@ops @設計 @S3")
  })

  it("unescapes entities once", () => {
    expect(unescape("&amp;lt; &lt;b&gt;")).toBe("&lt; <b>")
  })
})

describe("emojiLook", () => {
  const custom = {
    fiesta: "https://x.test/emoji/T1/aa.png",
    matsuri: "alias:fiesta",
    again: "alias:matsuri",
    yay: "alias:+1",
    lost: "alias:nowhere",
    odd: "javascript:alert(1)",
    loop: "alias:loop",
  }

  it("draws standard emoji as characters and custom ones as images, through aliases", () => {
    expect(emojiLook(custom, "tada")).toEqual({ char: "🎉" })
    expect(emojiLook(custom, "fiesta")).toEqual({ url: custom.fiesta })
    expect(emojiLook(custom, "matsuri")).toEqual({ url: custom.fiesta })
    expect(emojiLook(custom, "again")).toEqual({ url: custom.fiesta })
    expect(emojiLook(custom, "yay")).toEqual({ char: "👍" })
  })

  it("knows nothing of unknown names, broken aliases, loops or URLs that aren't http(s)", () => {
    for (const name of ["nope", "lost", "odd", "loop"]) expect(emojiLook(custom, name)).toBeUndefined()
  })

  it("never finds Object.prototype's members, in either table", () => {
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]
    for (const name of names) {
      expect(emojiChar(name)).toBeUndefined()
      expect(emojiLook(custom, name)).toBeUndefined()
      expect(emojiLook({ trap: `alias:${name}` }, "trap")).toBeUndefined()
    }
    expect(plainText(":__proto__: :constructor: :tostring:")).toBe(":__proto__: :constructor: :tostring:")
  })
})

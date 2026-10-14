import { describe, expect, it } from "vitest"
import { parseMarkdown, parseMarkdownInline } from "../src/markdown"

const text = (t: string) => ({ type: "text", text: t })

describe("parseMarkdownInline", () => {
  it("reads bold, italic, strike, code and links", () => {
    expect(parseMarkdownInline("**bold *and italic* too** __also__ ~~gone~~ `a **b** <c>`")).toEqual([
      {
        type: "bold",
        children: [text("bold "), { type: "italic", children: [text("and italic")] }, text(" too")],
      },
      text(" "),
      { type: "bold", children: [text("also")] },
      text(" "),
      { type: "strike", children: [text("gone")] },
      text(" "),
      { type: "code", text: "a **b** <c>" },
    ])
    expect(parseMarkdownInline("_it_ [the docs](https://x.test/a?b=1) <https://y.test> see https://z.test/p.")).toEqual(
      [
        { type: "italic", children: [text("it")] },
        text(" "),
        { type: "link", url: "https://x.test/a?b=1", label: "the docs" },
        text(" "),
        { type: "link", url: "https://y.test", label: undefined },
        text(" see "),
        { type: "link", url: "https://z.test/p" },
        text("."),
      ],
    )
  })

  it("reads Slack's mentions and emoji, and leaves snake_case and arithmetic alone", () => {
    expect(parseMarkdownInline("hi <@U1> :wave: snake_case_name 2*3*4 a & b")).toEqual([
      text("hi "),
      { type: "user", id: "U1", label: undefined },
      text(" "),
      { type: "emoji", name: "wave" },
      text(" snake_case_name 2*3*4 a & b"),
    ])
  })

  it("keeps text in every script, and marks it up", () => {
    for (const t of ["大家早安", "皆さん、おはようございます", "좋은 아침입니다", "Buenos días", "Grüße à tous"])
      expect(parseMarkdownInline(t)).toEqual([text(t)])
    expect(parseMarkdownInline("**早安** **안녕** *bonjour* **Grüße**")).toEqual([
      { type: "bold", children: [text("早安")] },
      text(" "),
      { type: "bold", children: [text("안녕")] },
      text(" "),
      { type: "italic", children: [text("bonjour")] },
      text(" "),
      { type: "bold", children: [text("Grüße")] },
    ])
  })

  it("reads what has streamed in so far as text", () => {
    expect(parseMarkdownInline("**unfinished")).toEqual([text("**unfinished")])
    expect(parseMarkdownInline("[half](https://x")).toEqual([text("[half]("), { type: "link", url: "https://x" }])
  })
})

describe("parseMarkdown", () => {
  it("reads headings, paragraphs, lists, quotes, fences and rules", () => {
    const source = [
      "# Title #",
      "Some *text*",
      "on two lines.",
      "",
      "- one",
      "- two",
      "  goes on",
      "* three",
      "",
      "3. third",
      "4) fourth",
      "> quoted",
      "> more",
      "---",
      "```ts",
      "const a = **1**",
      "```",
      "### Small",
      "after",
    ].join("\n")
    expect(parseMarkdown(source)).toEqual([
      { type: "heading", level: 1, children: [text("Title")] },
      {
        type: "paragraph",
        children: [text("Some "), { type: "italic", children: [text("text")] }, text("\non two lines.")],
      },
      { type: "list", ordered: false, start: 1, items: [[text("one")], [text("two\ngoes on")], [text("three")]] },
      { type: "list", ordered: true, start: 3, items: [[text("third")], [text("fourth")]] },
      { type: "quote", children: [text("quoted\nmore")] },
      { type: "rule" },
      { type: "pre", text: "const a = **1**" },
      { type: "heading", level: 3, children: [text("Small")] },
      { type: "paragraph", children: [text("after")] },
    ])
  })

  it("ends a paragraph at a block, and a list at a line that isn't its own", () => {
    expect(parseMarkdown("para\n- item\nnot indented")).toEqual([
      { type: "paragraph", children: [text("para")] },
      { type: "list", ordered: false, start: 1, items: [[text("item")]] },
      { type: "paragraph", children: [text("not indented")] },
    ])
    expect(parseMarkdown("1. a\n- b")).toEqual([
      { type: "list", ordered: true, start: 1, items: [[text("a")]] },
      { type: "list", ordered: false, start: 1, items: [[text("b")]] },
    ])
  })

  it("shows an unclosed fence as code to the end, as it streams", () => {
    expect(parseMarkdown("Look:\n```\nline 1\nline 2")).toEqual([
      { type: "paragraph", children: [text("Look:")] },
      { type: "pre", text: "line 1\nline 2" },
    ])
    expect(parseMarkdown("")).toEqual([])
  })
})

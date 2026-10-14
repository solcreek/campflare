import { describe, expect, it } from "vitest"
import { planOf, richTextPlain, taskOf } from "../src/tasks"

const rich = (...sections: unknown[][]) => ({
  type: "rich_text",
  elements: sections.map((elements) => ({ type: "rich_text_section", elements })),
})

describe("task_card and plan blocks", () => {
  it("reads a task card's title, status, details, output and sources", () => {
    expect(
      taskOf({
        type: "task_card",
        task_id: "t1",
        title: "Recherche",
        status: "complete",
        details: rich([
          { type: "text", text: "Requête: " },
          { type: "text", text: "été" },
        ]),
        output: rich(
          [
            { type: "text", text: "見つけた " },
            { type: "emoji", name: "tada" },
          ],
          [
            { type: "link", url: "https://example.com/es" },
            { type: "link", url: "https://example.com", text: "aquí" },
          ],
        ),
        sources: [
          { type: "url", url: "https://example.com/ko", text: "한국어" },
          { type: "url", url: "https://example.com/blank", text: "" },
          { type: "url", url: "javascript:alert(1)", text: "no" },
          "nope",
        ],
      }),
    ).toEqual({
      id: "t1",
      title: "Recherche",
      status: "complete",
      details: "Requête: été",
      output: "見つけた :tada:\nhttps://example.com/esaquí",
      sources: [
        { url: "https://example.com/ko", text: "한국어" },
        { url: "https://example.com/blank", text: "https://example.com/blank" },
      ],
    })
  })

  it("fills in what a task card leaves out, and refuses what isn't one", () => {
    expect(taskOf({ type: "task_card", task_id: "t", status: "sleeping" })).toEqual({
      id: "t",
      title: "",
      status: "pending",
      sources: [],
    })
    expect(taskOf({ type: "task_card", details: rich([]), status: "error" })).toBeUndefined()
    expect(taskOf({ type: "section" })).toBeUndefined()
    expect(taskOf(null)).toBeUndefined()
    expect(richTextPlain(42)).toBe("")
  })

  it("reads a plan's title and its tasks in order", () => {
    expect(
      planOf({
        type: "plan",
        title: "Plan de travail",
        tasks: [
          { type: "task_card", task_id: "a", title: "Lire", status: "complete" },
          { type: "divider" },
          { type: "task_card", task_id: "b", title: "書く", status: "in_progress" },
        ],
      }),
    ).toEqual({
      title: "Plan de travail",
      tasks: [
        { id: "a", title: "Lire", status: "complete", sources: [] },
        { id: "b", title: "書く", status: "in_progress", sources: [] },
      ],
    })
    expect(planOf({ type: "plan" })).toEqual({ title: "", tasks: [] })
    expect(planOf({ type: "task_card" })).toBeUndefined()
  })
})

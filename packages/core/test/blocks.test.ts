import { describe, expect, it } from "vitest"
import { interactiveBlocks } from "../src/index"

const text = (t: string) => ({ type: "plain_text", text: t })

describe("interactiveBlocks", () => {
  it("finds the buttons of actions blocks and the feedback buttons of context_actions blocks", () => {
    expect(
      interactiveBlocks([
        { type: "section", block_id: "s", text: { type: "mrkdwn", text: "Ship it?" } },
        {
          type: "actions",
          block_id: "decide",
          elements: [
            { type: "button", action_id: "ok", text: text("Approve"), value: "pr-42", style: "primary" },
            {
              type: "button",
              action_id: "no",
              text: text("Reject"),
              style: "danger",
              accessibility_label: "Reject PR",
            },
            { type: "button", action_id: "docs", text: text("Docs"), url: "https://docs.example/" },
            { type: "button", action_id: "odd", text: text("Odd"), style: "fancy", url: "javascript:alert(1)" },
            { type: "static_select", action_id: "pick" },
            { type: "button", text: text("No id") },
          ],
        },
        {
          type: "context_actions",
          block_id: "rate",
          elements: [
            {
              type: "feedback_buttons",
              action_id: "fb",
              positive_button: { text: text("Good"), value: "up", accessibility_label: "Good answer" },
              negative_button: { text: text("Bad"), value: "down" },
            },
            { type: "feedback_buttons", action_id: "half", positive_button: { text: text("Good"), value: "up" } },
            { type: "icon_button", action_id: "icon" },
          ],
        },
      ]),
    ).toEqual([
      {
        type: "actions",
        blockId: "decide",
        buttons: [
          { actionId: "ok", label: "Approve", value: "pr-42", style: "primary" },
          { actionId: "no", label: "Reject", accessibilityLabel: "Reject PR", style: "danger" },
          { actionId: "docs", label: "Docs", url: "https://docs.example/" },
          { actionId: "odd", label: "Odd" },
        ],
      },
      {
        type: "feedback",
        blockId: "rate",
        actionId: "fb",
        positive: { label: "Good", value: "up", accessibilityLabel: "Good answer" },
        negative: { label: "Bad", value: "down" },
      },
    ])
  })

  it("finds nothing in messages without them", () => {
    expect(interactiveBlocks(undefined)).toEqual([])
    expect(interactiveBlocks("nope")).toEqual([])
    expect(
      interactiveBlocks([
        null,
        { type: "actions", elements: [{ type: "button", action_id: "x" }] },
        { type: "actions", block_id: "empty", elements: [] },
        { type: "actions", block_id: "bad", elements: "x" },
      ]),
    ).toEqual([])
  })
})

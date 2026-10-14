import { describe, expect, it } from "vitest"
import { formField, initialValues, interactiveBlocks, type View } from "../src/index"

const text = (t: string) => ({ type: "plain_text", text: t })
const option = (t: string, value: string) => ({ text: text(t), value })

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
            { type: "datepicker", action_id: "when" },
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
        elements: [
          { kind: "button", actionId: "ok", label: "Approve", value: "pr-42", style: "primary" },
          { kind: "button", actionId: "no", label: "Reject", accessibilityLabel: "Reject PR", style: "danger" },
          { kind: "button", actionId: "docs", label: "Docs", url: "https://docs.example/" },
          { kind: "button", actionId: "odd", label: "Odd" },
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

  it("finds select menus, overflow menus and icon buttons, in actions blocks and as a section's accessory", () => {
    expect(
      interactiveBlocks([
        {
          type: "section",
          block_id: "pick",
          text: { type: "mrkdwn", text: "Where?" },
          accessory: {
            type: "static_select",
            action_id: "env",
            placeholder: text("Choose"),
            option_groups: [
              { label: text("Live"), options: [{ ...option("Production", "prod"), description: text("Careful") }] },
            ],
            options: [option("Staging", "staging")],
            initial_option: option("Staging", "staging"),
          },
        },
        { type: "section", block_id: "plain", text: { type: "mrkdwn", text: "x" }, accessory: { type: "image" } },
        {
          type: "actions",
          block_id: "more",
          elements: [
            { type: "users_select", action_id: "who", initial_user: "U1" },
            { type: "conversations_select", action_id: "where" },
            { type: "channels_select", action_id: "chan", initial_channel: "C1" },
            { type: "overflow", action_id: "menu", options: [option("Silenciar", "mute")] },
            {
              type: "icon_button",
              action_id: "trash",
              icon: "trash",
              text: text("Delete"),
              value: "d1",
              accessibility_label: "Delete it",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        type: "actions",
        blockId: "pick",
        elements: [
          {
            kind: "select",
            actionId: "env",
            select: "static",
            placeholder: "Choose",
            options: [
              { label: "Staging", value: "staging" },
              { label: "Production", value: "prod", description: "Careful", group: "Live" },
            ],
            initial: "staging",
          },
        ],
      },
      {
        type: "actions",
        blockId: "more",
        elements: [
          { kind: "select", actionId: "who", select: "users", options: [], initial: "U1" },
          { kind: "select", actionId: "where", select: "conversations", options: [] },
          { kind: "select", actionId: "chan", select: "channels", options: [], initial: "C1" },
          { kind: "overflow", actionId: "menu", options: [{ label: "Silenciar", value: "mute" }] },
          {
            kind: "icon",
            actionId: "trash",
            icon: "trash",
            label: "Delete",
            accessibilityLabel: "Delete it",
            value: "d1",
          },
        ],
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

describe("a view's form", () => {
  const input = (block_id: string, element: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "input",
    block_id,
    label: text(block_id),
    element: { action_id: "a", ...element },
    ...extra,
  })
  const view: View = {
    id: "V1",
    type: "modal",
    blocks: [
      { type: "section", block_id: "intro", text: { type: "mrkdwn", text: "Hi" } },
      input(
        "note",
        { type: "plain_text_input", multiline: true, placeholder: text("Say"), max_length: 40, initial_value: "x" },
        { hint: text("Short"), optional: true },
      ),
      input("mail", { type: "email_text_input", min_length: 3 }),
      input("env", {
        type: "static_select",
        options: [option("Prod", "prod")],
        initial_option: option("Prod", "prod"),
      }),
      input("who", { type: "users_select", initial_user: "U1" }),
      input("checks", {
        type: "checkboxes",
        options: [option("A", "a"), option("B", "b")],
        initial_options: [option("B", "b")],
      }),
      input("none", { type: "checkboxes", options: [option("A", "a")] }),
      input("speed", {
        type: "radio_buttons",
        options: [option("Fast", "fast")],
        initial_option: option("Fast", "fast"),
      }),
      input("day", { type: "datepicker", initial_date: "2026-10-14" }),
      input("later", { type: "datepicker" }),
      input("rich", { type: "rich_text_input" }),
      { type: "input", block_id: "broken", element: "x" },
    ],
  }

  it("describes each input as the UI draws it", () => {
    expect(view.blocks.map(formField)).toEqual([
      undefined,
      {
        blockId: "note",
        actionId: "a",
        label: "note",
        hint: "Short",
        optional: true,
        kind: "text",
        multiline: true,
        inputType: "text",
        placeholder: "Say",
        maxLength: 40,
        initial: "x",
      },
      {
        blockId: "mail",
        actionId: "a",
        label: "mail",
        optional: false,
        kind: "text",
        multiline: false,
        inputType: "email",
        minLength: 3,
      },
      expect.objectContaining({
        kind: "select",
        select: "static",
        initial: "prod",
        options: [{ label: "Prod", value: "prod" }],
      }),
      expect.objectContaining({ kind: "select", select: "users", initial: "U1", options: [] }),
      expect.objectContaining({ kind: "checkboxes", initial: ["b"] }),
      expect.objectContaining({ kind: "checkboxes", initial: [] }),
      expect.objectContaining({ kind: "radio", initial: "fast" }),
      expect.objectContaining({ kind: "date", initial: "2026-10-14" }),
      expect.objectContaining({ kind: "date" }),
      expect.objectContaining({ kind: "unsupported", type: "rich_text_input" }),
      undefined,
    ])
  })

  it("starts from the view's initial values", () => {
    expect(initialValues(view)).toEqual({
      note: { a: "x" },
      env: { a: "prod" },
      who: { a: "U1" },
      checks: { a: ["b"] },
      speed: { a: "fast" },
      day: { a: "2026-10-14" },
    })
  })
})

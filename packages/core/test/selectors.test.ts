import { describe, expect, it } from "vitest"
import {
  browsableChannels,
  conversationTitle,
  displayName,
  sidebar,
  thread,
  threadStatus,
  timeline,
} from "../src/selectors"
import { initialState, reduce, type WorkspaceState } from "../src/state"

const state: WorkspaceState = reduce(initialState, {
  type: "ready",
  self: { url: "https://x.test", userId: "U1", teamId: "T1", teamName: "Team" },
  users: [
    { id: "U1", name: "alex", real_name: "Alex Rivera" },
    { id: "U2", name: "vincent", real_name: "Vincent Vega", profile: { display_name: "vinny" } },
    { id: "U3", name: "ada" },
  ],
  conversations: [
    { id: "C1", name: "general", is_channel: true, is_member: true },
    { id: "C2", name: "dev", is_channel: true, is_member: true },
    { id: "C3", name: "random", is_channel: true, is_member: false },
    { id: "C4", name: "secret", is_channel: true, is_private: true, is_member: false },
    { id: "C5", name: "old", is_channel: true, is_member: true, is_archived: true },
    { id: "D1", is_im: true, user: "U2" },
    { id: "G1", name: "mpdm-alex--vincent--ada-1", is_mpim: true },
    { id: "G2", name: "mpdm-x", is_mpim: true, members: ["U1", "U3"] },
  ],
})

describe("selectors", () => {
  it("names people and conversations", () => {
    expect(displayName(state.users.U2)).toBe("vinny")
    expect(displayName(state.users.U1)).toBe("Alex Rivera")
    expect(displayName(state.users.U3)).toBe("ada")
    expect(displayName({ id: "U9", name: "n", profile: { real_name: "Pro File" } })).toBe("Pro File")
    expect(displayName(undefined)).toBe("unknown")
    expect(conversationTitle(state, state.conversations.C1!)).toBe("general")
    expect(conversationTitle(state, state.conversations.D1!)).toBe("vinny")
    expect(conversationTitle(state, { id: "D2", is_im: true })).toBe("unknown")
    expect(conversationTitle(state, state.conversations.G1!)).toBe("vincent, ada")
    expect(conversationTitle(state, state.conversations.G2!)).toBe("ada")
    expect(conversationTitle(state, { id: "C9" })).toBe("C9")
    expect(conversationTitle({ ...state, self: undefined }, { id: "G3", is_mpim: true })).toBe("")
  })

  it("lists your conversations and the channels you could join", () => {
    const s = sidebar(state)
    expect(s.channels.map((c) => c.id)).toEqual(["C2", "C1"])
    expect(s.directMessages.map((c) => c.id)).toEqual(["G2", "G1", "D1"])
    expect(browsableChannels(state).map((c) => c.id)).toEqual(["C3"])
  })

  it("reads a timeline and a thread", () => {
    let s = reduce(state, {
      type: "replies",
      channel: "C1",
      threadTs: "0000000100.000000",
      messages: [
        { ts: "0000000100.000000", channel: "C1", thread_ts: "0000000100.000000" },
        { ts: "0000000110.000000", channel: "C1", thread_ts: "0000000100.000000" },
      ],
    })
    expect(thread(s, "C1", "0000000100.000000").map((m) => m.ts)).toEqual(["0000000100.000000", "0000000110.000000"])
    expect(timeline(s, "C1")).toEqual([])
    s = { ...s, messages: {} }
    expect(thread(s, "C1", "0000000100.000000")).toEqual([])
  })
})

describe("threadStatus", () => {
  it("gives a thread's status until it expires", () => {
    const statuses = { "C1/0000000100.000000": { user: "UBOT", status: "is thinking", expires: 200 } }
    expect(threadStatus(statuses, "C1", "0000000100.000000", 199)?.status).toBe("is thinking")
    expect(threadStatus(statuses, "C1", "0000000100.000000", 200)).toBeUndefined()
    expect(threadStatus(statuses, "C1", "0000000999.000000", 0)).toBeUndefined()
  })
})

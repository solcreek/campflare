import { createWorkspace, type Message } from "@campflare/core"
import { fakeApi, FakeSocket, type FakeApi, type Handler } from "@campflare/core/testing"

// A small workspace on the scripted Web API: alex (you) and vincent, #general
// and #dev you're in, #random you aren't, and a DM with vincent.

export const ALEX = "U1"
export const VINCENT = "U2"

export interface FakeServer {
  api: FakeApi
  /** Pushes an RTM event to the app, as the server would. */
  push(event: Record<string, unknown>): void
  connect: () => ReturnType<typeof createWorkspace>
}

export function fakeServer(overrides: Record<string, Handler> = {}): FakeServer {
  const history: Record<string, Message[]> = {
    CGEN: [
      {
        ts: "1700000200.000000",
        channel: "CGEN",
        user: VINCENT,
        text: "*Hi* <@U1>, see <#CDEV>",
        reply_count: 1,
        reply_users: [ALEX],
        reactions: [{ name: "eyes", users: [VINCENT], count: 1 }],
      },
      { ts: "1700000100.000000", channel: "CGEN", user: ALEX, text: "first" },
      {
        ts: "1700000050.000000",
        channel: "CGEN",
        user: VINCENT,
        subtype: "channel_join",
        text: "<@U2> has joined the channel",
      },
    ],
    CDEV: [],
  }
  let seq = 0
  const handlers: Record<string, Handler> = {
    "auth.test": () => ({ user_id: ALEX, team_id: "T1", team: "Test Team" }),
    "team.info": () => ({ team: { name: "Test Team" } }),
    "users.list": () => ({
      members: [
        { id: ALEX, name: "alex", real_name: "Alex Rivera" },
        { id: VINCENT, name: "vincent", real_name: "Vincent Vega" },
      ],
    }),
    "conversations.list": () => ({
      channels: [
        {
          id: "CGEN",
          name: "general",
          is_channel: true,
          is_general: true,
          is_member: true,
          topic: { value: "Company-wide" },
        },
        { id: "CDEV", name: "dev", is_channel: true, is_member: true },
        { id: "CRND", name: "random", is_channel: true, is_member: false },
        { id: "D1", is_im: true, user: VINCENT },
      ],
    }),
    "rtm.connect": () => ({ url: "wss://rtm.test" }),
    "conversations.history": (args) => ({
      messages: history[args.channel!] ?? [],
      has_more: args.channel === "CGEN" && !args.latest,
    }),
    "conversations.replies": () => ({
      messages: [
        history.CGEN![0],
        { ts: "1700000300.000000", user: ALEX, text: "a reply", thread_ts: "1700000200.000000" },
      ],
    }),
    "conversations.mark": () => ({}),
    "chat.postMessage": (args) => {
      const ts = `1700001${String(++seq).padStart(3, "0")}.000000`
      return {
        ts,
        message: { ts, user: ALEX, text: args.text, ...(args.thread_ts ? { thread_ts: args.thread_ts } : {}) },
      }
    },
    "chat.update": (args) => ({
      message: { ts: args.ts, user: ALEX, text: args.text, edited: { user: ALEX, ts: "1" } },
    }),
    "chat.delete": () => ({}),
    "reactions.add": () => ({}),
    "reactions.remove": () => ({}),
    "conversations.join": (args) => ({ channel: { id: args.channel, name: "random", is_channel: true } }),
    "conversations.create": (args) => ({ channel: { id: "CNEW", name: args.name, is_channel: true } }),
    ...overrides,
  }
  const api = fakeApi(handlers)
  return {
    api,
    push(event) {
      FakeSocket.all.at(-1)?.receive(event)
    },
    connect: () => createWorkspace({ client: api.client, WebSocket: FakeSocket as unknown as typeof WebSocket }),
  }
}

/** Says hello on the newest socket, so the workspace counts as connected. */
export function hello() {
  FakeSocket.all.at(-1)?.receive({ type: "hello" })
}

export { FakeSocket }

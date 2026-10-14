import { describe, expect, it } from "vitest"
import { call, connect, expectError, ok, settle, workspace, type Workspace } from "./helpers"

type Started = { channel: string; ts: string }
type Stopped = Started & { message: Record<string, unknown> }
type Messages = { messages: Record<string, unknown>[] }
type Frame = Record<string, unknown>

const isMessage = (subtype?: string) => (f: Frame) => f.type === "message" && f.subtype === subtype

/** A workspace, its app, a question in #general to answer in its thread, and the owner's RTM link. */
async function setup() {
  const w = await workspace()
  const app = await w.addApp("Answer Bot")
  const question = await ok<Started>("chat.postMessage", { channel: w.general, text: "why?" }, w.owner.token)
  const link = await connect((await ok<{ url: string }>("rtm.connect", {}, w.owner.token)).url)
  await link.next((f) => f.type === "hello")
  const recipient = { recipient_user_id: w.owner.id, recipient_team_id: w.teamId }
  return { w, app, question, link, recipient }
}

const reply = async (w: Workspace, ts: string) =>
  (await ok<Messages>("conversations.replies", { channel: w.general, ts }, w.owner.token)).messages

describe("chat.startStream, appendStream and stopStream", () => {
  it("posts a message in the thread and grows it, announcing each change", async () => {
    const { w, app, question, link, recipient } = await setup()
    const started = await ok<Started>(
      "chat.startStream",
      { channel: w.general, thread_ts: question.ts, markdown_text: "**Because**", ...recipient },
      app.botToken,
    )
    expect(started).toEqual({ ok: true, channel: w.general, ts: expect.stringMatching(/^\d{10}\.\d{6}$/) })
    expect(await link.next(isMessage())).toMatchObject({
      ts: started.ts,
      thread_ts: question.ts,
      user: app.botUserId,
      bot_id: app.botId,
      text: "**Because**",
      blocks: [{ type: "markdown", text: "**Because**" }],
      streaming_state: "in_progress",
    })

    await ok("chat.appendStream", { channel: w.general, ts: started.ts, markdown_text: " it's late." }, app.botToken)
    const changed = await link.next(isMessage("message_changed"))
    expect(changed).toMatchObject({
      channel: w.general,
      message: { ts: started.ts, text: "**Because** it's late.", streaming_state: "in_progress" },
      previous_message: { text: "**Because**" },
    })
    expect((changed.message as Frame).edited).toBeUndefined()

    const feedback = [{ type: "context_actions", elements: [{ type: "feedback_buttons", action_id: "fb" }] }]
    const stopped = await ok<Stopped>(
      "chat.stopStream",
      {
        channel: w.general,
        ts: started.ts,
        markdown_text: "\n\nGood night.",
        blocks: feedback,
        metadata: { event_type: "answer", event_payload: { id: 1 } },
      },
      app.botToken,
    )
    const final = {
      ts: started.ts,
      text: "**Because** it's late.\n\nGood night.",
      blocks: [{ type: "markdown", text: "**Because** it's late.\n\nGood night." }, ...feedback],
      streaming_state: "completed",
      metadata: { event_type: "answer" },
      bot_profile: { name: "Answer Bot" },
    }
    expect(stopped).toMatchObject({ channel: w.general, ts: started.ts, message: final })
    expect(await link.next(isMessage("message_changed"))).toMatchObject({ message: final })
    // The stored reply is the finished message; the question counts it.
    const [parent, answer] = await reply(w, question.ts)
    expect(parent).toMatchObject({ reply_count: 1, reply_users: [app.botUserId] })
    expect(answer).toMatchObject(final)

    // Done is done.
    await expectError(
      "chat.appendStream",
      { channel: w.general, ts: started.ts, markdown_text: "more" },
      app.botToken,
      "message_not_in_streaming_state",
    )
    await expectError(
      "chat.stopStream",
      { channel: w.general, ts: started.ts },
      app.botToken,
      "message_not_in_streaming_state",
    )
    link.close()
  })

  it("takes chunks: markdown joins the last markdown block, blocks go in order", async () => {
    const { w, app, question, link, recipient } = await setup()
    // The official SDK's chatStream() starts a stream with nothing when stop() comes first.
    const started = await ok<Started>(
      "chat.startStream",
      { channel: w.general, thread_ts: question.ts, ...recipient },
      app.botToken,
    )
    expect(await link.next(isMessage())).toMatchObject({ text: "", streaming_state: "in_progress" })
    const divider = { type: "divider" }
    await ok(
      "chat.appendStream",
      {
        channel: w.general,
        ts: started.ts,
        chunks: [
          { type: "markdown_text", text: "One" },
          { type: "markdown_text", text: ", two" },
          { type: "blocks", blocks: [divider] },
          { type: "markdown_text", text: "Three" },
        ],
      },
      app.botToken,
    )
    await ok(
      "chat.appendStream",
      { channel: w.general, ts: started.ts, chunks: [{ type: "markdown_text", text: " and four" }] },
      app.botToken,
    )
    const stopped = await ok<Stopped>(
      "chat.stopStream",
      { channel: w.general, ts: started.ts, chunks: [] },
      app.botToken,
      { json: true },
    )
    expect(stopped.message).toMatchObject({
      text: "One, twoThree and four",
      blocks: [{ type: "markdown", text: "One, two" }, divider, { type: "markdown", text: "Three and four" }],
      streaming_state: "completed",
    })
    const changes = [
      await link.next(isMessage("message_changed")),
      await link.next(isMessage("message_changed")),
      await link.next(isMessage("message_changed")),
    ]
    expect(changes.map((c) => (c.message as Frame).text)).toEqual([
      "One, twoThree",
      "One, twoThree and four",
      "One, twoThree and four",
    ])
    expect((changes[2]!.message as Frame).streaming_state).toBe("completed")
    await settle()
    expect(link.frames.filter(isMessage("message_changed"))).toEqual([])
    link.close()
  })

  it("shows task updates as task_card blocks among the text, updated in place by id", async () => {
    const { w, app, question, link, recipient } = await setup()
    const source = { type: "url", url: "https://example.com/zh", text: "中文資料" }
    const started = await ok<Started>(
      "chat.startStream",
      {
        channel: w.general,
        thread_ts: question.ts,
        ...recipient,
        chunks: [
          { type: "markdown_text", text: "Voy a buscar." },
          { type: "task_update", id: "t1", title: "Recherche", status: "in_progress", details: "Requête: été" },
        ],
      },
      app.botToken,
    )
    const task = { type: "task_card", task_id: "t1", title: "Recherche", block_id: expect.any(String) }
    const begun = await link.next(isMessage())
    expect(begun).toMatchObject({
      text: "Voy a buscar.",
      blocks: [
        { type: "markdown", text: "Voy a buscar." },
        { ...task, status: "in_progress", details: { type: "rich_text" } },
      ],
    })
    const append = (chunks: unknown[]) =>
      ok("chat.appendStream", { channel: w.general, ts: started.ts, chunks }, app.botToken)
    await append([
      { type: "task_update", id: "t2", title: "検索", status: "pending" },
      { type: "markdown_text", text: " Fertig." },
      {
        type: "task_update",
        id: "t1",
        title: "Recherche",
        status: "complete",
        output: "3 résultats",
        sources: [source],
      },
    ])
    const changed = await link.next(isMessage("message_changed"))
    const blocks = (changed.message as Frame).blocks as Frame[]
    expect(blocks).toMatchObject([
      { type: "markdown", text: "Voy a buscar." },
      {
        ...task,
        status: "complete",
        details: { elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Requête: été" }] }] },
        output: { elements: [{ elements: [{ text: "3 résultats" }] }] },
        sources: [source],
      },
      { type: "task_card", task_id: "t2", title: "検索", status: "pending" },
      { type: "markdown", text: " Fertig." },
    ])
    // The task keeps the block_id it was given.
    expect(blocks[1]!.block_id).toBe((begun.blocks as Frame[])[1]!.block_id)
    // A plan update alone titles a plan block, and is an event like any change.
    await append([{ type: "plan_update", title: "계획" }])
    expect(((await link.next(isMessage("message_changed"))).message as Frame).blocks).toMatchObject([
      ...blocks.map(() => ({})),
      { type: "plan", title: "계획", tasks: [] },
    ])
    // Stopping with chunks rewrites too, and closing blocks still go last.
    const stopped = await ok<Stopped>(
      "chat.stopStream",
      {
        channel: w.general,
        ts: started.ts,
        chunks: [{ type: "task_update", id: "t2", title: "検索", status: "error" }],
        blocks: [{ type: "divider" }],
      },
      app.botToken,
    )
    expect(stopped.message).toMatchObject({ streaming_state: "completed" })
    expect((stopped.message.blocks as Frame[]).map((b) => b.status ?? b.type)).toEqual([
      "markdown",
      "complete",
      "error",
      "markdown",
      "plan",
      "divider",
    ])
    link.close()
  })

  it("gathers tasks in one plan block with task_display_mode plan", async () => {
    const { w, app, question, recipient } = await setup()
    const started = await ok<Started>(
      "chat.startStream",
      { channel: w.general, thread_ts: question.ts, task_display_mode: "plan", ...recipient },
      app.botToken,
    )
    const append = (chunks: unknown[]) =>
      ok("chat.appendStream", { channel: w.general, ts: started.ts, chunks }, app.botToken)
    // Tasks before any title start an untitled plan.
    await append([{ type: "task_update", id: "a", title: "Lire", status: "in_progress" }])
    await append([
      { type: "plan_update", title: "Plan de travail" },
      { type: "task_update", id: "b", title: "書く", status: "pending" },
      { type: "markdown_text", text: "Working on it." },
      { type: "task_update", id: "a", title: "Lire", status: "complete" },
    ])
    const [, answer] = await reply(w, question.ts)
    expect(answer).toMatchObject({
      text: "Working on it.",
      blocks: [
        {
          type: "plan",
          title: "Plan de travail",
          tasks: [
            { type: "task_card", task_id: "a", status: "complete" },
            { type: "task_card", task_id: "b", status: "pending" },
          ],
        },
        { type: "markdown", text: "Working on it." },
      ],
    })
    // Task updates at once each land: one that read the row before another wrote reads it again.
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        append([{ type: "task_update", id: `p${i}`, title: `${i}`, status: "pending" }]),
      ),
    )
    const [, after] = await reply(w, question.ts)
    const plan = (after!.blocks as Frame[])[0]!
    expect((plan.tasks as Frame[]).map((t) => t.task_id).toSorted()).toEqual([
      "a",
      "b",
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ])
    // Chunks after markdown_text don't mix, task updates included.
    const other = await ok<Started>(
      "chat.startStream",
      { channel: w.general, thread_ts: question.ts, markdown_text: "x", ...recipient },
      app.botToken,
    )
    await expectError(
      "chat.appendStream",
      { channel: w.general, ts: other.ts, chunks: [{ type: "task_update", id: "a", title: "x", status: "pending" }] },
      app.botToken,
      "streaming_mode_mismatch",
    )
  })

  it("streams into a DM without a recipient, and as the bot's own username", async () => {
    const w = await workspace()
    const app = await w.addApp("Helper")
    const dm = await ok<Started>("chat.postMessage", { channel: app.botUserId, text: "hi" }, w.owner.token)
    const started = await ok<Started>(
      "chat.startStream",
      { channel: dm.channel, thread_ts: dm.ts, markdown_text: "Hello", username: "Helpful" },
      app.botToken,
    )
    expect(started.channel).toBe(dm.channel)
    // Top level too ("0" means no thread).
    const top = await ok<Started>("chat.startStream", { channel: dm.channel, thread_ts: "0" }, app.botToken)
    const { messages } = await ok<Messages>("conversations.history", { channel: dm.channel }, w.owner.token)
    expect(messages.find((m) => m.ts === top.ts)).toMatchObject({ streaming_state: "in_progress" })
    expect(messages.find((m) => m.ts === dm.ts)).toMatchObject({ reply_count: 1 })
    const stopped = await ok<Stopped>("chat.stopStream", { channel: dm.channel, ts: started.ts }, app.botToken)
    expect(stopped.message).toMatchObject({ text: "Hello", username: "Helpful", streaming_state: "completed" })
  })

  it("wants a recipient outside DMs, from this workspace", async () => {
    const { w, app, question, link } = await setup()
    link.close()
    const args = { channel: w.general, thread_ts: question.ts, markdown_text: "x" }
    await expectError("chat.startStream", args, app.botToken, "missing_recipient_user_id")
    await expectError(
      "chat.startStream",
      { ...args, recipient_user_id: w.owner.id },
      app.botToken,
      "missing_recipient_team_id",
    )
    await expectError(
      "chat.startStream",
      { ...args, recipient_user_id: w.owner.id, recipient_team_id: "TOTHER" },
      app.botToken,
      "team_not_found",
    )
    await expectError(
      "chat.startStream",
      { ...args, recipient_user_id: "UNOPE", recipient_team_id: w.teamId },
      app.botToken,
      "user_not_found",
    )
  })

  it("refuses what Slack refuses", async () => {
    const { w, app, question, link, recipient } = await setup()
    link.close()
    const start = (args: Record<string, unknown>) => ({
      channel: w.general,
      thread_ts: question.ts,
      ...recipient,
      ...args,
    })
    // Bot tokens only.
    await expectError("chat.startStream", start({ markdown_text: "x" }), w.owner.token, "not_allowed_token_type")
    await expectError("chat.startStream", start({ channel: "CNOPE" }), app.botToken, "channel_not_found")
    await expectError("chat.startStream", start({ thread_ts: "1.000001" }), app.botToken, "thread_not_found")
    await expectError(
      "chat.startStream",
      start({ markdown_text: "x", chunks: [] }),
      app.botToken,
      "cannot_provide_both_markdown_text_and_chunks",
    )
    for (const chunks of [
      "{",
      { type: "markdown_text" },
      [1],
      [{ type: "nope" }],
      [{ type: "markdown_text", text: 1 }],
      [{ type: "blocks", blocks: [1] }],
      [{ type: "task_update", id: "t", title: "x", status: "sleeping" }],
      [{ type: "plan_update" }],
      [{ type: "task_update", id: "", title: "x", status: "pending" }],
      [{ type: "task_update", id: "t", title: "x", status: "pending", details: 1 }],
      [{ type: "task_update", id: "t", title: "x", status: "pending", output: {} }],
      [{ type: "task_update", id: "t", title: "x", status: "pending", sources: [{ type: "url", url: "x" }] }],
      [{ type: "task_update", id: "t", title: "x", status: "pending", sources: {} }],
    ]) {
      await expectError("chat.startStream", start({ chunks }), app.botToken, "invalid_chunks")
    }
    await expectError("chat.startStream", start({ markdown_text: "x".repeat(12_001) }), app.botToken, "msg_too_long")
    const many = Array.from({ length: 51 }, () => ({ type: "divider" }))
    await expectError(
      "chat.startStream",
      start({ chunks: [{ type: "blocks", blocks: many }] }),
      app.botToken,
      "msg_blocks_too_many",
    )

    const { ts } = await ok<Started>("chat.startStream", start({ markdown_text: "begun" }), app.botToken)
    const append = (args: Record<string, unknown>, token = app.botToken) =>
      call("chat.appendStream", { channel: w.general, ts, ...args }, token)
    expect(await append({})).toMatchObject({ error: "markdown_text_or_chunks_required" })
    expect(await append({ chunks: [] })).toMatchObject({ error: "markdown_text_or_chunks_required" })
    // Started with markdown_text: chunks don't mix in.
    expect(await append({ chunks: [{ type: "markdown_text", text: "x" }] })).toMatchObject({
      error: "streaming_mode_mismatch",
    })
    expect(await append({ markdown_text: "x", ts: "1.000001" })).toMatchObject({ error: "message_not_found" })
    expect(await append({ markdown_text: "x", ts: undefined })).toMatchObject({ error: "message_not_found" })
    expect(await append({ markdown_text: "x", ts: question.ts })).toMatchObject({ error: "message_not_owned_by_app" })
    const other = await w.addApp("Other Bot")
    expect(await append({ markdown_text: "x" }, other.botToken)).toMatchObject({ error: "message_not_owned_by_app" })
    // An ordinary message of its own isn't a stream.
    const plain = await ok<Started>("chat.postMessage", { channel: w.general, text: "plain" }, app.botToken)
    expect(await append({ markdown_text: "x", ts: plain.ts })).toMatchObject({
      error: "message_not_in_streaming_state",
    })
    // 40,000 characters in all, 50 blocks in all.
    for (let i = 0; i < 3; i++)
      await ok("chat.appendStream", { channel: w.general, ts, markdown_text: "y".repeat(12_000) }, app.botToken)
    expect(await append({ markdown_text: "y".repeat(5_000) })).toMatchObject({ error: "msg_too_long" })
    expect(await call("chat.stopStream", { channel: w.general, ts, blocks: many }, app.botToken)).toMatchObject({
      error: "msg_blocks_too_many",
    })
    expect(
      await call("chat.stopStream", { channel: w.general, ts, blocks: many.slice(0, 50) }, app.botToken),
    ).toMatchObject({ error: "msg_blocks_too_many" })
    for (const blocks of ["{", { type: "divider" }, [1]]) {
      expect(await call("chat.stopStream", { channel: w.general, ts, blocks }, app.botToken)).toMatchObject({
        error: "invalid_blocks",
      })
    }
    expect(await call("chat.stopStream", { channel: w.general, ts, metadata: "[1]" }, app.botToken)).toMatchObject({
      error: "invalid_metadata_format",
    })
    // Nothing above changed it.
    const stopped = await ok<Stopped>(
      "chat.stopStream",
      { channel: w.general, ts, blocks: many.slice(0, 49) },
      app.botToken,
    )
    expect((stopped.message.text as string).length).toBe(36_005)
    expect(stopped.message.blocks).toHaveLength(50)
  })

  it("lets a person in the conversation stop a stream: the app's next call answers stopped_by_user", async () => {
    const { w, app, question, link, recipient } = await setup()
    const { ts } = await ok<Started>(
      "chat.startStream",
      { channel: w.general, thread_ts: question.ts, markdown_text: "Counting: 1", ...recipient },
      app.botToken,
    )
    await link.next(isMessage())
    const stop = (args: Record<string, unknown>, token: string) =>
      call("campflare.chat.stopStream", { channel: w.general, ts, ...args }, token)

    // People only, members only, and only a stream in progress.
    expect(await stop({}, app.botToken)).toMatchObject({ error: "not_allowed_token_type" })
    const { channel: elsewhere } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "elsewhere" },
      w.owner.token,
    )
    const outsider = await w.addUser("outsider")
    expect(await stop({ channel: elsewhere.id }, outsider.token)).toMatchObject({ error: "not_in_channel" })
    expect(await stop({ channel: elsewhere.id }, w.owner.token)).toMatchObject({ error: "message_not_found" })
    expect(await stop({ ts: undefined }, w.owner.token)).toMatchObject({ error: "message_not_found" })
    expect(await stop({ ts: question.ts }, w.owner.token)).toMatchObject({ error: "message_not_in_streaming_state" })

    const member = await w.addUser("member")
    const stopped = await ok<Stopped>("campflare.chat.stopStream", { channel: w.general, ts }, member.token)
    const final = { ts, text: "Counting: 1", streaming_state: "completed", bot_id: app.botId }
    expect(stopped).toMatchObject({ channel: w.general, ts, message: final })
    expect(await link.next(isMessage("message_changed"))).toMatchObject({ message: final })

    // The app hears it on its next call; nothing more lands.
    expect(
      await call("chat.appendStream", { channel: w.general, ts, markdown_text: ", 2" }, app.botToken),
    ).toMatchObject({ ok: false, error: "stopped_by_user" })
    expect(await call("chat.stopStream", { channel: w.general, ts, markdown_text: "!" }, app.botToken)).toMatchObject({
      ok: false,
      error: "stopped_by_user",
    })
    expect(await stop({}, w.owner.token)).toMatchObject({ error: "message_not_in_streaming_state" })
    const [, answer] = await reply(w, question.ts)
    expect(answer).toMatchObject(final)
    link.close()
  })

  it("streams into a private channel only as a member", async () => {
    const w = await workspace()
    const app = await w.addApp("Private Bot")
    const { channel } = await ok<{ channel: { id: string } }>(
      "conversations.create",
      { name: "secret", is_private: true },
      w.owner.token,
    )
    const args = { channel: channel.id, recipient_user_id: w.owner.id, recipient_team_id: w.teamId }
    await expectError("chat.startStream", args, app.botToken, "channel_not_found")
    await ok("conversations.invite", { channel: channel.id, users: app.botUserId }, w.owner.token)
    const { ts } = await ok<Started>("chat.startStream", args, app.botToken)
    await ok("conversations.kick", { channel: channel.id, user: app.botUserId }, w.owner.token)
    await expectError(
      "chat.appendStream",
      { channel: channel.id, ts, markdown_text: "x" },
      app.botToken,
      "channel_not_found",
    )
  })
})

import { all, first, stmt } from "../db/query"
import { requireNotArchived, requireReadable, resolveConversation } from "../db/conversations"
import { method } from "../api/context"
import { sha256Hex } from "../api/crypto"
import { CampflareError, invalidArguments } from "../api/errors"
import { nowSeconds, randomId, randomSecret } from "../api/ids"
import type { WebhookRow } from "../webhooks"
import { ownApp } from "./admin"

// Incoming webhooks (docs/commands-webhooks.md): created by an app's installer
// or an admin, each bound to one conversation; the URL is shown once.

type Listed = WebhookRow & { channel_name: string; kind: string }

const webhookJson = (
  w: Pick<WebhookRow, "id" | "app_id" | "channel_id" | "label" | "created_by" | "created" | "last_used">,
  channelName?: string,
) => ({
  id: w.id,
  app_id: w.app_id,
  channel: w.channel_id,
  ...(channelName !== undefined ? { channel_name: channelName } : {}),
  label: w.label,
  created_by: w.created_by,
  created: w.created,
  last_used: w.last_used,
})

/**
 * A webhook that posts in `channel` as the app's bot: `<origin>/services/<secret>`,
 * answered once (only its hash is kept). The bot must be able to post there:
 * any public channel, else one it's a member of.
 */
method("campflare.apps.createWebhook", "user", async (ctx) => {
  const app = await ownApp(ctx)
  const c = await resolveConversation(ctx, ctx.args.req("channel", "channel_not_found"))
  await requireReadable(ctx, c)
  requireNotArchived(c)
  const label = ctx.args.str("label")?.trim() ?? ""
  if (label.length > 100) throw invalidArguments("label is at most 100 characters")
  const isPublic = c.kind === "channel" && !c.is_private
  if (!isPublic) {
    const member = await first(
      ctx.env.DB,
      "SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?",
      c.id,
      app.bot_user_id,
    )
    if (!member) {
      throw new CampflareError("not_in_channel", {
        response_metadata: {
          messages: ["[ERROR] the app's bot must be a member of a private conversation to post there"],
        },
      })
    }
  }
  const secret = randomSecret(24)
  const row: Omit<WebhookRow, "bucket" | "bucket_at" | "revoked"> = {
    id: randomId("H"),
    team_id: app.team_id,
    app_id: app.id,
    channel_id: c.id,
    hash: await sha256Hex(secret),
    label,
    created_by: ctx.auth.user.id,
    created: nowSeconds(),
    last_used: null,
  }
  await ctx.env.DB.prepare(
    `INSERT INTO webhooks (id, team_id, app_id, channel_id, hash, label, created_by, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.team_id, row.app_id, row.channel_id, row.hash, row.label, row.created_by, row.created)
    .run()
  return { webhook: { ...webhookJson(row, c.name), url: `${ctx.origin}/services/${secret}` } }
})

/** An app's live webhooks: where each posts and when it was last used. The URLs aren't kept. */
method("campflare.apps.webhooks.list", "user", async (ctx) => {
  const app = await ownApp(ctx)
  const rows = await all<Listed>(
    ctx.env.DB,
    `SELECT w.*, c.name AS channel_name, c.kind FROM webhooks w LEFT JOIN conversations c ON c.id = w.channel_id
     WHERE w.app_id = ? AND w.revoked IS NULL ORDER BY w.created, w.id`,
    app.id,
  )
  return { webhooks: rows.map((w) => webhookJson(w, w.kind === "channel" ? w.channel_name : "")) }
})

/** Stops a webhook at once: its URL answers `no_service` from then on. */
method("campflare.apps.webhooks.revoke", "user", async (ctx) => {
  const id = ctx.args.req("webhook", "webhook_not_found")
  const hook = await first<WebhookRow>(
    ctx.env.DB,
    "SELECT * FROM webhooks WHERE id = ? AND team_id = ? AND revoked IS NULL",
    id,
    ctx.auth.team.id,
  )
  if (!hook) throw new CampflareError("webhook_not_found")
  await ownApp(ctx, hook.app_id)
  await stmt(ctx.env.DB, "UPDATE webhooks SET revoked = ? WHERE id = ?", nowSeconds(), id).run()
  return {}
})

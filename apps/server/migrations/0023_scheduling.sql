-- Scheduled messages and reminders (docs/scheduling.md). D1 holds what is
-- pending; the workspace's Scheduler Durable Object only keeps an alarm at the
-- earliest due time. A runner claims a due row (claimed_until, a 60-second
-- lease, and a claim token only it knows) before posting, and finishes it in
-- the same batch as the post, which fails unless the row still holds its claim.

-- chat.scheduleMessage: the message as chat.postMessage would store it, and who posts it.
CREATE TABLE scheduled_messages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  -- The poster: a person, or a bot user with its app.
  user_id TEXT NOT NULL,
  app_id TEXT,
  username TEXT,
  text TEXT NOT NULL DEFAULT '',
  blocks TEXT,
  attachments TEXT,
  metadata TEXT,
  thread_ts TEXT,
  reply_broadcast INTEGER NOT NULL DEFAULT 0,
  post_at INTEGER NOT NULL,
  created INTEGER NOT NULL,
  -- Where URLs in the posted message point (the origin it was scheduled at).
  origin TEXT NOT NULL,
  -- The scheduling token's scopes (comma-separated, as expanded then): posting checks them at fire
  -- time, so a bot without chat:write.public must still be in the channel.
  scopes TEXT NOT NULL DEFAULT '',
  claimed_until INTEGER,
  claim TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX scheduled_messages_due ON scheduled_messages (team_id, post_at);
CREATE INDEX scheduled_messages_user ON scheduled_messages (user_id, post_at);
CREATE INDEX scheduled_messages_channel ON scheduled_messages (channel_id, post_at);

-- reminders.add: kept after firing (listed, with complete_ts 0) until completed or deleted.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  time INTEGER NOT NULL,
  complete_ts INTEGER NOT NULL DEFAULT 0,
  fired INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  origin TEXT NOT NULL,
  claimed_until INTEGER,
  claim TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX reminders_due ON reminders (team_id, time) WHERE fired = 0 AND complete_ts = 0;
CREATE INDEX reminders_user ON reminders (user_id, time);

-- Never holds a row: a post's batch inserts NULL here when its claim is gone,
-- and the NOT NULL fails the batch, so nothing of it commits.
CREATE TABLE claim_guards (lost INTEGER NOT NULL);

-- Apps the server itself acts as (the bot reminders come from), found by this
-- mark and never by name, so an app someone names the same can't stand in.
ALTER TABLE apps ADD COLUMN built_in TEXT;
CREATE UNIQUE INDEX apps_built_in ON apps (team_id, built_in) WHERE built_in IS NOT NULL;

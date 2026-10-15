-- Pins, channel bookmarks and saved items (stars).

-- A message is pinned to the conversation it was posted in, so a pin is two
-- columns on the message: serialising a message (pinned_to) costs no query.
ALTER TABLE messages ADD COLUMN pinned_by TEXT;
-- When it was pinned, in epoch seconds; NULL when it isn't.
ALTER TABLE messages ADD COLUMN pinned_at INTEGER;
CREATE INDEX messages_pinned ON messages (channel_id, pinned_at) WHERE pinned_at IS NOT NULL;

-- The bookmarks bar of a conversation: links, in `rank` order.
CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  entity_id TEXT,
  -- The app whose bot added it, if one did.
  app_id TEXT,
  -- Fixed-width, so text order is bar order.
  rank TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  date_created INTEGER NOT NULL,
  date_updated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bookmarks_channel ON bookmarks (channel_id, rank);

-- What a person saved for later: a message (channel_id + ts), a file, or a
-- conversation (channel_id alone). `item` is the key: "message:<channel>/<ts>",
-- "file:<id>" or "channel:<id>".
CREATE TABLE stars (
  user_id TEXT NOT NULL,
  item TEXT NOT NULL,
  team_id TEXT NOT NULL,
  type TEXT NOT NULL,
  channel_id TEXT,
  ts TEXT,
  file_id TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (user_id, item)
);
CREATE INDEX stars_user_created ON stars (user_id, created);
CREATE INDEX stars_message ON stars (channel_id, ts) WHERE ts IS NOT NULL;
CREATE INDEX stars_file ON stars (file_id) WHERE file_id IS NOT NULL;

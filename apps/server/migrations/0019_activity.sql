-- The activity inbox (docs/activity.md): one row per thing that happened to
-- one person, written in the same batch as the message or reaction behind it.
-- kind: 'mention', 'dm', 'thread_reply' or 'reaction'. notify is decided when
-- the item is recorded, from the recipient's notification level and snooze.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  thread_ts TEXT,
  -- Who did it; '' when nobody is known (a message without a user), never NULL,
  -- since NULLs are distinct in a unique index and would let duplicates in.
  actor_id TEXT NOT NULL DEFAULT '',
  -- The emoji, for a reaction; '' otherwise, so the unique index below holds.
  reaction TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  notify INTEGER NOT NULL DEFAULT 1,
  read INTEGER NOT NULL DEFAULT 0
);
-- A person's inbox, newest first.
CREATE INDEX activity_user ON activity (user_id, id);
-- Unread counts (the badge), read on every list and mark: only the unread rows.
CREATE INDEX activity_unread ON activity (user_id, kind) WHERE read = 0;
-- What a message's deletion removes.
CREATE INDEX activity_message ON activity (channel_id, ts);
-- One item per message per person, and per reaction for reactions.
CREATE UNIQUE INDEX activity_once ON activity (user_id, channel_id, ts, kind, actor_id, reaction);

-- Notification levels: 'all', 'mentions' or 'none'. conversation_id '' is the
-- person's default for every conversation without its own.
CREATE TABLE notification_prefs (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'none')),
  updated INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id)
);

-- Campflare core schema. IDs follow Slack's shapes (T…, U…, C…/D…/G…, F…, A…, B…)
-- and message timestamps are Slack "ts" strings ("1727500000.000100"): fixed width,
-- so text order is time order.

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  name TEXT NOT NULL,
  real_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  title TEXT NOT NULL DEFAULT '',
  status_text TEXT NOT NULL DEFAULT '',
  status_emoji TEXT NOT NULL DEFAULT '',
  status_expiration INTEGER NOT NULL DEFAULT 0,
  tz TEXT NOT NULL DEFAULT 'UTC',
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_owner INTEGER NOT NULL DEFAULT 0,
  is_bot INTEGER NOT NULL DEFAULT 0,
  bot_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  -- users.setPresence: 'auto' or 'away'
  manual_presence TEXT NOT NULL DEFAULT 'auto',
  last_activity INTEGER NOT NULL DEFAULT 0,
  snooze_until INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_team_name ON users (team_id, name);
CREATE UNIQUE INDEX users_team_email ON users (team_id, email) WHERE email IS NOT NULL;

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  name TEXT NOT NULL,
  bot_id TEXT NOT NULL UNIQUE,
  bot_user_id TEXT NOT NULL REFERENCES users (id),
  -- The user who installed it: user-token events are delivered on their behalf.
  installer_user_id TEXT NOT NULL REFERENCES users (id),
  created INTEGER NOT NULL
);

CREATE TABLE tokens (
  -- SHA-256 of the token, hex. The token itself is shown once and never stored.
  hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'bot', 'app')),
  user_id TEXT REFERENCES users (id),
  app_id TEXT REFERENCES apps (id),
  scopes TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tokens_user ON tokens (user_id);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'im', 'mpim')),
  name TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  is_general INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  creator TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  topic_creator TEXT NOT NULL DEFAULT '',
  topic_last_set INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT '',
  purpose_creator TEXT NOT NULL DEFAULT '',
  purpose_last_set INTEGER NOT NULL DEFAULT 0,
  previous_names TEXT NOT NULL DEFAULT '[]',
  -- im/mpim: sorted member ids joined by ',', so opening the same DM twice finds it.
  member_key TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX conversations_team_name ON conversations (team_id, name) WHERE kind = 'channel';
CREATE UNIQUE INDEX conversations_member_key ON conversations (team_id, member_key) WHERE member_key IS NOT NULL;

CREATE TABLE members (
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  last_read TEXT NOT NULL DEFAULT '0000000000.000000',
  joined INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

CREATE TABLE messages (
  channel_id TEXT NOT NULL REFERENCES conversations (id),
  ts TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT,
  bot_id TEXT,
  app_id TEXT,
  username TEXT,
  subtype TEXT,
  text TEXT NOT NULL DEFAULT '',
  blocks TEXT,
  attachments TEXT,
  metadata TEXT,
  files TEXT,
  thread_ts TEXT,
  parent_user_id TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  reply_users TEXT NOT NULL DEFAULT '[]',
  latest_reply TEXT,
  edited_ts TEXT,
  edited_user TEXT,
  client_msg_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, ts)
);
CREATE INDEX messages_thread ON messages (channel_id, thread_ts, ts) WHERE thread_ts IS NOT NULL;
CREATE INDEX messages_user ON messages (user_id, ts);

CREATE VIRTUAL TABLE messages_fts USING fts5 (text, content = 'messages', content_rowid = 'rowid', tokenize = 'trigram');

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE reactions (
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (channel_id, ts, name, user_id)
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  alt_txt TEXT,
  -- 'reserved' (URL handed out), 'uploaded' (bytes in R2), 'complete' (shared or kept)
  status TEXT NOT NULL DEFAULT 'reserved',
  -- Conversations it is shared in, as a JSON array of ids.
  channels TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL
);
CREATE INDEX files_team_created ON files (team_id, created);

-- Slash commands and incoming webhooks (docs/commands-webhooks.md).

-- An app's slash commands (campflare.apps.setCommands). A name ("/deploy") is
-- the workspace's: one app holds it at a time. `url` is where the command is
-- POSTed when the app has no Socket Mode link; NULL for Socket Mode only.
CREATE TABLE app_commands (
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  app_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  usage_hint TEXT NOT NULL DEFAULT '',
  url TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (team_id, name)
);

CREATE INDEX app_commands_app ON app_commands (app_id);

-- Incoming webhooks (campflare.apps.createWebhook): POSTs to
-- <origin>/services/<secret> post in one conversation as the app's bot. Only
-- the secret's SHA-256 is kept. `bucket` and `bucket_at` are a token bucket
-- (tokens, and when it was last refilled, in milliseconds): a POST takes a
-- token, one comes back each second, up to a burst.
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  revoked INTEGER,
  last_used INTEGER,
  bucket REAL NOT NULL DEFAULT 10,
  bucket_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX webhooks_app ON webhooks (app_id);

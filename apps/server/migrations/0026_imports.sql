-- Importing another workspace's export (docs/import.md). A job maps the
-- export's ids to ours and tags every row it writes, so it can be undone.

CREATE TABLE import_jobs (
  -- "J…"
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  created_by TEXT NOT NULL REFERENCES users (id),
  -- 'slack-export'
  format TEXT NOT NULL,
  -- What the client says identifies the export (the SHA-256 of a zip's central directory), or NULL.
  fingerprint TEXT,
  -- 'running', 'finished', 'undoing' or 'undone'.
  state TEXT NOT NULL DEFAULT 'running',
  -- JSON: { merge_into_existing, files, source_name }.
  options TEXT NOT NULL DEFAULT '{}',
  -- JSON: what was written so far (docs/import.md, Methods).
  counts TEXT NOT NULL DEFAULT '{}',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  finished INTEGER
);
CREATE INDEX import_jobs_team ON import_jobs (team_id, created);
CREATE INDEX import_jobs_fingerprint ON import_jobs (team_id, fingerprint) WHERE fingerprint IS NOT NULL;

-- The export's people, and who they are here.
CREATE TABLE import_users (
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- 1 when the job made the user (a placeholder).
  created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, source_id)
) WITHOUT ROWID;

-- The export's conversations, and where their messages go.
CREATE TABLE import_conversations (
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- 'created', 'renamed' (created under another name) or 'merged' (an existing one).
  action TEXT NOT NULL,
  -- The last day file whose messages are all in (the CLI's resume point).
  cursor TEXT,
  -- 1 once campflare.import.finish has handled it.
  finished INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, source_id)
) WITHOUT ROWID;

-- The export's files, from the messages that carry them: file_id is NULL until
-- campflare.import.files attaches the bytes, and the message shows a line in its place.
CREATE TABLE import_files (
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  -- The export's conversation, and ours, that the message is in.
  source_conversation TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  name TEXT NOT NULL,
  file_id TEXT,
  PRIMARY KEY (job_id, source_id)
) WITHOUT ROWID;
CREATE INDEX import_files_message ON import_files (job_id, channel_id, ts);

-- Every row an import writes carries its job, for campflare.import.undo.
ALTER TABLE messages ADD COLUMN import_job TEXT;
ALTER TABLE reactions ADD COLUMN import_job TEXT;
ALTER TABLE members ADD COLUMN import_job TEXT;
ALTER TABLE files ADD COLUMN import_job TEXT;
ALTER TABLE users ADD COLUMN import_job TEXT;
ALTER TABLE conversations ADD COLUMN import_job TEXT;

CREATE INDEX messages_import ON messages (import_job, channel_id, ts) WHERE import_job IS NOT NULL;
CREATE INDEX reactions_import ON reactions (import_job) WHERE import_job IS NOT NULL;
CREATE INDEX members_import ON members (import_job) WHERE import_job IS NOT NULL;
CREATE INDEX files_import ON files (import_job) WHERE import_job IS NOT NULL;
CREATE INDEX users_import ON users (import_job) WHERE import_job IS NOT NULL;
CREATE INDEX conversations_import ON conversations (import_job) WHERE import_job IS NOT NULL;

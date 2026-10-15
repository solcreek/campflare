-- Invitations and password resets, as links (docs/invites.md). Each link's
-- code is shown once; only its SHA-256 (hex) is kept, as with tokens.

CREATE TABLE invites (
  -- The public id, for campflare.invites.list and .revoke ("I…").
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  hash TEXT NOT NULL UNIQUE,
  inviter TEXT NOT NULL REFERENCES users (id),
  -- Bound to this address (lower case), or NULL for an open link.
  email TEXT,
  -- 'member' or 'admin'.
  role TEXT NOT NULL DEFAULT 'member',
  -- Conversations to join besides #general: a JSON array of ids.
  channels TEXT NOT NULL DEFAULT '[]',
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

CREATE INDEX invites_team ON invites (team_id, created);

CREATE TABLE password_resets (
  hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  -- The admin who made it, or NULL when the person asked for it by email.
  created_by TEXT REFERENCES users (id),
  expires INTEGER NOT NULL,
  created INTEGER NOT NULL
);

CREATE INDEX password_resets_user ON password_resets (user_id);

-- Custom emoji: a workspace's own :name:, an image or another name (an alias).
CREATE TABLE emoji (
  team_id TEXT NOT NULL,
  -- Slack's rules: lowercase letters, digits, - and _, up to 100 characters.
  name TEXT NOT NULL,
  -- An image: its random id (R2 key <team>/emoji/<image>, served at
  -- /emoji/<team>/<image>.<ext>) and type. NULL for an alias.
  image TEXT,
  image_type TEXT,
  -- An alias: the name it stands for (a custom emoji's, or a standard one's). NULL for an image.
  alias_for TEXT,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (team_id, name)
);
CREATE INDEX emoji_aliases ON emoji (team_id, alias_for) WHERE alias_for IS NOT NULL;

-- When the workspace's emoji last changed (emoji.list's cache_ts), in epoch milliseconds.
ALTER TABLE teams ADD COLUMN emoji_updated INTEGER NOT NULL DEFAULT 0;

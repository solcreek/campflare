-- Profile photos (users.setPhoto) and user groups (usergroups.*).

-- The person's photo: a random id that names its R2 objects
-- (<team>/avatars/<user>/<photo>/…) and its URLs, so a new photo is a new URL
-- and clients refetch; NULL for none (the initials are drawn instead). Its
-- type (image/png, image/jpeg, image/webp; animated images are refused) and the
-- crop square users.setPhoto was given (JSON {x, y, w}), or NULL.
ALTER TABLE users ADD COLUMN photo TEXT;
ALTER TABLE users ADD COLUMN photo_type TEXT;
ALTER TABLE users ADD COLUMN photo_crop TEXT;

CREATE TABLE usergroups (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id),
  -- Lower case; mentioned as @handle, so unique in the workspace among groups and people (triggers below).
  handle TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- prefs.channels: the group's default channels, a JSON array of ids.
  channels TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  -- Who disabled it, and when (0 while enabled).
  deleted_by TEXT,
  date_create INTEGER NOT NULL,
  date_update INTEGER NOT NULL,
  date_delete INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX usergroups_team_handle ON usergroups (team_id, handle);
CREATE UNIQUE INDEX usergroups_team_name ON usergroups (team_id, name COLLATE NOCASE);

CREATE TABLE usergroup_members (
  usergroup_id TEXT NOT NULL REFERENCES usergroups (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  PRIMARY KEY (usergroup_id, user_id)
);
CREATE INDEX usergroup_members_user ON usergroup_members (user_id);

-- A group's handle and a person's name share one namespace (@handle): checked in
-- the statement that writes, so two writers can't both take one.
CREATE TRIGGER usergroups_handle_insert BEFORE INSERT ON usergroups
WHEN EXISTS (SELECT 1 FROM users WHERE team_id = NEW.team_id AND name = NEW.handle)
BEGIN
  SELECT RAISE(ABORT, 'handle_taken_by_user');
END;

CREATE TRIGGER usergroups_handle_update BEFORE UPDATE OF handle ON usergroups
WHEN NEW.handle <> OLD.handle AND EXISTS (SELECT 1 FROM users WHERE team_id = NEW.team_id AND name = NEW.handle)
BEGIN
  SELECT RAISE(ABORT, 'handle_taken_by_user');
END;

CREATE TRIGGER users_name_insert BEFORE INSERT ON users
WHEN EXISTS (SELECT 1 FROM usergroups WHERE team_id = NEW.team_id AND handle = NEW.name)
BEGIN
  SELECT RAISE(ABORT, 'name_taken_by_usergroup');
END;

-- Time zones, status expiry and do-not-disturb hours (docs/dnd.md).

-- A person's DND hours, in their tz: from dnd_start to dnd_end ("22:00",
-- "08:00"; an end at or before the start is the next morning) on dnd_days
-- ("mon,tue,wed,thu,fri"), the days the windows start on. '' when unset.
ALTER TABLE users ADD COLUMN dnd_start TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN dnd_end TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN dnd_days TEXT NOT NULL DEFAULT '';

-- The schedule's window in progress, else the next one (epoch seconds; 0 and
-- 0 without a schedule). Activity's notify reads it in SQL; the workspace's
-- Scheduler moves it on to the next window when it ends.
ALTER TABLE users ADD COLUMN dnd_window_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN dnd_window_end INTEGER NOT NULL DEFAULT 0;

-- What the Scheduler looks for: statuses to clear when they expire, windows to move on.
CREATE INDEX users_status_expiry ON users (team_id, status_expiration) WHERE status_expiration > 0;
CREATE INDEX users_dnd_window ON users (team_id, dnd_window_end) WHERE dnd_window_end > 0;

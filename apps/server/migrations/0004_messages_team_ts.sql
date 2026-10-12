-- Newest-first across a workspace: search sorted by time (and every LIKE
-- search) walks this index and stops once it has a page, instead of reading
-- and sorting every match.

CREATE INDEX messages_team_ts ON messages (team_id, ts);

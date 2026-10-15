-- Web Push subscriptions (docs/push.md): one row per browser a person turned
-- notifications on in. The endpoint is the push service's URL for that browser
-- and a capability (with the keys, anyone can push to it), so it is never
-- answered by the API; p256dh and auth are the browser's encryption keys.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  -- When a push to it last reached the push service (epoch seconds), 0 before.
  last_used INTEGER NOT NULL DEFAULT 0
);
-- A person's devices, and a workspace's (which the hub reads once per lifetime).
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id, created);
CREATE INDEX push_subscriptions_team ON push_subscriptions (team_id);

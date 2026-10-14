-- The Events API over HTTP: an app's signing secret, the Request URL its
-- events are POSTed to, and the event types it subscribes to.
--
-- signing_secret signs each delivery (v0=HMAC-SHA256), so it is kept as is,
-- unlike tokens: 32 hex characters, as Slack's. Apps created before this get
-- one now; campflare.apps.info shows it to their installer.
-- event_request_url is NULL until set with campflare.apps.setEventSubscriptions,
-- which checks it with Slack's url_verification challenge first.
-- event_types is a JSON array of event types ("message.channels",
-- "app_mention"…), or NULL for every event the app can see.

ALTER TABLE apps ADD COLUMN signing_secret TEXT NOT NULL DEFAULT '';
UPDATE apps SET signing_secret = lower(hex(randomblob(16)));
ALTER TABLE apps ADD COLUMN event_request_url TEXT;
ALTER TABLE apps ADD COLUMN event_types TEXT;

-- The hub reads a workspace's subscribed apps by team.
CREATE INDEX apps_team ON apps (team_id);

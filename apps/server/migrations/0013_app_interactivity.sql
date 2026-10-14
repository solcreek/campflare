-- Interactivity: where a click on an app's buttons is POSTed (Slack's
-- Interactivity Request URL), as block_actions, form-encoded and signed with
-- the app's signing_secret (migration 0009).
--
-- NULL until set with campflare.apps.setInteractivity. Slack doesn't check
-- this URL with a challenge, so neither do we. An app with a Socket Mode link
-- gets its clicks there instead, as on Slack.

ALTER TABLE apps ADD COLUMN interactivity_request_url TEXT;

-- The Events API turns HTTP delivery off for an app whose Request URL fails
-- more than 95% of at least 20 attempts in an hour, as Slack does (the team
-- hub counts them). When and why are kept here; event_request_url stays, so
-- the installer sees which URL was turned off.
--
-- Both are NULL while delivery is on. Setting a Request URL again (checked
-- with url_verification) or clearing it turns the switch back.

ALTER TABLE apps ADD COLUMN event_delivery_disabled_at INTEGER;
ALTER TABLE apps ADD COLUMN event_delivery_disabled_reason TEXT;

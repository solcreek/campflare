-- Token scopes become binding (docs/scopes-and-roles.md). A token's `scopes`
-- may now name a preset (`full`, `read`, `write`, `bot`), expanded when the
-- token is used, so a token made with a preset gains the scopes later features
-- add to it without another migration. Slack's scopes always contain a colon,
-- so a bare word is unambiguous.
--
-- Nothing checked scopes before, so stored lists are whatever the code wrote
-- then. Person tokens made by hand or bootstrap, and those of our own clients,
-- were meant to be the whole person: `full`. Bot tokens get the bot defaults.
-- Other OAuth tokens keep what was consented to.

UPDATE tokens SET scopes = 'full'
WHERE kind = 'user' AND (client_id IS NULL OR client_id IN ('campflare-cli', 'campflare-web', 'campflare-desktop'));

UPDATE tokens SET scopes = 'bot' WHERE kind = 'bot';

-- When the token stops working (epoch seconds), or NULL for never.
ALTER TABLE tokens ADD COLUMN expires INTEGER;

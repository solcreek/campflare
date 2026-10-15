-- Token scopes become binding (docs/scopes-and-roles.md). A token's `scopes`
-- may now name a preset (`full`, `read`, `write`, `bot`), expanded when the
-- token is used, so a token made with a preset gains the scopes later features
-- add to it without another migration. Slack's scopes always contain a colon,
-- so a bare word is unambiguous.
--
-- Nothing checked scopes before, so every existing token could do everything
-- its person could, whatever its stored list said: the lists are only what the
-- code wrote then. Keeping that is no new power, while narrowing them would break
-- clients signed in now (the web app at its own origin, apps given the old
-- default list, which lacks rtm:stream): every person token becomes `full`.
-- Only tokens made from now on are narrowed. Bot tokens get the bot defaults.

UPDATE tokens SET scopes = 'full' WHERE kind = 'user';

UPDATE tokens SET scopes = 'bot' WHERE kind = 'bot';

-- When the token stops working (epoch seconds), or NULL for never.
ALTER TABLE tokens ADD COLUMN expires INTEGER;

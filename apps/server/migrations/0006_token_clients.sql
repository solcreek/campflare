-- The OAuth client a user token was issued to through oauth.v2.access (its
-- client_id: campflare-cli, campflare-desktop, or a Client ID Metadata
-- Document URL); NULL for tokens made any other way. Signing in again with
-- the same client keeps only the newest few of that person's tokens for it,
-- so they don't pile up, and this column is what tells clients apart (a
-- label is free text, and two clients may share a name).

ALTER TABLE tokens ADD COLUMN client_id TEXT;
CREATE INDEX tokens_user_client ON tokens (user_id, client_id) WHERE client_id IS NOT NULL;

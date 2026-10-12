-- Campflare's own apps as OAuth clients of Better Auth, for signing a person
-- in through the browser (/oauth/v2/authorize, then oauth.v2.access).
--
-- They are public clients (no secret: a CLI or a desktop app can't keep one),
-- so PKCE is required. Their redirect URIs are loopback addresses, which per
-- RFC 8252 match on any port: the app listens on a free port and says so in
-- redirect_uri. A web app at its own https origin identifies itself instead by
-- a Client ID Metadata Document (its client_id is that document's URL), so no
-- row is needed for it; campflare-web covers a web app served from localhost
-- during development, where a metadata document can't be fetched.
--
-- Better Auth stores arrays as JSON text and booleans as 0/1. scopes is NULL:
-- any scope the provider knows, of which /oauth/v2/authorize asks for openid
-- and the Slack user scopes.

INSERT INTO "oauthClient" ("id", "clientId", "name", "redirectUris", "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "applicationType", "requirePKCE", "disabled", "skipConsent", "createdAt", "updatedAt")
VALUES
  ('first-party-cli', 'campflare-cli', 'Campflare CLI', '["http://127.0.0.1/callback","http://[::1]/callback"]', 'none', '["authorization_code"]', '["code"]', 'native', 1, 0, 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z'),
  ('first-party-desktop', 'campflare-desktop', 'Campflare for desktop', '["http://127.0.0.1/callback","http://[::1]/callback"]', 'none', '["authorization_code"]', '["code"]', 'native', 1, 0, 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z'),
  ('first-party-web', 'campflare-web', 'Campflare (local web app)', '["http://localhost/","http://127.0.0.1/"]', 'none', '["authorization_code"]', '["code"]', 'native', 1, 0, 0, '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z');

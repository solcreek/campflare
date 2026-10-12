-- Passwords, for signing in with an email address and a password (/login).
--
-- One row per Campflare user who set one (campflare.users.setPassword). Emails
-- are unique per workspace only, so a password belongs to a user (one person
-- in one workspace), never to an email address: sign-in finds the users with
-- that email and checks each one's password.
--
-- hash is "pbkdf2-sha256$<iterations>$<salt>$<key>" (base64). failures counts
-- wrong passwords since the last right one; from the fifth on, the user is
-- locked until locked_until (unix seconds), which slows guessing.

CREATE TABLE passwords (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  hash TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL
);

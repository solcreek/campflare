-- Throttling sign-in attempts (src/auth/throttle.ts), replacing the per-user
-- lock of 0007, which let anyone who knew an email keep that person out.
--
-- One row per counter, by key:
--   rate:<ip>            attempts from an address in the current minute
--   ip:<ip>              failed attempts from an address, any email or token
--   pair:<email>:<ip>    failed passwords for an email from an address
--   email:<email>        failed passwords for an email from anywhere; it never
--                        blocks, it only shortens each address's free tries
-- count is the attempts or failures in the window, blocked_until (unix
-- seconds) when the next attempt is allowed, and expires when the row is
-- forgotten; expired rows are pruned on later attempts.

CREATE TABLE sign_in_throttle (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL
);

CREATE INDEX sign_in_throttle_expires ON sign_in_throttle (expires);

ALTER TABLE passwords DROP COLUMN failures;
ALTER TABLE passwords DROP COLUMN locked_until;

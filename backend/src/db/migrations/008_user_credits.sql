-- Raises the starting credit grant from 50 to 500, so a new account can ask 25 questions at
-- CREDITS_PER_QUERY (20) each.
--
-- Notes:
--   * The column, its NOT NULL, and CHECK (credits >= 0) all already exist from
--     001_init_auth.sql and are left exactly as they are. Only the default changes, and no new
--     credits column or user-credit table is introduced.
--   * 500 must stay in step with DEFAULT_USER_CREDITS in src/constants.ts, which is also what
--     env.ts uses as SIGNUP_CREDITS' default. SQL cannot import the constant, so this comment is
--     the link — change both together.
--   * The backfill raises accounts that predate the credit system, which were granted the old
--     50. `WHERE credits < 500` rather than an unconditional set: it can only ever top an account
--     up, never take credits away, so it cannot damage a balance. Nothing has been spent yet —
--     this migration is what introduces spending — so there is no legitimate low balance to
--     preserve.
--   * ALTER COLUMN SET DEFAULT does not rewrite the table and does not touch existing rows.

ALTER TABLE users ALTER COLUMN credits SET DEFAULT 500;

UPDATE users SET credits = 500 WHERE credits < 500;

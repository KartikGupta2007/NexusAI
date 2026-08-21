-- Users and refresh tokens for NexusAI.
--
-- Notes on the differences from the first draft of this schema:
--   * `password_hash` is nullable: Google-only accounts never have one. A table-level
--     CHECK still guarantees every row has at least one usable credential.
--   * There is no `access_token` column. Access tokens are short-lived, stateless JWTs;
--     storing them would add a write on every request and a theft surface for no gain.
--   * `refresh_tokens` stores a SHA-256 of the token, not the token itself, so a database
--     leak cannot be replayed against the API.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email             TEXT NOT NULL UNIQUE,
    password_hash     TEXT,
    name              TEXT,
    avatar_url        TEXT,
    auth_provider     TEXT NOT NULL DEFAULT 'password',
    neon_auth_user_id TEXT UNIQUE,
    email_verified    BOOLEAN NOT NULL DEFAULT FALSE,
    credits           INTEGER NOT NULL DEFAULT 50,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
    CONSTRAINT users_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT users_credits_non_negative CHECK (credits >= 0),
    CONSTRAINT users_auth_provider_valid CHECK (auth_provider IN ('password', 'google')),
    CONSTRAINT users_has_credential CHECK (password_hash IS NOT NULL OR neon_auth_user_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash  TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id   UUID NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    replaced_by TEXT,
    user_agent  TEXT,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_id_idx ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
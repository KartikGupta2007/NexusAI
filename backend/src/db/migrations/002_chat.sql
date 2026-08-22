-- Persistent chat for NexusAI: conversations owned by a user, messages owned by a conversation.
--
-- Notes on the design:
--   * `messages.id` is a BIGINT identity column and doubles as the message sequence. A single
--     writer assigns it, so it is monotonic per conversation and never ties — unlike
--     `created_at`, where two rows inserted in the same transaction share NOW(). That removes
--     the need for a separate `position` column and for a tie-breaker in the ORDER BY.
--   * `GENERATED ALWAYS` (not BY DEFAULT): the id is the ordering key, so the application must
--     not be able to supply one and desynchronise the sequence.
--   * `role` is a TEXT + CHECK rather than an enum. Adding a value to a Postgres enum cannot be
--     rolled back inside a transaction and removing one requires a type rewrite; a CHECK is
--     edited with a plain ALTER TABLE. Three fixed values are not worth an enum.
--   * Nothing from `users` is copied into `conversations` — `user_id` is the only link, so a
--     renamed or re-emailed account needs no backfill.
--   * There is deliberately NO trigger bumping `conversations.updated_at` on message insert.
--     One chat turn writes two messages (user + assistant), so such a trigger would fire two
--     extra UPDATEs against the same conversation row per turn, and the write path already
--     touches that row explicitly (title generation, then the sidebar timestamp) inside the
--     same transaction. Keeping the bump in the query makes the ordering visible and lockable.
--     If it later becomes unconditional, add an AFTER INSERT trigger in its own migration.

CREATE TABLE IF NOT EXISTS conversations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    role            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT messages_role_valid CHECK (role IN ('user', 'assistant', 'system'))
);

-- Sidebar listing: WHERE user_id = $1 ORDER BY updated_at DESC.
CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations (user_id);

-- Conversation replay: WHERE conversation_id = $1 ORDER BY id ASC. The leading column filters;
-- the trailing id lets the planner walk the index in sort order, which it takes for the paged
-- form (`AND id > $2 ... LIMIT n`) and skips in favour of a bitmap scan + in-memory sort when
-- the whole conversation is fetched at once — both read only this index, never the heap in bulk.
-- Also covers the FK, keeping DELETE-on-users / DELETE-on-conversations cascades off a seq scan.
CREATE INDEX IF NOT EXISTS messages_conversation_id_id_idx ON messages (conversation_id, id);

-- Reuses set_updated_at() from 001_init_auth.sql; fires only when the conversation row itself
-- is updated (title change, or an explicit touch after a message insert).
DROP TRIGGER IF EXISTS conversations_set_updated_at ON conversations;
CREATE TRIGGER conversations_set_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
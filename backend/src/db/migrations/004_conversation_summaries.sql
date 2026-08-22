-- Rolling per-conversation summary, kept out of the message stream.
--
-- Why a separate table rather than a `summary` column on `conversations`:
--   * The sidebar query (`SELECT id, title, created_at, updated_at FROM conversations`)
--     stays narrow. A multi-kilobyte summary living on that row would be read past on
--     every sidebar render, or force TOAST fetches for a column nobody asked for.
--   * Summary rewriting is a different write cadence from conversation renaming. Keeping
--     them apart means summarisation never contends with the conversations row.
--
-- Notes on the design:
--   * `conversation_id` is itself the primary key, which is what makes this strictly 1:1 —
--     one summary per conversation, enforced by the PK rather than by a separate id plus a
--     unique index. It also means the only lookup the app performs
--     (`WHERE conversation_id = $1`) is already served; no extra index is warranted.
--   * No user_id column. Ownership is reachable through `conversations.user_id`, and
--     duplicating it here would create a second copy that could disagree with the first.
--     The repository joins `conversations` to scope every read and write by user.
--   * `last_message_id` is a watermark: the newest message folded into this summary, so the
--     next summarisation pass knows which messages are new rather than re-reading the whole
--     conversation. ON DELETE SET NULL because losing the watermark must degrade to
--     "re-summarise from the start", never to a broken row.
--   * No raw messages are copied here. This table holds only the derived summary text.

CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    summary         TEXT NOT NULL,
    last_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
    message_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT conversation_summaries_summary_not_blank CHECK (length(btrim(summary)) > 0),
    CONSTRAINT conversation_summaries_message_count_non_negative CHECK (message_count >= 0)
);

-- Supports the ON DELETE SET NULL scan when a message row is removed. Without it Postgres
-- sequentially scans this table for every message deletion.
CREATE INDEX IF NOT EXISTS conversation_summaries_last_message_id_idx
    ON conversation_summaries (last_message_id);

-- Reuses set_updated_at() from 001_init_auth.sql. Fires on rewrite, including the
-- ON CONFLICT DO UPDATE path the repository's upsert takes.
DROP TRIGGER IF EXISTS conversation_summaries_set_updated_at ON conversation_summaries;
CREATE TRIGGER conversation_summaries_set_updated_at
    BEFORE UPDATE ON conversation_summaries
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

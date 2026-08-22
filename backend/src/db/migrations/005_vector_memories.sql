-- Durable, user-scoped semantic memory: the text NexusAI has learned, plus its embedding.
--
-- Dimensionality: vector(1024) matches BAAI BGE-M3, the local embedding model this project
-- runs through @huggingface/transformers. 1024 is the model's hidden size, confirmed from
-- its own config.json (`hidden_size: 1024`) and its sentence-transformers pooling config
-- (`word_embedding_dimension: 1024`, `pooling_mode_cls_token: true`). The same number is
-- exported as EMBEDDING_DIMENSIONS from src/services/embedding.services.ts, and
-- src/scripts/verifyEmbeddings.ts asserts the constant, the live model output, and this
-- column all agree — a mismatch fails loudly instead of silently rejecting inserts.
--
-- Notes on the design:
--   * Memories are scoped to a user, never global. `user_id` is NOT NULL and every read in
--     vectorMemory.repository.ts filters on it, so one account's remembered context can
--     never surface in another's retrieval. ON DELETE CASCADE means deleting a user erases
--     their memories outright, which is the behaviour a privacy request requires.
--   * `conversation_id` is nullable with ON DELETE SET NULL. A memory is meant to outlive
--     the conversation that produced it — that is the entire point of extracting durable
--     knowledge rather than storing transcripts — so deleting a conversation must keep the
--     memory and merely forget its provenance. It is NOT part of the retrieval filter.
--   * `content` holds only Claude-extracted, privacy-filtered knowledge. Raw messages are
--     never copied here; `messages` remains the sole record of the transcript.
--   * The unique index on (user_id, md5(content)) stops the same fact being re-embedded and
--     re-stored on every turn, which is the usual way a memory table degenerates. md5() is
--     indexed rather than `content` itself because btree cannot index unbounded text.
--
-- Deliberately NOT created here: an HNSW/IVFFlat index.
--   At current scale (0 rows, and a per-user candidate set that stays small for a long
--   while) an exact scan over the user_id filter is both faster than an approximate index
--   and always correct. HNSW would also be applied *after* the user_id filter, so a
--   filtered ANN search can return fewer than the requested K. Add it when a single user's
--   memory count reaches the low thousands:
--       CREATE INDEX vector_memories_embedding_hnsw_idx
--           ON vector_memories USING hnsw (embedding vector_cosine_ops);
--   Cosine (`<=>` / vector_cosine_ops) is the metric the repository queries with; BGE-M3
--   output is L2-normalised, so cosine and inner product rank identically, and cosine stays
--   correct even if normalisation is ever turned off.

CREATE TABLE IF NOT EXISTS vector_memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    content         TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'conversation',
    embedding       VECTOR(1024) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT vector_memories_content_not_blank CHECK (length(btrim(content)) > 0),
    CONSTRAINT vector_memories_source_valid
        CHECK (source IN ('conversation', 'web_search', 'user_provided'))
);

-- Every similarity query pre-filters by owner, so this is the access path that matters.
CREATE INDEX IF NOT EXISTS vector_memories_user_id_idx
    ON vector_memories (user_id);

-- Supports the ON DELETE SET NULL scan when a conversation is removed.
CREATE INDEX IF NOT EXISTS vector_memories_conversation_id_idx
    ON vector_memories (conversation_id);

-- Idempotent writes: re-extracting a fact we already hold is a no-op, not a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS vector_memories_user_content_uniq
    ON vector_memories (user_id, md5(content));

DROP TRIGGER IF EXISTS vector_memories_set_updated_at ON vector_memories;
CREATE TRIGGER vector_memories_set_updated_at
    BEFORE UPDATE ON vector_memories
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- Enables pgvector, the extension NexusAI's semantic memory stores embeddings with.
--
-- Notes on the design:
--   * Enablement is its own migration and creates no tables. Installing an extension is a
--     one-off, database-level act, while the tables that carry `vector` columns arrive in
--     later migrations that can be rewritten without this one ever running again.
--   * No SCHEMA clause, matching `CREATE EXTENSION pgcrypto` in 001_init_auth.sql. With
--     search_path `"$user", public` the extension installs into `public`, so the `vector`
--     type resolves unqualified from the connections the app already uses.
--   * No version pin. This Neon branch offers 0.8.6 by default (supplying the ivfflat and
--     hnsw index methods); pinning would make the migration fail outright on a branch
--     carrying a different build, and nothing here relies on version-specific behaviour.
--   * IF NOT EXISTS makes the statement idempotent. Single execution is guaranteed by the
--     runner: migrate.ts records the filename in schema_migrations after a successful
--     apply and skips the file from then on.

CREATE EXTENSION IF NOT EXISTS vector;

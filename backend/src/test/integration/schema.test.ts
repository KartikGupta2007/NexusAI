/** Audit sections 6 and 8 — the live schema: constraints, FK actions, indexes, migrations. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { EMBEDDING_DIMENSIONS } from "../../constants.ts";
import { closePool, query } from "../../db/pool.ts";
import { cleanupProbes, createProbeConversation, createProbeUser, expectPgError, PG } from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

const constraintDefs = async (table: string) =>
    (await query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint WHERE conrelid = $1::regclass`, [table],
    )).rows;

const indexNames = async (table: string) =>
    (await query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`, [table],
    )).rows.map((r) => r.indexname);

describe("migrations", () => {
    it("every migration is recorded, in order", async () => {
        // Exhaustive on purpose: a new migration must be added here deliberately, so an
        // unexpected or missing one is a failure rather than something the test ignores.
        const { rows } = await query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`);
        assert.deepEqual(rows.map((r) => r.name), [
            "001_init_auth.sql", "002_chat.sql", "003_pgvector.sql",
            "004_conversation_summaries.sql", "005_vector_memories.sql",
            "006_message_sources.sql", "007_message_sources_blank_checks.sql",
        ]);
    });

    it("pgvector is enabled", async () => {
        const { rows } = await query<{ extversion: string }>(
            `SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
        assert.equal(rows.length, 1);
        assert.ok(rows[0]!.extversion.length > 0);
    });

    it("every expected table exists and none were dropped", async () => {
        const { rows } = await query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
        assert.deepEqual(rows.map((r) => r.table_name), [
            "conversation_summaries", "conversations", "message_sources", "messages",
            "refresh_tokens", "schema_migrations", "users", "vector_memories",
        ]);
    });
});

describe("vector_memories schema", () => {
    it("embedding is declared vector(1024), matching EMBEDDING_DIMENSIONS", async () => {
        const { rows } = await query<{ atttypmod: number; udt: string }>(
            `SELECT a.atttypmod, t.typname AS udt
               FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
              WHERE a.attrelid = 'vector_memories'::regclass AND a.attname = 'embedding'`);
        assert.equal(rows[0]!.udt, "vector");
        assert.equal(rows[0]!.atttypmod, EMBEDDING_DIMENSIONS);
        assert.equal(rows[0]!.atttypmod, 1024);
    });

    it("has the expected primary key, FK actions and CHECKs", async () => {
        const defs = await constraintDefs("vector_memories");
        const find = (pred: (d: string) => boolean) => defs.find((d) => pred(d.def));

        assert.ok(find((d) => d.startsWith("PRIMARY KEY (id)")), "id primary key");
        assert.ok(find((d) => /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/.test(d)),
            "user_id must CASCADE");
        assert.ok(find((d) => /FOREIGN KEY \(conversation_id\) REFERENCES conversations\(id\) ON DELETE SET NULL/.test(d)),
            "conversation_id must SET NULL");
        assert.ok(find((d) => /CHECK.*source/s.test(d)), "source CHECK");
        assert.ok(find((d) => /btrim\(content\)/s.test(d)), "content-not-blank CHECK");
    });

    it("NOT NULL is enforced on user_id, content and embedding", async () => {
        const { rows } = await query<{ attname: string; attnotnull: boolean }>(
            `SELECT attname, attnotnull FROM pg_attribute
              WHERE attrelid='vector_memories'::regclass AND attnum > 0 AND NOT attisdropped`);
        const byName = new Map(rows.map((r) => [r.attname, r.attnotnull]));
        for (const col of ["id", "user_id", "content", "source", "embedding", "created_at", "updated_at"]) {
            assert.equal(byName.get(col), true, `${col} should be NOT NULL`);
        }
        assert.equal(byName.get("conversation_id"), false, "conversation_id must stay nullable");
    });

    it("the documented indexes exist", async () => {
        const names = await indexNames("vector_memories");
        for (const idx of [
            "vector_memories_user_id_idx",
            "vector_memories_conversation_id_idx",
            "vector_memories_user_content_uniq",
        ]) {
            assert.ok(names.includes(idx), `${idx} missing — have ${names.join(", ")}`);
        }
    });

    it("the source CHECK actually rejects an unlisted value", async () => {
        const user = await createProbeUser();
        await expectPgError(
            query(`INSERT INTO vector_memories (user_id, content, embedding, source)
                   VALUES ($1, 'x', array_fill(0.1::real, ARRAY[1024])::vector, 'not_a_source')`, [user]),
            PG.CHECK,
        );
    });

    it("a wrong-width vector is rejected by the column type", async () => {
        const user = await createProbeUser();
        await assert.rejects(
            query(`INSERT INTO vector_memories (user_id, content, embedding)
                   VALUES ($1, 'x', array_fill(0.1::real, ARRAY[512])::vector)`, [user]),
            /expected 1024 dimensions|different vector dimensions/i,
        );
    });
});

describe("conversation_summaries schema", () => {
    it("conversation_id is the primary key, so the relation is strictly 1:1", async () => {
        const defs = await constraintDefs("conversation_summaries");
        assert.ok(defs.some((d) => d.def === "PRIMARY KEY (conversation_id)"),
            `expected PK on conversation_id, got ${defs.map((d) => d.def).join(" | ")}`);
    });

    it("has CASCADE to conversations and SET NULL to messages", async () => {
        const defs = (await constraintDefs("conversation_summaries")).map((d) => d.def);
        assert.ok(defs.some((d) => /FOREIGN KEY \(conversation_id\) REFERENCES conversations\(id\) ON DELETE CASCADE/.test(d)));
        assert.ok(defs.some((d) => /FOREIGN KEY \(last_message_id\) REFERENCES messages\(id\) ON DELETE SET NULL/.test(d)));
    });

    it("a second summary for the same conversation is impossible", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await query(`INSERT INTO conversation_summaries (conversation_id, summary) VALUES ($1,'first')`, [conv]);
        await expectPgError(
            query(`INSERT INTO conversation_summaries (conversation_id, summary) VALUES ($1,'second')`, [conv]),
            PG.UNIQUE,
        );
    });
});

describe("messages and conversations schema", () => {
    it("messages.role CHECK rejects an unlisted role", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await expectPgError(
            query(`INSERT INTO messages (conversation_id, role, content) VALUES ($1,'tool','x')`, [conv]),
            PG.CHECK,
        );
    });

    it("messages.id is a BIGINT identity that no caller can set", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        const { rows } = await query<{ is_identity: string; identity_generation: string; data_type: string }>(
            `SELECT is_identity, identity_generation, data_type FROM information_schema.columns
              WHERE table_name='messages' AND column_name='id'`);
        assert.equal(rows[0]!.data_type, "bigint");
        assert.equal(rows[0]!.is_identity, "YES");
        assert.equal(rows[0]!.identity_generation, "ALWAYS");
        await assert.rejects(
            query(`INSERT INTO messages (id, conversation_id, role, content) VALUES (1,$1,'user','x')`, [conv]),
            /non-DEFAULT value/,
        );
    });

    it("messages.conversation_id FK cascades from conversations", async () => {
        const defs = (await constraintDefs("messages")).map((d) => d.def);
        assert.ok(defs.some((d) => /FOREIGN KEY \(conversation_id\) REFERENCES conversations\(id\) ON DELETE CASCADE/.test(d)));
    });

    it("the documented conversation/message indexes exist", async () => {
        assert.ok((await indexNames("conversations")).includes("conversations_user_id_idx"));
        assert.ok((await indexNames("messages")).includes("messages_conversation_id_id_idx"));
    });

    it("conversations.user_id FK cascades from users", async () => {
        const defs = (await constraintDefs("conversations")).map((d) => d.def);
        assert.ok(defs.some((d) => /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/.test(d)));
    });
});

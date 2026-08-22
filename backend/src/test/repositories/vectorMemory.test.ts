/** Audit section 4 — vector_memories lifecycle: insert, recall, ranking, isolation, cascades. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { EMBEDDING_DIMENSIONS, MEMORY_SOURCES } from "../../constants.ts";
import { closePool, query } from "../../db/pool.ts";
import {
    countMemoriesForUser,
    deleteMemoryForUser,
    insertMemories,
    searchMemoriesByEmbedding,
} from "../../repositories/vectorMemory.repository.ts";
import { embedText } from "../../services/embedding.services.ts";
import { recallRelevantMemories, rememberTexts } from "../../services/memory.services.ts";
import {
    addProbeMessages,
    cleanupProbes,
    createProbeConversation,
    createProbeUser,
    expectApiError,
    expectPgError,
    expectRejection,
    PG,
} from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

const PGVECTOR_FACT = "The NexusAI backend stores embeddings in Neon Postgres using pgvector.";
const ORM_FACT = "The user prefers raw SQL repositories over an ORM such as Prisma.";
const BAKING_FACT = "Sourdough starter needs feeding twice a day before baking.";

describe("vector memories", () => {
    it("A/M: a memory is embedded and stored as a 1024-dimension vector", async () => {
        const user = await createProbeUser();
        const stored = await rememberTexts(user, [PGVECTOR_FACT]);
        assert.equal(stored.length, 1);
        assert.equal(stored[0]!.content, PGVECTOR_FACT);
        assert.equal(stored[0]!.source, "conversation", "default source");
        assert.equal(stored[0]!.conversationId, null);

        const { rows } = await query<{ dims: number }>(
            `SELECT vector_dims(embedding) AS dims FROM vector_memories WHERE user_id = $1`,
            [user],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.dims, EMBEDDING_DIMENSIONS);
        assert.equal(rows[0]!.dims, 1024);
    });

    it("B/C/N: retrieval returns relevant memories, ranked above unrelated ones", async () => {
        const user = await createProbeUser();
        await rememberTexts(user, [PGVECTOR_FACT, ORM_FACT, BAKING_FACT]);

        const hits = await recallRelevantMemories(user, "How does NexusAI do vector search?", {
            limit: 3, maxDistance: 2,
        });
        assert.equal(hits.length, 3);
        assert.equal(hits[0]!.content, PGVECTOR_FACT, "most relevant memory must rank first");

        const baking = hits.find((h) => h.content === BAKING_FACT)!;
        assert.ok(hits[0]!.similarity > baking.similarity, "unrelated memory outranked a relevant one");

        // Similarity must be a sane cosine reading, not a raw distance leaking through.
        for (const hit of hits) {
            assert.ok(hit.similarity <= 1.0001 && hit.similarity >= -1.0001, `${hit.similarity}`);
        }
        // Descending similarity == ascending distance.
        const sims = hits.map((h) => h.similarity);
        assert.deepEqual(sims, [...sims].sort((x, y) => y - x), "results not ordered by closeness");
    });

    it("O: maxDistance excludes weak hits", async () => {
        const user = await createProbeUser();
        await rememberTexts(user, [PGVECTOR_FACT, BAKING_FACT]);

        const loose = await recallRelevantMemories(user, "vector search in Postgres", { maxDistance: 2 });
        const tight = await recallRelevantMemories(user, "vector search in Postgres", { maxDistance: 0.5 });

        assert.equal(loose.length, 2);
        assert.ok(tight.length < loose.length, "a tighter threshold must drop something");
        assert.ok(!tight.some((h) => h.content === BAKING_FACT), "the weak hit should be gone");

        const none = await recallRelevantMemories(user, "vector search", { maxDistance: 0 });
        assert.equal(none.length, 0, "a zero threshold should admit nothing");
    });

    it("P: retrieval respects the requested limit", async () => {
        const user = await createProbeUser();
        await rememberTexts(user, [PGVECTOR_FACT, ORM_FACT, BAKING_FACT, "Neon branches are cheap."]);
        assert.equal((await recallRelevantMemories(user, "postgres", { limit: 2, maxDistance: 2 })).length, 2);
        assert.equal((await recallRelevantMemories(user, "postgres", { limit: 1, maxDistance: 2 })).length, 1);
        assert.equal(await countMemoriesForUser(user), 4);
    });

    it("D: user B cannot retrieve user A's memories", async () => {
        const a = await createProbeUser(), b = await createProbeUser();
        await rememberTexts(a, [PGVECTOR_FACT, ORM_FACT]);

        assert.deepEqual(await recallRelevantMemories(b, "vector search in Postgres", { maxDistance: 2 }), []);
        assert.equal(await countMemoriesForUser(b), 0);

        // The repository is the boundary, not just the service.
        const embedding = await embedText("vector search in Postgres");
        assert.deepEqual(await searchMemoriesByEmbedding({ userId: b, embedding, limit: 10, maxDistance: 2 }), []);
        assert.equal((await searchMemoriesByEmbedding({ userId: a, embedding, limit: 10, maxDistance: 2 })).length, 2);
    });

    it("E: storing identical content twice does not create two rows", async () => {
        const user = await createProbeUser();
        assert.equal((await rememberTexts(user, [ORM_FACT])).length, 1);
        assert.equal((await rememberTexts(user, [ORM_FACT])).length, 0, "second store must be a no-op");
        assert.equal(await countMemoriesForUser(user), 1);

        // Trimming is part of the identity: padded content must collide with the trimmed row.
        assert.equal((await rememberTexts(user, [`   ${ORM_FACT}   `])).length, 0);
        assert.equal(await countMemoriesForUser(user), 1);
    });

    it("E2: duplicates inside a single batch collapse to one row", async () => {
        const user = await createProbeUser();
        const stored = await rememberTexts(user, [ORM_FACT, ORM_FACT, PGVECTOR_FACT]);
        assert.equal(await countMemoriesForUser(user), 2, "intra-batch duplicate leaked a second row");
        assert.equal(stored.length, 2);
    });

    it("F: the same content is allowed for two different users", async () => {
        const a = await createProbeUser(), b = await createProbeUser();
        assert.equal((await rememberTexts(a, [ORM_FACT])).length, 1);
        assert.equal((await rememberTexts(b, [ORM_FACT])).length, 1, "uniqueness must be per user");
        assert.equal(await countMemoriesForUser(a), 1);
        assert.equal(await countMemoriesForUser(b), 1);
    });

    it("G/H: a memory links to a conversation, and survives its deletion as NULL", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await addProbeMessages(conv, [{ role: "user", content: "hello" }]);

        const [stored] = await rememberTexts(user, [PGVECTOR_FACT], { conversationId: conv });
        assert.equal(stored!.conversationId, conv);

        await query(`DELETE FROM conversations WHERE id = $1`, [conv]);

        const { rows } = await query<{ id: string; conversation_id: string | null }>(
            `SELECT id, conversation_id FROM vector_memories WHERE user_id = $1`,
            [user],
        );
        assert.equal(rows.length, 1, "the memory must outlive its conversation");
        assert.equal(rows[0]!.conversation_id, null, "conversation_id must be SET NULL, not cascaded");
    });

    it("I: deleting the user cascades their memories away", async () => {
        const user = await createProbeUser();
        await rememberTexts(user, [PGVECTOR_FACT, ORM_FACT]);
        assert.equal(await countMemoriesForUser(user), 2);

        await query(`DELETE FROM users WHERE id = $1`, [user]);
        assert.equal(await countMemoriesForUser(user), 0);
    });

    it("J: blank content is rejected before it reaches the database", async () => {
        const user = await createProbeUser();
        await expectApiError(rememberTexts(user, [""]), 400);
        await expectApiError(rememberTexts(user, ["  \t "]), 400);
        await expectApiError(rememberTexts(user, [PGVECTOR_FACT, "   "]), 400);
        assert.equal(await countMemoriesForUser(user), 0, "a rejected batch must store nothing");
    });

    it("K: an invalid source is rejected by the CHECK constraint", async () => {
        const user = await createProbeUser();
        const embedding = await embedText("bad source");
        await expectRejection(
            insertMemories({
                userId: user,
                conversationId: null,
                source: "hacked" as never,
                items: [{ content: "bad source", embedding }],
            }),
        );
        assert.equal(await countMemoriesForUser(user), 0);
    });

    it("L: every documented source value is accepted", async () => {
        for (const source of MEMORY_SOURCES) {
            const user = await createProbeUser();
            const [stored] = await rememberTexts(user, [`a fact recorded from ${source}`], { source });
            assert.equal(stored!.source, source);
        }
        assert.deepEqual([...MEMORY_SOURCES], ["conversation", "web_search", "user_provided"]);
    });

    it("a wrong-width vector is refused before it reaches Postgres", async () => {
        const user = await createProbeUser();
        await expectRejection(
            insertMemories({
                userId: user, conversationId: null, source: "conversation",
                items: [{ content: "too short", embedding: [1, 2, 3] }],
            }),
        );
        await expectRejection(
            insertMemories({
                userId: user, conversationId: null, source: "conversation",
                items: [{ content: "not finite", embedding: Array(EMBEDDING_DIMENSIONS).fill(Number.NaN) }],
            }),
        );
        assert.equal(await countMemoriesForUser(user), 0);
    });

    it("deleteMemoryForUser is scoped to the owner", async () => {
        const a = await createProbeUser(), b = await createProbeUser();
        const [mem] = await rememberTexts(a, [PGVECTOR_FACT]);
        assert.equal(await deleteMemoryForUser(mem!.id, b), false, "B must not delete A's memory");
        assert.equal(await countMemoriesForUser(a), 1);
        assert.equal(await deleteMemoryForUser(mem!.id, a), true);
        assert.equal(await countMemoriesForUser(a), 0);
    });

    it("NOT NULL and FK constraints hold at the database level", async () => {
        const user = await createProbeUser();
        const embedding = await embedText("constraint probe");
        const literal = `[${embedding.join(",")}]`;

        await expectPgError(
            query(`INSERT INTO vector_memories (user_id, content, embedding) VALUES (NULL, 'x', $1::vector)`, [literal]),
            PG.NOT_NULL,
        );
        await expectPgError(
            query(`INSERT INTO vector_memories (user_id, content, embedding) VALUES ($1, NULL, $2::vector)`, [user, literal]),
            PG.NOT_NULL,
        );
        await expectPgError(
            query(`INSERT INTO vector_memories (user_id, content, embedding) VALUES ($1, 'x', NULL)`, [user]),
            PG.NOT_NULL,
        );
        await expectPgError(
            query(
                `INSERT INTO vector_memories (user_id, conversation_id, content, embedding)
                 VALUES ($1, gen_random_uuid(), 'orphan', $2::vector)`, [user, literal]),
            PG.FOREIGN_KEY,
        );
    });
});

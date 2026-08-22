/**
 * End-to-end proof that the local embedding stack works against the real database.
 *
 * Checks, in order:
 *   1. pgvector is enabled in Neon.
 *   2. The vector_memories.embedding column's declared width.
 *   3. BGE-M3 loads and runs locally, with no embedding API involved.
 *   4. The vector it produces is exactly as wide as that column.
 *   5. A real embedding inserts into pgvector.
 *   6. Similarity search ranks a related memory above an unrelated one.
 *   7. A second user cannot retrieve the first user's memories.
 *
 * Uses real embeddings throughout — never a mock, because the point is to catch a
 * dimension or pooling mismatch that a fake vector would hide.
 *
 * Everything it writes is removed at the end: it creates two probe users and deletes them,
 * which cascades their memories away. Run with: npm run verify:embeddings
 */
import { randomUUID } from "node:crypto";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID } from "../constants.ts";
import { closePool, query, withTransaction } from "../db/pool.ts";
import { embedText } from "../services/embedding.services.ts";
import { rememberTexts, recallRelevantMemories } from "../services/memory.services.ts";

let failures = 0;

const check = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
};

const createProbeUser = async () => {
    const { rows } = await query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, auth_provider)
         VALUES ($1, 'probe-not-a-real-hash', 'embedding probe', 'password')
         RETURNING id`,
        [`embed-probe-${randomUUID()}@example.com`],
    );
    return rows[0]!.id;
};

const main = async () => {
    const probeUsers: string[] = [];

    try {
        console.log("\n1. pgvector extension");
        const { rows: ext } = await query<{ extversion: string }>(
            `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
        );
        check("pgvector enabled in Neon", ext.length === 1, ext[0] ? `v${ext[0].extversion}` : "not found");

        console.log("\n2. database column width");
        // atttypmod carries the declared dimension for a vector column.
        const { rows: col } = await query<{ dimensions: number }>(
            `SELECT atttypmod AS dimensions
               FROM pg_attribute
              WHERE attrelid = 'vector_memories'::regclass
                AND attname = 'embedding'`,
        );
        const columnDimensions = col[0]?.dimensions ?? -1;
        check(
            "vector_memories.embedding is vector(N)",
            columnDimensions > 0,
            `N = ${columnDimensions}`,
        );

        console.log(`\n3. local model (${EMBEDDING_MODEL_ID})`);
        const started = Date.now();
        const embedding = await embedText(
            "PostgreSQL supports vector similarity search using pgvector.",
        );
        check("BGE-M3 ran locally", true, `${((Date.now() - started) / 1000).toFixed(1)}s`);
        check("no embedding API key required", !process.env.OPENAI_API_KEY);

        console.log("\n4. dimensions agree");
        check("model output matches constant", embedding.length === EMBEDDING_DIMENSIONS,
            `${embedding.length} vs ${EMBEDDING_DIMENSIONS}`);
        check("model output matches DB column", embedding.length === columnDimensions,
            `${embedding.length} vs ${columnDimensions}`);
        check("vector is unit length (normalized)",
            Math.abs(Math.sqrt(embedding.reduce((s, v) => s + v * v, 0)) - 1) < 1e-3);
        check("all values finite", embedding.every(Number.isFinite));

        console.log("\n5. insertion into pgvector");
        const userA = await createProbeUser();
        probeUsers.push(userA);
        const stored = await rememberTexts(userA, [
            "The NexusAI backend stores embeddings in Neon Postgres using the pgvector extension.",
            "The user prefers raw SQL repositories over an ORM such as Prisma.",
            "Sourdough needs a starter fed twice a day before baking.",
        ]);
        check("memories inserted", stored.length === 3, `${stored.length} rows`);

        const { rows: readBack } = await query<{ dims: number }>(
            `SELECT vector_dims(embedding) AS dims FROM vector_memories WHERE user_id = $1 LIMIT 1`,
            [userA],
        );
        check("stored vector has correct width", readBack[0]?.dims === EMBEDDING_DIMENSIONS,
            `${readBack[0]?.dims}`);

        console.log("\n6. similarity search");
        const hits = await recallRelevantMemories(userA, "How does NexusAI do vector search?", {
            limit: 3,
            maxDistance: 2,
        });
        check("search returned hits", hits.length > 0, `${hits.length} hits`);
        const top = hits[0];
        check("most relevant memory ranked first",
            top?.content.includes("pgvector") === true,
            top ? `"${top.content.slice(0, 48)}..." @ ${top.similarity.toFixed(4)}` : "no hits");
        const baking = hits.find((h) => h.content.includes("Sourdough"));
        check("unrelated memory ranked below relevant one",
            !baking || (top !== undefined && top.similarity > baking.similarity),
            baking ? `sourdough @ ${baking.similarity.toFixed(4)}` : "filtered out entirely");

        console.log("\n7. user isolation");
        const userB = await createProbeUser();
        probeUsers.push(userB);
        const leaked = await recallRelevantMemories(userB, "How does NexusAI do vector search?", {
            limit: 5,
            maxDistance: 2,
        });
        check("user B sees none of user A's memories", leaked.length === 0,
            `${leaked.length} leaked`);

        console.log("\n8. duplicate suppression");
        const again = await rememberTexts(userA, [
            "The user prefers raw SQL repositories over an ORM such as Prisma.",
        ]);
        check("re-storing a known fact is a no-op", again.length === 0, `${again.length} inserted`);
    } finally {
        if (probeUsers.length > 0) {
            await withTransaction((client) =>
                client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [probeUsers]),
            );
            const { rows } = await query<{ count: number }>(
                `SELECT COUNT(*)::int AS count FROM vector_memories WHERE user_id = ANY($1::uuid[])`,
                [probeUsers],
            );
            console.log(`\ncleanup: probe users deleted, ${rows[0]?.count ?? "?"} memories remaining`);
        }
        await closePool();
    }

    console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
    process.exit(failures === 0 ? 0 : 1);
};

main().catch((error: unknown) => {
    console.error("\nverification crashed:", error);
    process.exit(1);
});

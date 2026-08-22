import type { PoolClient, QueryResultRow } from "pg";
import { EMBEDDING_DIMENSIONS, MEMORY_SOURCES } from "../constants.ts";
import { pool, query } from "../db/pool.ts";

/** Derived from MEMORY_SOURCES so the union and the SQL CHECK cannot drift apart. */
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export interface VectorMemoryRow {
    id: string;
    conversation_id: string | null;
    content: string;
    source: MemorySource;
    created_at: Date;
    updated_at: Date;
}

/** A retrieval hit: the memory plus how close it was to the query. */
export interface VectorMemoryMatchRow extends VectorMemoryRow {
    /** pgvector cosine distance, 0 (identical direction) .. 2 (opposite). */
    distance: number;
}

/** Shape returned to callers. */
export interface PublicMemory {
    id: string;
    conversationId: string | null;
    content: string;
    source: MemorySource;
    createdAt: Date;
    updatedAt: Date;
}

export interface PublicMemoryMatch extends PublicMemory {
    /** 1 - cosine distance, so 1.0 is an exact match and higher is better. */
    similarity: number;
}

export const toPublicMemory = (row: VectorMemoryRow): PublicMemory => ({
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

export const toPublicMemoryMatch = (row: VectorMemoryMatchRow): PublicMemoryMatch => ({
    ...toPublicMemory(row),
    // Reported as similarity rather than distance because "higher is better" is what every
    // caller wants, and it keeps pgvector's metric from leaking into the API.
    similarity: 1 - Number(row.distance),
});

type Executor = Pick<PoolClient, "query"> | typeof pool;

const run = <T extends QueryResultRow>(
    executor: Executor | undefined,
    text: string,
    params: unknown[],
) => (executor ? executor.query<T>(text, params) : query<T>(text, params));

const MEMORY_COLUMNS = `id, conversation_id, content, source, created_at, updated_at`;

/**
 * pgvector's text input format: `[0.1,0.2,...]`.
 *
 * node-postgres has no vector type, so the literal is built here — once — rather than at
 * each call site. The dimension is checked first: sending the wrong width produces a
 * database error naming only the column, which is a poor way to discover a model mismatch.
 */
const toVectorLiteral = (embedding: number[]): string => {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
            `Embedding has ${embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
        );
    }
    if (!embedding.every(Number.isFinite)) {
        throw new Error("Embedding contains non-finite values");
    }
    return `[${embedding.join(",")}]`;
};

/**
 * Stores memories for one user.
 *
 * `user_id` is supplied by the caller from the authenticated session and written into every
 * row, which is what keeps retrieval isolated later. ON CONFLICT DO NOTHING makes re-storing
 * a fact we already hold a no-op against the (user_id, md5(content)) unique index, so a
 * summariser that re-extracts the same knowledge each turn does not grow the table.
 *
 * Returns only the rows actually inserted; duplicates are silently skipped.
 */
export const insertMemories = async (
    input: {
        userId: string;
        conversationId: string | null;
        source: MemorySource;
        items: { content: string; embedding: number[] }[];
    },
    executor?: Executor,
) => {
    if (input.items.length === 0) return [];

    // One multi-row INSERT rather than a statement per memory: a turn typically yields a
    // handful of memories and this keeps it to a single round trip.
    const values: unknown[] = [input.userId, input.conversationId, input.source];
    const tuples = input.items.map((item) => {
        const content = `$${values.length + 1}`;
        const embedding = `$${values.length + 2}`;
        values.push(item.content.trim(), toVectorLiteral(item.embedding));
        return `($1, $2, ${content}, ${embedding}::vector, $3)`;
    });

    const { rows } = await run<VectorMemoryRow>(
        executor,
        `INSERT INTO vector_memories (user_id, conversation_id, content, embedding, source)
              VALUES ${tuples.join(", ")}
         ON CONFLICT (user_id, md5(content)) DO NOTHING
           RETURNING ${MEMORY_COLUMNS}`,
        values,
    );
    return rows;
};

/**
 * Top-K nearest memories for one user.
 *
 * `WHERE user_id = $1` is not an optimisation — it is the isolation boundary. Without it the
 * nearest neighbours of a query would be drawn from every account's memories, which is
 * precisely the leak this table is designed to prevent. It is in the SQL rather than applied
 * to the results so that no caller can omit it.
 *
 * `<=>` is cosine distance, matching the metric documented in 005_vector_memories.sql.
 * ORDER BY distance ASC puts the closest first; `maxDistance` lets a caller drop weak hits
 * rather than padding the context window with irrelevant memories.
 */
export const searchMemoriesByEmbedding = async (
    input: {
        userId: string;
        embedding: number[];
        limit: number;
        maxDistance?: number;
    },
    executor?: Executor,
) => {
    const { rows } = await run<VectorMemoryMatchRow>(
        executor,
        `SELECT ${MEMORY_COLUMNS}, (embedding <=> $2::vector) AS distance
           FROM vector_memories
          WHERE user_id = $1
            AND ($4::float8 IS NULL OR (embedding <=> $2::vector) <= $4::float8)
       ORDER BY embedding <=> $2::vector
          LIMIT $3`,
        [input.userId, toVectorLiteral(input.embedding), input.limit, input.maxDistance ?? null],
    );
    return rows;
};

/** Total memories held for one user — useful for deciding when an ANN index is worth adding. */
export const countMemoriesForUser = async (userId: string, executor?: Executor) => {
    const { rows } = await run<{ count: number }>(
        executor,
        `SELECT COUNT(*)::int AS count FROM vector_memories WHERE user_id = $1`,
        [userId],
    );
    return rows[0]?.count ?? 0;
};

/** Deletes one memory, scoped to its owner so it cannot be used to remove another user's. */
export const deleteMemoryForUser = async (
    memoryId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rowCount } = await run(
        executor,
        `DELETE FROM vector_memories WHERE id = $1 AND user_id = $2`,
        [memoryId, userId],
    );
    return (rowCount ?? 0) > 0;
};

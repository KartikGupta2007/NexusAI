import {
    insertMemories,
    searchMemoriesByEmbedding,
    toPublicMemory,
    toPublicMemoryMatch,
    type MemorySource,
    type PublicMemory,
    type PublicMemoryMatch,
} from "../repositories/vectorMemory.repository.ts";
import {
    MEMORY_DEFAULT_MAX_DISTANCE,
    MEMORY_DEFAULT_RECALL_LIMIT,
    MEMORY_MAX_PER_CALL,
} from "../constants.ts";
import { embedText, embedTexts } from "./embedding.services.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Semantic memory: text in, relevant text out.
 *
 * This is the seam that keeps the embedding model out of the rest of the application. Callers
 * pass strings and receive memories; nothing above this layer knows that BGE-M3 exists, what
 * its dimension is, or that pgvector uses cosine distance.
 */

/**
 * Embeds and stores extracted memories for one user.
 *
 * `contents` is expected to be the privacy-filtered output of the extraction step, not raw
 * conversation text — this function embeds whatever it is given, so the filtering must have
 * already happened upstream.
 *
 * Duplicates against what the user already holds are skipped by the repository, so the
 * returned array can be shorter than the input.
 */
export const rememberTexts = async (
    userId: string,
    contents: string[],
    options: { conversationId?: string | null; source?: MemorySource } = {},
): Promise<PublicMemory[]> => {
    // An empty list is the expected result of "nothing worth remembering this turn", so it
    // is a no-op rather than an error.
    if (contents.length === 0) return [];

    if (contents.length > MEMORY_MAX_PER_CALL) {
        throw ApiError.badRequest(
            `Cannot store more than ${MEMORY_MAX_PER_CALL} memories at once (received ${contents.length})`,
        );
    }

    // embedTexts embeds each item independently (same path as embedText), so a stored memory
    // and a later query vector are directly comparable. It trims and rejects empty strings.
    const embeddings = await embedTexts(contents);

    const rows = await insertMemories({
        userId,
        conversationId: options.conversationId ?? null,
        source: options.source ?? "conversation",
        items: contents.map((content, index) => ({ content, embedding: embeddings[index]! })),
    });

    return rows.map(toPublicMemory);
};

/**
 * Finds the memories most relevant to a query, for one user only.
 *
 * The query is embedded with the same model and pooling as the stored memories — mixing
 * models or pooling strategies produces vectors that are numerically comparable but
 * semantically meaningless, which shows up as retrieval that is subtly always wrong.
 */
export const recallRelevantMemories = async (
    userId: string,
    queryText: string,
    options: { limit?: number; maxDistance?: number } = {},
): Promise<PublicMemoryMatch[]> => {
    const embedding = await embedText(queryText);

    const rows = await searchMemoriesByEmbedding({
        userId,
        embedding,
        limit: options.limit ?? MEMORY_DEFAULT_RECALL_LIMIT,
        maxDistance: options.maxDistance ?? MEMORY_DEFAULT_MAX_DISTANCE,
    });

    return rows.map(toPublicMemoryMatch);
};

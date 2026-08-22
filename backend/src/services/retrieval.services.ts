import type { PublicMemoryMatch } from "../repositories/vectorMemory.repository.ts";
import {
    getConversationContext,
    type ContextMessage,
} from "./conversationContext.services.ts";
import { recallRelevantMemories } from "./memory.services.ts";

/**
 * Context assembly: everything NexusAI already knows that bears on the current query.
 *
 * This layer only *gathers*. It performs no web search, calls no LLM, writes nothing, and
 * decides nothing about how the context is eventually rendered into a prompt. Its whole job is
 * to answer one question — given a user, a conversation, and what they just asked, what
 * existing context is relevant — and to answer it without owning any of the underlying reads.
 *
 * Every source is reached through the service that already owns it:
 *   - conversationContext.services.ts  for the summary and the recent messages
 *   - memory.services.ts               for semantic recall
 *
 * That is deliberate rather than incidental. Those modules hold the ownership predicates, the
 * ordering guarantees, and the vector-search details; reimplementing any of it here would
 * create a second copy of a security rule, which is the kind of copy that drifts.
 */

/** Assembled context for one turn. Every field is populated, though each may be empty. */
export interface QueryContext {
    /** The rolling conversation summary, or null when the conversation has none yet. */
    conversationSummary: string | null;
    /** Oldest to newest — the natural reading order for an LLM prompt. */
    recentMessages: ContextMessage[];
    /** Semantically nearest memories for this user, closest first. */
    relevantMemories: PublicMemoryMatch[];
}

export interface BuildQueryContextInput {
    /** From the verified access token. Never from a request body, query string, or route param. */
    userId: string;
    conversationId: string;
    /** The user's current query, embedded to drive semantic recall. */
    query: string;
}

/**
 * Gathers the conversation summary, the tail of the conversation, and the memories most
 * relevant to `query`.
 *
 * A single object parameter rather than three positional strings: `userId`, `conversationId`,
 * and `query` are all strings, so positionally they are trivially transposable at a call site
 * and the compiler could not tell. The project already uses this shape for multi-field inputs
 * (insertMemories, searchMemoriesByEmbedding, storeRefreshToken).
 *
 * Limits are not parameters. The recent-message window comes from
 * CONVERSATION_RECENT_MESSAGE_LIMIT via getConversationContext, and the recall limit and
 * distance threshold from MEMORY_DEFAULT_RECALL_LIMIT / MEMORY_DEFAULT_MAX_DISTANCE via
 * recallRelevantMemories — all applied by those services from constants.ts. Accepting
 * overrides here would put a second set of defaults in a second place.
 *
 * Empty is a valid answer for every field: a brand-new conversation legitimately yields
 * `{ conversationSummary: null, recentMessages: [], relevantMemories: [] }`. None of those is
 * an error.
 *
 * @throws ApiError 404 when the conversation does not exist or belongs to another user —
 *         the existing semantics of getConversationContext, unchanged.
 */
export const buildQueryContext = async ({
    userId,
    conversationId,
    query,
}: BuildQueryContextInput): Promise<QueryContext> => {
    // Independent reads: the conversation context does not inform semantic recall, and recall
    // is scoped to the authenticated user rather than to the conversation. Running them
    // concurrently keeps one embedding pass and two database round trips off each other's
    // critical path.
    //
    // If the conversation is not this user's, getConversationContext rejects with the 404 and
    // Promise.all surfaces it. The recall resolves rather than rejecting, so nothing is left
    // unhandled — and it could only ever have returned this same user's own memories, so the
    // wasted work leaks nothing.
    const [conversation, relevantMemories] = await Promise.all([
        getConversationContext(userId, conversationId),
        recallRelevantMemories(userId, query),
    ]);

    return {
        conversationSummary: conversation.summary,
        recentMessages: conversation.recentMessages,
        relevantMemories,
    };
};

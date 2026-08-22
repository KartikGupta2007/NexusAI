import { findConversationForUser } from "../repositories/conversation.repository.ts";
import {
    findSummaryByConversationId,
    toPublicConversationSummary,
    upsertConversationSummary,
    type PublicConversationSummary,
} from "../repositories/conversationSummary.repository.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Persistence for the rolling conversation summary.
 *
 * This layer stores and retrieves the summary; it does not produce it. Generating the new
 * summary text is Claude's job, and the caller that owns that prompt passes the result to
 * saveConversationSummary(). Keeping the LLM call out of here means the summary can be
 * re-persisted, backfilled, or corrected without touching the model.
 */

/**
 * The summary of a conversation, or null when it has none yet.
 *
 * "No summary" is the normal state for the first turn of every conversation and must not be
 * an error. A conversation that does not exist — or belongs to somebody else — is a 404, and
 * the two cases are distinguished here rather than in SQL: the repository's join cannot tell
 * them apart, so ownership is established first and the absent summary is reported as null.
 */
export const getConversationSummary = async (
    userId: string,
    conversationId: string,
): Promise<PublicConversationSummary | null> => {
    const conversation = await findConversationForUser(conversationId, userId);
    if (!conversation) {
        throw ApiError.notFound("Conversation not found");
    }

    const row = await findSummaryByConversationId(conversationId, userId);
    return row ? toPublicConversationSummary(row) : null;
};

/**
 * Writes the summary Claude produced for a completed turn.
 *
 * `lastMessageId` is the newest message folded into this text, so the next summarisation pass
 * can read only what has arrived since. Passing null means "this summary covers the whole
 * conversation as of now", which is the safe fallback when the watermark is unknown.
 */
export const saveConversationSummary = async (
    userId: string,
    conversationId: string,
    input: { summary: string; lastMessageId?: string | number | null; messageCount?: number },
): Promise<PublicConversationSummary> => {
    const summary = input.summary.trim();
    if (summary.length === 0) {
        // The column has a not-blank CHECK; failing here gives a 400 instead of a 500 from
        // a constraint violation.
        throw ApiError.badRequest("summary must not be empty");
    }

    const row = await upsertConversationSummary({
        conversationId,
        userId,
        summary,
        lastMessageId: input.lastMessageId ?? null,
        messageCount: input.messageCount ?? 0,
    });

    if (!row) {
        // The upsert's SELECT matched no conversation for this user. Same 404 as a missing
        // conversation, so the endpoint cannot be used to probe for other users' ids.
        throw ApiError.notFound("Conversation not found");
    }

    return toPublicConversationSummary(row);
};

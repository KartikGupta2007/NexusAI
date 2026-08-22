import { CONVERSATION_RECENT_MESSAGE_LIMIT } from "../constants.ts";
import {
    findRecentMessagesForUserConversation,
    type MessageRow,
} from "../repositories/conversation.repository.ts";
import { getConversationSummary } from "./conversationSummary.services.ts";

/**
 * Assembles the conversation context sent to Claude with a new query.
 *
 * The whole point is *not* sending the full transcript on every request. Two things stand in
 * for it: the rolling summary carries the long-lived context of the conversation, and the
 * last few messages carry the immediate thread — what "it" refers to, what was just
 * suggested. Together they stay a fixed size no matter how long the conversation runs.
 *
 * This service only reads context. Web search, semantic memory, and the Claude call itself
 * are assembled by the caller from this plus their own sources.
 */

/**
 * Deliberately narrower than PublicMessage: a prompt needs the role and the text, not ids or
 * timestamps. Keeping the id out also means this shape cannot accidentally leak the BIGINT
 * sequence into a prompt, and it maps straight onto Claude's message format.
 */
export interface ContextMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

export interface ConversationContext {
    /** Null until the conversation has been summarised — normal on the first turn. */
    summary: string | null;
    /** Chronological, oldest to newest, so it reads as a transcript. */
    recentMessages: ContextMessage[];
}

const toContextMessage = (row: MessageRow): ContextMessage => ({
    role: row.role,
    content: row.content,
});

/**
 * Reads the context for one conversation, for one user.
 *
 * Ownership is enforced twice over, in SQL both times. getConversationSummary() resolves the
 * conversation with `WHERE id = $1 AND user_id = $2` and throws the project's 404 when that
 * matches nothing, and the recent-messages query independently joins `conversations` on
 * `user_id`. Neither path can be reached with a conversation id alone, so a caller who
 * forgets to check ownership still cannot read another user's thread — and because the 404 is
 * the same whether the conversation is missing or someone else's, this cannot be used to
 * probe for other users' conversation ids.
 *
 * @throws ApiError 404 when the conversation does not exist or belongs to another user.
 */
export const getConversationContext = async (
    userId: string,
    conversationId: string,
    options: { recentMessageLimit?: number } = {},
): Promise<ConversationContext> => {
    const limit = options.recentMessageLimit ?? CONVERSATION_RECENT_MESSAGE_LIMIT;

    // Concurrent because neither read depends on the other, and both round trips are on the
    // critical path of a user waiting for an answer. If the caller does not own the
    // conversation, getConversationSummary rejects with the 404 and Promise.all surfaces it;
    // the message query resolves to an empty array rather than rejecting, so nothing is left
    // unhandled.
    const [summary, recentRows] = await Promise.all([
        getConversationSummary(userId, conversationId),
        findRecentMessagesForUserConversation(conversationId, userId, limit),
    ]);

    return {
        summary: summary?.summary ?? null,
        // The query returns newest-first so Postgres can stop at LIMIT; reversing here is
        // what turns "the last four messages" into something that reads as a conversation.
        recentMessages: [...recentRows].reverse().map(toContextMessage),
    };
};

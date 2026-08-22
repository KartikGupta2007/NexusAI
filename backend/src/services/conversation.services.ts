import {
    findConversationsByUserId,
    findConversationWithMessages,
    toPublicConversation,
    toPublicMessage,
    type PublicConversation,
    type PublicMessage,
} from "../repositories/conversation.repository.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Domain layer for reading chat history.
 *
 * Note what is *not* here: an ownership check. `userId` is threaded into the SQL WHERE
 * clause by the repository, so authorisation is a property of the query itself. Repeating
 * it here as `if (row.user_id !== userId)` would be a second, weaker copy of a rule the
 * database already enforces — and the kind of copy that gets skipped in the next endpoint.
 */

export const getConversations = async (userId: string): Promise<PublicConversation[]> => {
    const rows = await findConversationsByUserId(userId);
    return rows.map(toPublicConversation);
};

export const getConversation = async (
    userId: string,
    conversationId: string,
): Promise<{ conversation: PublicConversation; messages: PublicMessage[] }> => {
    const found = await findConversationWithMessages(conversationId, userId);

    if (!found) {
        // Deliberately identical whether the conversation is missing or belongs to someone
        // else. Distinguishing the two would turn this endpoint into an oracle for
        // enumerating other users' conversation ids.
        throw ApiError.notFound("Conversation not found");
    }

    return {
        conversation: toPublicConversation(found.conversation),
        messages: found.messages.map(toPublicMessage),
    };
};
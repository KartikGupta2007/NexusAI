import { z } from "zod";

/**
 * `conversations.id` is a UUID. Rejecting non-UUIDs here means a malformed id becomes a
 * clean 400 "Validation failed" instead of Postgres raising `invalid input syntax for type
 * uuid`, which the error handler can only report as a 500.
 */
export const conversationIdParamSchema = z.object({
    conversationId: z.string().uuid("conversationId must be a valid conversation id"),
});

export type ConversationIdParams = z.infer<typeof conversationIdParamSchema>;
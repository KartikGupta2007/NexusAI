import { z } from "zod";
import { CHAT_MAX_QUERY_CHARS } from "../constants.ts";

/**
 * The chat body carries only the question.
 *
 * `conversationId` is deliberately absent: on /chat/:conversationId it comes from the path, and
 * on /chat/new there is nothing to continue. `.strict()` rejects a body that tries to smuggle
 * `conversationId` or `userId` in rather than quietly ignoring it, so a client attempting either
 * gets a clear 400 instead of behaviour that looks like it worked.
 */
export const chatQuerySchema = z
    .object({
        query: z
            .string()
            .trim()
            .min(1, "query must not be empty")
            .max(CHAT_MAX_QUERY_CHARS, `query must be at most ${CHAT_MAX_QUERY_CHARS} characters`),
    })
    .strict();

export type ChatQueryInput = z.infer<typeof chatQuerySchema>;

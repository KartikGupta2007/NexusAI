import type { Request, Response } from "express";
import { getConversation, getConversations } from "../services/conversation.services.ts";
import { sendSuccess } from "../utils/ApiResponse.ts";
import { asyncHandler } from "../utils/asyncHandler.ts";
import type { ConversationIdParams } from "../validators/conversation.validators.ts";

/**
 * GET /api/v1/conversations
 *
 * Sidebar listing: metadata only, most recently active first.
 */
export const listConversations = asyncHandler(async (req: Request, res: Response) => {
    // req.user is set by requireAuth. The user id comes from the verified access token and
    // from nowhere else — never a query string, body field, or route param.
    const user = req.user!;

    const conversations = await getConversations(user.id);

    return sendSuccess(res, 200, "Conversations fetched successfully", { conversations });
});

/**
 * GET /api/v1/conversations/:conversationId
 *
 * The full conversation with every message in sequence. `conversationId` names *which*
 * conversation is wanted; it never says who is asking, so it cannot be used to reach
 * another account's history.
 */
export const getConversationById = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { conversationId } = req.params as ConversationIdParams;

    const { conversation, messages } = await getConversation(user.id, conversationId);

    return sendSuccess(res, 200, "Conversation fetched successfully", { conversation, messages });
});
import type { Request, Response } from "express";
import { getMessageSources } from "../services/messageSource.services.ts";
import { sendSuccess } from "../utils/ApiResponse.ts";
import { asyncHandler } from "../utils/asyncHandler.ts";
import type { MessageIdParams } from "../validators/messageSource.validators.ts";

/**
 * GET /api/v1/messages/:messageId/sources
 *
 * The web sources cited by one assistant message, in citation order. Used when a conversation
 * is reloaded and its citations have to be rendered again.
 */
export const listMessageSources = asyncHandler(async (req: Request, res: Response) => {
    // req.user is set by requireAuth, from the verified access token. The user id never comes
    // from the URL, body, or query string — :messageId says *which* message is wanted, never
    // who is asking.
    const user = req.user!;
    const { messageId } = req.params as MessageIdParams;

    const sources = await getMessageSources(user.id, messageId);

    return sendSuccess(res, 200, "Message sources fetched successfully", { sources });
});

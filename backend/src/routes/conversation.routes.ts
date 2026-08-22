import { Router } from "express";
import {
    getConversationById,
    listConversations,
} from "../controllers/conversation.controllers.ts";
import { requireAuth } from "../middlewares/auth.middleware.ts";
import { validateParams } from "../middlewares/validate.middleware.ts";
import { conversationIdParamSchema } from "../validators/conversation.validators.ts";

const conversationRouter = Router();

// Every route here is private. requireAuth precedes validateParams so an unauthenticated
// caller gets 401 rather than a 400 that would confirm the id format — same ordering as
// DELETE /user/sessions/:sessionId.
conversationRouter.get("/", requireAuth, listConversations);
conversationRouter.get(
    "/:conversationId",
    requireAuth,
    validateParams(conversationIdParamSchema),
    getConversationById,
);

export default conversationRouter;
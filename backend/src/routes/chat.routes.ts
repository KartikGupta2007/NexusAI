import { Router } from "express";
import { continueChat, startChat } from "../controllers/chat.controllers.ts";
import { requireAuth } from "../middlewares/auth.middleware.ts";
import { validateBody, validateParams } from "../middlewares/validate.middleware.ts";
import { chatQuerySchema } from "../validators/chat.validators.ts";
import { conversationIdParamSchema } from "../validators/conversation.validators.ts";

const chatRouter = Router();

// "/new" is registered first on purpose: Express matches in order, so "/:conversationId" would
// otherwise capture the literal string "new" as a conversation id.
chatRouter.post("/new", requireAuth, validateBody(chatQuerySchema), startChat);

chatRouter.post(
    "/:conversationId",
    requireAuth,
    validateParams(conversationIdParamSchema),
    validateBody(chatQuerySchema),
    continueChat,
);

export default chatRouter;

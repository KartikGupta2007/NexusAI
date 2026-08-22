import { Router } from "express";
import { listMessageSources } from "../controllers/messageSource.controllers.ts";
import { requireAuth } from "../middlewares/auth.middleware.ts";
import { validateParams } from "../middlewares/validate.middleware.ts";
import { messageIdParamSchema } from "../validators/messageSource.validators.ts";

/**
 * Messages are addressed by their own id rather than nested under a conversation.
 * `messages.id` is a global BIGINT identity, so a conversation id in the path would be
 * redundant — a second value to validate, and a second way for a request to be inconsistent
 * with itself.
 *
 * Read-only by design. Sources are produced by the answer pipeline alongside an assistant
 * reply, never submitted by a client, so creation and deletion stay service-level operations
 * (attachMessageSources / clearMessageSources). Exposing write endpoints here would let a user
 * rewrite the citations under an assistant answer, which is a provenance problem, not a
 * feature.
 */
const messageRouter = Router();

// requireAuth precedes validateParams so an unauthenticated caller gets 401 rather than a 400
// that would confirm the id format — same ordering as the conversation routes.
messageRouter.get(
    "/:messageId/sources",
    requireAuth,
    validateParams(messageIdParamSchema),
    listMessageSources,
);

export default messageRouter;

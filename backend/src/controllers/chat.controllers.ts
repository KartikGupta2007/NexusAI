import type { Request, Response } from "express";
import {
    assertConversationOwned,
    chatDepsForRequest,
    processChatMessage,
    startNewChat,
    type ChatTurnResult,
} from "../services/chat.services.ts";
import { deductQueryCredit } from "../services/credit.services.ts";
import { ApiError } from "../utils/ApiError.ts";
import { asyncHandler } from "../utils/asyncHandler.ts";
import type { ConversationIdParams } from "../validators/conversation.validators.ts";
import type { ChatQueryInput } from "../validators/chat.validators.ts";

/**
 * Both chat endpoints stream over Server-Sent Events.
 *
 * The consequence worth knowing: once the first byte is written the status code is already 200,
 * so a failure *after* that point can only be reported as an `error` event, not an HTTP status.
 * Everything that can be rejected up front — auth, body and param validation, conversation
 * ownership — is therefore resolved before the stream opens, and those still return real 401 /
 * 400 / 404 responses. Only search and generation failures arrive as events.
 *
 * Event protocol:
 *   start   { conversationId }        once the conversation is known
 *   token   { text }                  incremental answer text, in order
 *   sources { sources }               after persistence, so ids are real
 *   done    { conversationId, title, creditsRemaining }
 *                                     title is non-null only for a new chat
 *   error   { code, message }         terminal
 */
const SSE_HEADERS = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Stops nginx and similar buffering the stream into uselessness.
    "x-accel-buffering": "no",
} as const;

type Emit = (event: string, data: unknown) => void;

const openStream = (res: Response): { emit: Emit; isOpen: () => boolean } => {
    res.status(200).set(SSE_HEADERS);
    res.flushHeaders();

    let open = true;
    // The client can leave mid-answer. Writing to a closed socket throws, so stop emitting.
    res.once("close", () => { open = false; });

    return {
        emit: (event, data) => {
            if (!open) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        isOpen: () => open,
    };
};

const streamTurn = async (
    res: Response,
    run: (emit: Emit) => Promise<ChatTurnResult>,
    meta: { creditsRemaining: number },
): Promise<void> => {
    const { emit, isOpen } = openStream(res);

    try {
        const turn = await run(emit);
        emit("sources", { sources: turn.sources });
        // Balance rides on `done` only. Repeating it on every token would bloat the stream with a
        // number that cannot change mid-answer — the charge already happened before it opened.
        emit("done", {
            conversationId: turn.conversationId,
            title: turn.title,
            creditsRemaining: meta.creditsRemaining,
        });
    } catch (error) {
        // Headers are already sent, so the error handler cannot set a status. Report it in-band
        // with the same code the JSON API would have used, and never leak an unexpected message.
        const isApiError = error instanceof ApiError;
        if (!isApiError) console.error("[chat] unexpected failure", error);

        emit("error", {
            code: isApiError ? error.code : "INTERNAL_ERROR",
            message: isApiError ? error.message : "Internal Server Error",
        });
    } finally {
        if (isOpen()) res.end();
    }
};

/** POST /api/v1/chat/new */
export const startChat = asyncHandler(async (req: Request, res: Response) => {
    // The owner is the authenticated user, from the verified token — never from the body.
    const user = req.user!;
    const { query } = req.body as ChatQueryInput;

    // Charged before the stream opens, so an empty balance is a real 402 with a JSON body. After
    // the first byte the status is fixed at 200 and this could only be an error event. Nothing
    // expensive has run yet either: no conversation, no message, no search, no model call.
    const creditsRemaining = await deductQueryCredit(user.id);

    await streamTurn(res, (emit) =>
        startNewChat({ userId: user.id, query }, chatDepsForRequest(), {
            onToken: (text) => emit("token", { text }),
            // Emitted as soon as the row exists so the client can update its URL before the
            // answer finishes.
            onConversationCreated: (conversationId) => emit("start", { conversationId }),
        }),
        { creditsRemaining },
    );
});

/** POST /api/v1/chat/:conversationId */
export const continueChat = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { conversationId } = req.params as ConversationIdParams;
    const { query } = req.body as ChatQueryInput;

    // Ownership first, so a foreign or unknown conversation is a real 404 *and* costs nothing.
    await assertConversationOwned(user.id, conversationId);

    // Then the charge, still before the stream opens. Same reasoning as /chat/new.
    const creditsRemaining = await deductQueryCredit(user.id);

    await streamTurn(res, (emit) => {
        emit("start", { conversationId });
        return processChatMessage({ userId: user.id, conversationId, query }, chatDepsForRequest(), {
            onToken: (text) => emit("token", { text }),
        });
    }, { creditsRemaining });
});

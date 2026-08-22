import { postStream } from "./client.ts";
import { ApiError } from "./errors.ts";
import { readSSEFrames } from "./sse.ts";
import type { ChatStreamEvent, Source } from "../types/api.ts";

/**
 * The chat endpoints, as a typed event stream.
 *
 * Both flows share everything below the endpoint choice, so the SSE parsing and event typing
 * exist once. Callers get an async iterable of `ChatStreamEvent` and never see a frame, a
 * buffer, or a JSON.parse.
 */

/** Frames whose payload does not match the protocol are dropped rather than trusted. */
const toEvent = (event: string, data: string): ChatStreamEvent | null => {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }
    if (payload === null || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;

    switch (event) {
        case "start":
            return typeof record.conversationId === "string"
                ? { type: "start", conversationId: record.conversationId }
                : null;

        case "token":
            // An empty string is legitimate and must not be treated as a malformed frame.
            return typeof record.text === "string" ? { type: "token", text: record.text } : null;

        case "sources":
            return Array.isArray(record.sources)
                ? { type: "sources", sources: record.sources as Source[] }
                : null;

        case "done":
            return typeof record.conversationId === "string"
                ? {
                      type: "done",
                      conversationId: record.conversationId,
                      title: typeof record.title === "string" ? record.title : null,
                      creditsRemaining:
                          typeof record.creditsRemaining === "number" ? record.creditsRemaining : 0,
                  }
                : null;

        case "error":
            return {
                type: "error",
                code: typeof record.code === "string" ? record.code : "UNKNOWN",
                message:
                    typeof record.message === "string" ? record.message : "Something went wrong.",
            };

        default:
            return null;
    }
};

const streamChatEvents = async function* (
    path: string,
    query: string,
    signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
    // Only `query` is ever sent. Ownership, identity and credits are the backend's to decide.
    const body = await postStream(path, { query }, signal);

    for await (const frame of readSSEFrames(body, signal)) {
        const event = toEvent(frame.event, frame.data);
        if (event) yield event;
    }
};

/**
 * Starts a new conversation. The backend creates it and reports its id in the `start` event,
 * well before the answer finishes — which is what lets the URL update immediately.
 */
export const streamNewChat = (query: string, signal?: AbortSignal) =>
    streamChatEvents("/chat/new", query, signal);

/** Continues an existing conversation. The id travels in the path, never the body. */
export const streamExistingChat = (conversationId: string, query: string, signal?: AbortSignal) => {
    if (!conversationId) {
        throw new ApiError(400, "BAD_REQUEST", "A conversation id is required to continue a chat.");
    }
    return streamChatEvents(`/chat/${encodeURIComponent(conversationId)}`, query, signal);
};

import type { PersistedMessage, Source } from "../types/api.ts";

/**
 * The chat thread as a pure state machine.
 *
 * All streaming behaviour lives here rather than in a component: appending tokens to one
 * message, attaching sources, marking failures, ending a stream. Being a pure reducer means
 * every rule in the streaming contract is testable without a renderer, and a component can
 * never accidentally hold a second source of truth.
 */

export type ChatMessageStatus = "complete" | "streaming" | "stopped" | "failed";

export interface ChatMessage {
    /** Stable across a message's life. A client id until the row exists, then never changes. */
    key: string;
    /** The database id, once known. Null for optimistic messages. */
    id: string | null;
    role: "user" | "assistant";
    content: string;
    sources: Source[];
    status: ChatMessageStatus;
    /**
     * True for a turn that arrived during this session rather than being loaded from history.
     *
     * Only these animate in: replaying a saved thread should present it, not perform it. Deciding
     * this at dispatch time — where the difference between "submitted" and "loaded" is already
     * known — keeps it out of render, where a component would have to remember what it had shown
     * before.
     */
    fresh: boolean;
    /** User-facing failure text, when status is "failed". */
    error?: string;
}

export interface ChatState {
    /** Null on a brand-new chat, until the backend's `start` event names it. */
    conversationId: string | null;
    title: string | null;
    messages: ChatMessage[];
    /** True from submit until the stream ends, however it ends. */
    isStreaming: boolean;
}

export const initialChatState: ChatState = {
    conversationId: null,
    title: null,
    messages: [],
    isStreaming: false,
};

export type ChatAction =
    | { type: "reset" }
    | { type: "loaded"; conversationId: string; title: string | null; messages: ChatMessage[] }
    | { type: "submit"; userKey: string; assistantKey: string; query: string }
    | { type: "start"; conversationId: string }
    | { type: "token"; text: string }
    | { type: "sources"; sources: Source[] }
    | { type: "done"; conversationId: string; title: string | null }
    | { type: "failed"; message: string }
    | { type: "stopped" }
    | { type: "retryRemoved" };

/** The assistant message currently being written — always the last one, by construction. */
const streamingIndex = (messages: ChatMessage[]): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]!.role === "assistant" && messages[index]!.status === "streaming") {
            return index;
        }
    }
    return -1;
};

const updateAt = (
    messages: ChatMessage[],
    index: number,
    patch: Partial<ChatMessage>,
): ChatMessage[] =>
    messages.map((message, position) => (position === index ? { ...message, ...patch } : message));

export const chatReducer = (state: ChatState, action: ChatAction): ChatState => {
    switch (action.type) {
        case "reset":
            return initialChatState;

        case "loaded":
            return {
                conversationId: action.conversationId,
                title: action.title,
                messages: action.messages,
                isStreaming: false,
            };

        case "submit":
            // The user's message appears immediately, with one empty assistant message to stream
            // into. Every later token appends to *this* message — no token ever creates another.
            return {
                ...state,
                isStreaming: true,
                messages: [
                    ...state.messages,
                    {
                        key: action.userKey,
                        id: null,
                        role: "user",
                        content: action.query,
                        sources: [],
                        status: "complete",
                        fresh: true,
                    },
                    {
                        key: action.assistantKey,
                        id: null,
                        role: "assistant",
                        content: "",
                        sources: [],
                        status: "streaming",
                        fresh: true,
                    },
                ],
            };

        case "start":
            // Arrives before the answer, so the route can update while tokens are still coming.
            return state.conversationId === action.conversationId
                ? state
                : { ...state, conversationId: action.conversationId };

        case "token": {
            const index = streamingIndex(state.messages);
            // An empty token is a no-op rather than a re-render.
            if (index === -1 || action.text.length === 0) return state;
            return {
                ...state,
                messages: updateAt(state.messages, index, {
                    content: state.messages[index]!.content + action.text,
                }),
            };
        }

        case "sources": {
            const index = streamingIndex(state.messages);
            if (index === -1) return state;
            return { ...state, messages: updateAt(state.messages, index, { sources: action.sources }) };
        }

        case "done": {
            const index = streamingIndex(state.messages);
            return {
                ...state,
                conversationId: action.conversationId,
                // Null means "unchanged" — continuing a conversation never renames it, so the
                // existing title must survive.
                title: action.title ?? state.title,
                isStreaming: false,
                messages: index === -1 ? state.messages : updateAt(state.messages, index, { status: "complete" }),
            };
        }

        case "failed": {
            const index = streamingIndex(state.messages);
            // The user's message is deliberately kept so they can retry without retyping.
            return {
                ...state,
                isStreaming: false,
                messages:
                    index === -1
                        ? state.messages
                        : updateAt(state.messages, index, { status: "failed", error: action.message }),
            };
        }

        case "stopped": {
            const index = streamingIndex(state.messages);
            if (index === -1) return { ...state, isStreaming: false };
            const partial = state.messages[index]!;
            return {
                ...state,
                isStreaming: false,
                // Whatever streamed before the stop is kept — it was really generated, and the
                // backend already charged for it.
                messages: updateAt(state.messages, index, {
                    status: partial.content.length > 0 ? "stopped" : "failed",
                    ...(partial.content.length === 0 ? { error: "Stopped before any answer arrived." } : {}),
                }),
            };
        }

        case "retryRemoved": {
            // Drops a failed assistant placeholder so a retry does not stack placeholders.
            const last = state.messages[state.messages.length - 1];
            if (!last || last.role !== "assistant" || last.status === "complete") return state;
            return { ...state, messages: state.messages.slice(0, -1) };
        }

        default:
            return state;
    }
};

/** Maps persisted rows into thread messages when a conversation is opened or reloaded. */
export const toChatMessages = (
    messages: PersistedMessage[],
    sourcesByMessageId: Record<string, Source[]> = {},
): ChatMessage[] =>
    messages
        // `system` messages are prompt scaffolding, not conversation.
        .filter((message) => message.role !== "system")
        .map((message) => ({
            key: message.id,
            id: message.id,
            role: message.role as "user" | "assistant",
            content: message.content,
            sources: sourcesByMessageId[message.id] ?? [],
            status: "complete" as const,
            fresh: false,
        }));

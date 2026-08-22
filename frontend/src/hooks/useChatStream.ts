import { useCallback, useEffect, useReducer, useRef } from "react";
import { streamExistingChat, streamNewChat } from "../api/chat.ts";
import { getConversation, getMessageSources } from "../api/conversations.ts";
import { ApiError, describeError } from "../api/errors.ts";
import { chatReducer, initialChatState, toChatMessages } from "../state/chatReducer.ts";
import type { ChatState } from "../state/chatReducer.ts";
import type { Source } from "../types/api.ts";

/**
 * Drives one conversation: loads it, submits a query, and pumps the SSE stream into the reducer.
 *
 * The endpoint is chosen from state, never from the user — no conversation id means "new", an id
 * means "continue". Nothing here decides ownership or credits.
 */

interface UseChatStreamOptions {
    /** Route conversation id. Null on the new-chat route. */
    conversationId: string | null;
    /** Called with the id the backend assigns, so the route can move to /chat/:id. */
    onConversationStarted: (conversationId: string) => void;
    /** Called with each backend-reported balance. */
    onCredits: (creditsRemaining: number) => void;
    /** Called when a conversation is created or updated, for the sidebar. */
    onConversationUpdated: (conversationId: string, title: string | null) => void;
}

export interface UseChatStreamResult {
    state: ChatState;
    /** True while the thread's history is being fetched. */
    isLoading: boolean;
    loadError: string | null;
    submit: (query: string) => Promise<void>;
    stop: () => void;
}

export const useChatStream = ({
    conversationId,
    onConversationStarted,
    onCredits,
    onConversationUpdated,
}: UseChatStreamOptions): UseChatStreamResult => {
    const [state, dispatch] = useReducer(chatReducer, initialChatState);
    const [loading, setLoading] = useReducer(
        (_: { isLoading: boolean; error: string | null }, next: { isLoading: boolean; error: string | null }) => next,
        { isLoading: false, error: null },
    );

    const abortRef = useRef<AbortController | null>(null);
    // Guards against a second submit racing the first; `state.isStreaming` updates a tick later.
    const inFlightRef = useRef(false);

    /**
     * The conversation this hook is already showing.
     *
     * Set when a thread is loaded from the backend, and when `start` names a conversation the
     * backend has just created. That second case is the important one: on a new chat the route
     * moves from `/` to `/chat/:id` *while the answer is still streaming*, and without this the
     * effect below could not tell that navigation apart from the user opening a different
     * conversation — so it would abort the very stream that produced the id and refetch a thread
     * whose assistant message has not been written yet.
     */
    const ownedIdRef = useRef<string | null>(null);

    const abort = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        inFlightRef.current = false;
    }, []);

    // Abort on unmount so a stream cannot dispatch into a discarded reducer.
    useEffect(() => abort, [abort]);

    // Load (or clear) the thread whenever the route changes to a *different* conversation.
    useEffect(() => {
        // The route catching up to a conversation this hook already holds is not a navigation,
        // and must not disturb an answer in progress.
        if (conversationId && conversationId === ownedIdRef.current) return;

        abort();
        let cancelled = false;

        if (!conversationId) {
            ownedIdRef.current = null;
            dispatch({ type: "reset" });
            setLoading({ isLoading: false, error: null });
            return () => { cancelled = true; };
        }

        setLoading({ isLoading: true, error: null });

        void (async () => {
            try {
                const { conversation, messages } = await getConversation(conversationId);

                // Sources hang off assistant messages, so replaying a thread needs one request
                // per assistant turn. Fetched in parallel, and a failure for one source list
                // degrades to "no sources" rather than losing the whole conversation.
                const assistantIds = messages.filter((m) => m.role === "assistant").map((m) => m.id);
                const sourceEntries = await Promise.all(
                    assistantIds.map(async (id): Promise<[string, Source[]]> => {
                        try {
                            return [id, await getMessageSources(id)];
                        } catch {
                            return [id, []];
                        }
                    }),
                );

                if (cancelled) return;
                ownedIdRef.current = conversation.id;
                dispatch({
                    type: "loaded",
                    conversationId: conversation.id,
                    title: conversation.title,
                    messages: toChatMessages(messages, Object.fromEntries(sourceEntries)),
                });
                setLoading({ isLoading: false, error: null });
            } catch (error) {
                if (cancelled) return;
                ownedIdRef.current = null;
                dispatch({ type: "reset" });
                setLoading({ isLoading: false, error: describeError(error) });
            }
        })();

        return () => { cancelled = true; };
    }, [conversationId, abort, setLoading]);

    const submit = useCallback(
        async (query: string) => {
            const trimmed = query.trim();
            if (trimmed.length === 0 || inFlightRef.current) return;

            inFlightRef.current = true;
            const controller = new AbortController();
            abortRef.current = controller;

            const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            dispatch({ type: "retryRemoved" });
            dispatch({ type: "submit", userKey: `u-${stamp}`, assistantKey: `a-${stamp}`, query: trimmed });

            // The active conversation id, which `start` may fill in for a brand-new chat.
            let activeId = conversationId ?? state.conversationId;

            try {
                const events = activeId
                    ? streamExistingChat(activeId, trimmed, controller.signal)
                    : streamNewChat(trimmed, controller.signal);

                for await (const event of events) {
                    switch (event.type) {
                        case "start":
                            activeId = event.conversationId;
                            // Claimed before the route moves, so the load effect recognises the
                            // navigation below as this stream's own and leaves it running.
                            ownedIdRef.current = event.conversationId;
                            dispatch({ type: "start", conversationId: event.conversationId });
                            // Moves the route immediately, long before the answer completes.
                            onConversationStarted(event.conversationId);
                            break;

                        case "token":
                            dispatch({ type: "token", text: event.text });
                            break;

                        case "sources":
                            dispatch({ type: "sources", sources: event.sources });
                            break;

                        case "done":
                            dispatch({ type: "done", conversationId: event.conversationId, title: event.title });
                            // Authoritative balance, straight from the backend.
                            onCredits(event.creditsRemaining);
                            onConversationUpdated(event.conversationId, event.title);
                            break;

                        case "error":
                            // An in-band failure: the stream was already open, so this is the
                            // only way the backend can report it.
                            dispatch({ type: "failed", message: describeError(new ApiError(502, event.code, event.message)) });
                            break;
                    }
                }
            } catch (error) {
                // A stop is a deliberate action, not a failure. `stop()` has already recorded the
                // partial answer, and rethrowing would make the composer offer the question back
                // as though it had never been asked. Whether an abort surfaces here at all is a
                // race with the socket — it may instead end the stream cleanly — so this path only
                // has to be harmless, not authoritative.
                if (error instanceof DOMException && error.name === "AbortError") {
                    dispatch({ type: "stopped" });
                    return;
                }
                // Real failures do propagate: the composer restores the text so it can be retried.
                dispatch({ type: "failed", message: describeError(error) });
                throw error;
            } finally {
                inFlightRef.current = false;
                abortRef.current = null;
            }
        },
        [conversationId, state.conversationId, onConversationStarted, onCredits, onConversationUpdated],
    );

    const stop = useCallback(() => {
        if (!abortRef.current) return;
        abort();
        dispatch({ type: "stopped" });
    }, [abort]);

    return { state, isLoading: loading.isLoading, loadError: loading.error, submit, stop };
};

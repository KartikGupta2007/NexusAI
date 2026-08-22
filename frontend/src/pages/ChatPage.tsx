import { useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BrandLockup } from "../components/BrandMark.tsx";
import { Composer } from "../components/Composer.tsx";
import { IconAlert, IconArrowDown, IconSearch } from "../components/Icon.tsx";
import { Message } from "../components/Message.tsx";
import { preloadMarkdown } from "../components/Markdown.tsx";
import { CREDITS_PER_QUERY, SUGGESTIONS } from "../constants.ts";
import { useChatStream } from "../hooks/useChatStream.ts";
import { useStickToBottom } from "../hooks/useStickToBottom.ts";
import { useApp } from "../state/AppContext.tsx";

/**
 * One screen for both flows.
 *
 * The route is the source of truth: `/` is a new chat, `/chat/:conversationId` is an existing one.
 * A refresh therefore restores whatever was open, and the hook picks the endpoint from that id
 * rather than asking the user to choose.
 */
export const ChatPage = () => {
    const { conversationId } = useParams<{ conversationId: string }>();
    const navigate = useNavigate();
    const { credits, setCredits, upsertConversation } = useApp();

    // Replace, not push: the new-chat screen has become this conversation, so Back should leave
    // the app rather than returning to an empty composer that already submitted.
    //
    // The sidebar entry is added here rather than waiting for `done`, so the thread being written
    // is the highlighted one while it is being written. Its real title arrives with `done`.
    const onConversationStarted = useCallback(
        (id: string) => {
            upsertConversation({ id });
            navigate(`/chat/${id}`, { replace: true });
        },
        [navigate, upsertConversation],
    );

    const onConversationUpdated = useCallback(
        (id: string, title: string | null) => upsertConversation({ id, ...(title ? { title } : {}) }),
        [upsertConversation],
    );

    const { state, isLoading, loadError, submit, stop } = useChatStream({
        conversationId: conversationId ?? null,
        onConversationStarted,
        onCredits: setCredits,
        onConversationUpdated,
    });

    const { ref, isPinned, scrollToBottom } = useStickToBottom<HTMLDivElement>(
        // Re-evaluated as text grows, so following tracks the answer rather than message count.
        state.messages[state.messages.length - 1]?.content.length ?? state.messages.length,
    );

    const outOfCredits = credits !== null && credits < CREDITS_PER_QUERY;

    /**
     * `submit` rejects on failure so the composer can restore the text it cleared. Callers that
     * have nothing to restore still have to handle it, or the rejection goes unhandled — the
     * thread has already rendered the error by then.
     *
     * The Markdown chunk is requested at the same moment, so it is usually resident before the
     * first token lands.
     */
    const ask = useCallback(
        (query: string) => {
            preloadMarkdown();
            void submit(query).catch(() => {});
        },
        [submit],
    );

    const lastUserQuery = [...state.messages].reverse().find((m) => m.role === "user")?.content;

    const retry = useCallback(() => {
        if (lastUserQuery) ask(lastUserQuery);
    }, [lastUserQuery, ask]);

    if (isLoading) {
        return (
            <main className="chat">
                <div className="thread">
                    <div className="skeleton-thread" aria-label="Loading conversation" role="status">
                        <span className="skeleton" />
                        <span className="skeleton skeleton-row" />
                        <span className="skeleton skeleton-row" />
                        <span className="skeleton skeleton-row" />
                        <span className="skeleton skeleton-row" />
                    </div>
                </div>
            </main>
        );
    }

    if (loadError) {
        return (
            <main className="chat">
                <div className="thread">
                    <div className="skeleton-thread">
                        <div className="notice notice-error" role="alert">
                            <IconAlert />
                            <span>{loadError}</span>
                            <button type="button" className="link-button" onClick={() => navigate("/")}>
                                Start a new chat
                            </button>
                        </div>
                    </div>
                </div>
            </main>
        );
    }

    const isEmpty = state.messages.length === 0;

    return (
        <main className="chat">
            <div className="thread" ref={ref}>
                {isEmpty ? (
                    <section className="welcome">
                        <div className="welcome-mark">
                            <BrandLockup large />
                        </div>
                        <h1 className="welcome-title">Explore anything.</h1>
                        <p className="welcome-sub">
                            Search the web, reason across sources, and get answers with citations
                            you can check.
                        </p>

                        <p className="suggest-label" id="suggest-label">
                            Try asking
                        </p>
                        <ul className="suggestions" aria-labelledby="suggest-label">
                            {SUGGESTIONS.map((suggestion) => (
                                <li key={suggestion}>
                                    <button
                                        type="button"
                                        className="suggestion"
                                        disabled={outOfCredits}
                                        onClick={() => ask(suggestion)}
                                    >
                                        <IconSearch width={14} height={14} />
                                        {suggestion}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : (
                    <div className="turns">
                        {state.messages.map((message, index) => (
                            <Message
                                key={message.key}
                                message={message}
                                // Set when the turn was dispatched, so replaying history presents
                                // the thread rather than animating every turn back in.
                                isNew={message.fresh}
                                // Retry only on the newest turn; re-running an old one would
                                // append it to the end of the thread out of order.
                                onRetry={
                                    message.status === "failed" && index === state.messages.length - 1
                                        ? retry
                                        : undefined
                                }
                            />
                        ))}
                    </div>
                )}
            </div>

            {!isPinned && !isEmpty ? (
                <button type="button" className="jump-latest" onClick={() => scrollToBottom()}>
                    <IconArrowDown width={13} height={13} />
                    Jump to latest
                </button>
            ) : null}

            <Composer
                onSubmit={submit}
                onStop={stop}
                isStreaming={state.isStreaming}
                disabled={outOfCredits}
                disabledReason={
                    outOfCredits
                        ? `You need ${CREDITS_PER_QUERY} credits to ask a question. Your balance is too low.`
                        : undefined
                }
                autoFocus={isEmpty}
            />
        </main>
    );
};

export default ChatPage;

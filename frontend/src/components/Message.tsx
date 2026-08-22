import { memo } from "react";
import { BrandMark } from "./BrandMark.tsx";
import { Markdown } from "./Markdown.tsx";
import { SourceList } from "./SourceList.tsx";
import { IconAlert } from "./Icon.tsx";
import type { ChatMessage } from "../state/chatReducer.ts";

/**
 * One turn.
 *
 * The question is set as a heading-weight statement rather than a chat bubble: this is a research
 * thread, and the question is the thing each section is about. It is rendered as plain text,
 * deliberately — it is not Markdown, and treating it as such would let a user's own punctuation
 * reformat their message.
 *
 * Memoised because a streaming answer dispatches once per token. Only the message being written
 * changes identity, so every earlier turn skips re-rendering entirely — and `onRetry` is undefined
 * for all but the last turn, which keeps those props stable.
 */
export const Message = memo(
    ({
        message,
        isNew,
        onRetry,
    }: {
        message: ChatMessage;
        isNew?: boolean;
        onRetry?: () => void;
    }) => {
        const entering = isNew ? " turn-enter" : "";

        if (message.role === "user") {
            return (
                <article className={`turn turn-user${entering}`}>
                    <h2 className="user-query">{message.content}</h2>
                </article>
            );
        }

        const isStreaming = message.status === "streaming";
        const hasText = message.content.length > 0;

        return (
            <article className={`turn turn-assistant${entering}`} aria-busy={isStreaming}>
                <div className="answer-head">
                    <BrandMark size={15} thinking={isStreaming} />
                    Answer
                </div>

                {/* Before the first token there is nothing to render but the wait itself. */}
                {!hasText && isStreaming ? (
                    <div className="thinking" role="status">
                        <span className="thinking-label">Searching the web and reading sources…</span>
                    </div>
                ) : null}

                {hasText ? (
                    <>
                        <Markdown content={message.content} sources={message.sources} />
                        {/* A caret only while text is actively arriving. */}
                        {isStreaming ? <span className="caret" aria-hidden="true" /> : null}
                    </>
                ) : null}

                {message.status === "stopped" ? (
                    <p className="notice">Stopped by you.</p>
                ) : null}

                {message.status === "failed" ? (
                    <div className="notice notice-error" role="alert">
                        <IconAlert />
                        <span>{message.error ?? "Something went wrong."}</span>
                        {onRetry ? (
                            <button type="button" className="link-button" onClick={onRetry}>
                                Try again
                            </button>
                        ) : null}
                    </div>
                ) : null}

                <SourceList sources={message.sources} />
            </article>
        );
    },
);

Message.displayName = "Message";

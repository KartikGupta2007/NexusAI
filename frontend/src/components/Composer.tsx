import { useEffect, useRef, useState } from "react";
import { IconAlert, IconArrowUp, IconStop } from "./Icon.tsx";
import { MAX_TEXTAREA_PX } from "../constants.ts";

/**
 * The chat input.
 *
 * Enter sends, Shift+Enter adds a newline. The value is kept locally rather than in shared state
 * so typing does not re-render the thread.
 *
 * The box empties the moment a question is sent — it is in the thread now, and leaving a copy
 * behind for the length of an answer reads as though it had not gone through. A failure puts the
 * text back, which is what makes retrying free.
 */
export const Composer = ({
    onSubmit,
    onStop,
    isStreaming,
    disabled,
    disabledReason,
    autoFocus,
}: {
    onSubmit: (query: string) => Promise<void>;
    onStop: () => void;
    isStreaming: boolean;
    disabled?: boolean;
    disabledReason?: string;
    autoFocus?: boolean;
}) => {
    const [value, setValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    // Grow with the content, up to a ceiling, then scroll internally.
    useEffect(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_PX)}px`;
    }, [value]);

    useEffect(() => {
        if (autoFocus) textareaRef.current?.focus();
    }, [autoFocus]);

    // Returning the caret to the composer after an answer is the usual next action.
    useEffect(() => {
        if (!isStreaming && !disabled) textareaRef.current?.focus({ preventScroll: true });
    }, [isStreaming, disabled]);

    const canSend = value.trim().length > 0 && !isStreaming && !disabled;

    const send = async () => {
        if (!canSend) return;
        const query = value.trim();
        setValue("");
        try {
            await onSubmit(query);
        } catch {
            // Only a genuine failure rejects — stopping resolves normally — so the question comes
            // back exactly as typed. The thread already explains what went wrong.
            setValue(query);
        }
    };

    return (
        <div className="composer-dock">
            <div className="composer">
                {disabled && disabledReason ? (
                    <p className="composer-notice" role="status">
                        <IconAlert />
                        {disabledReason}
                    </p>
                ) : null}

                <form
                    className={`composer-box${disabled ? " is-disabled" : ""}`}
                    onSubmit={(event) => {
                        event.preventDefault();
                        void send();
                    }}
                >
                    <textarea
                        ref={textareaRef}
                        className="composer-input"
                        rows={1}
                        value={value}
                        placeholder={disabled ? "Out of credits" : "Ask anything…"}
                        disabled={disabled}
                        aria-label="Your question"
                        // Long-form entry: let the browser help, but not autocapitalise a query.
                        autoCapitalize="sentences"
                        spellCheck
                        onChange={(event) => setValue(event.target.value)}
                        onKeyDown={(event) => {
                            // `isComposing` guards IME input: Enter mid-composition commits the
                            // candidate, it does not send the message.
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                    />

                    {isStreaming ? (
                        <button
                            type="button"
                            className="composer-action composer-stop"
                            onClick={onStop}
                            aria-label="Stop generating"
                            title="Stop generating"
                        >
                            <IconStop width={14} height={14} />
                        </button>
                    ) : (
                        <button
                            type="submit"
                            className="composer-action composer-send"
                            disabled={!canSend}
                            aria-label="Send"
                            title="Send"
                        >
                            <IconArrowUp width={17} height={17} />
                        </button>
                    )}
                </form>

                <p className="composer-hint">
                    <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
                </p>
            </div>
        </div>
    );
};

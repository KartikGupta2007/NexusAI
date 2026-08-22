import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconCheck, IconCopy } from "./Icon.tsx";
import { COPY_FEEDBACK_MS } from "../constants.ts";

/**
 * A fenced code block with a language label and a copy button.
 *
 * No syntax highlighter. Adding one would mean shipping a grammar bundle far larger than the rest
 * of this application to colour code that, in a search answer, is usually a handful of lines. The
 * monospace treatment, the language label and reliable copying carry the actual value.
 *
 * The text is read from the rendered DOM rather than from the Markdown AST: react-markdown hands
 * `children` as React elements, and walking them to rebuild a string would drift from what the
 * user can actually see. `textContent` is exactly what they would have selected by hand.
 */
export const CodeBlock = ({
    language,
    children,
}: {
    language: string | null;
    children: ReactNode;
}) => {
    const preRef = useRef<HTMLPreElement | null>(null);
    const [copied, setCopied] = useState(false);
    const timer = useRef<number | undefined>(undefined);

    const copy = useCallback(async () => {
        const text = preRef.current?.textContent ?? "";
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
        } catch {
            // Clipboard access can be denied or unavailable over plain HTTP. Staying silent is
            // right: the code is on screen and still selectable by hand.
        }
    }, []);

    return (
        <div className="code">
            <div className="code-bar">
                <span className="code-lang">{language ?? "code"}</span>
                <button
                    type="button"
                    className={`code-copy${copied ? " is-copied" : ""}`}
                    onClick={() => void copy()}
                    aria-label={copied ? "Code copied" : "Copy code"}
                >
                    {copied ? <IconCheck /> : <IconCopy />}
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <pre ref={preRef}>{children}</pre>
        </div>
    );
};

import { Suspense, lazy, memo } from "react";
import type { Source } from "../types/api.ts";

/**
 * The Markdown boundary.
 *
 * react-markdown plus remark-gfm and their unified/micromark dependencies are by far the largest
 * thing this app renders, and nothing needs them until an assistant answer exists — not the login
 * screen, not the empty state, not a thread that is still loading. Splitting them out here keeps
 * them off the critical path for every one of those.
 *
 * While the chunk is in flight the fallback shows the same text as pre-wrapped plain text. That
 * is deliberate rather than a spinner: the words are already streaming in, and a reader should be
 * able to start reading them before a formatter arrives. Because both states occupy the same
 * column at the same size, the swap does not move the page.
 *
 * Memoised on content and sources, so a token arriving in one message does not re-parse the
 * Markdown of every other message in the thread.
 */

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer.tsx"));

/**
 * Starts fetching the renderer before it is needed.
 *
 * Called when a query is submitted, so the chunk is usually resident by the time the first token
 * lands and the reader never sees the plain-text fallback at all.
 */
export const preloadMarkdown = (): void => {
    void import("./MarkdownRenderer.tsx");
};

export const Markdown = memo(
    ({ content, sources = [] }: { content: string; sources?: Source[] }) => (
        <Suspense fallback={<div className="markdown markdown-plain">{content}</div>}>
            <MarkdownRenderer content={content} sources={sources} />
        </Suspense>
    ),
);

Markdown.displayName = "Markdown";

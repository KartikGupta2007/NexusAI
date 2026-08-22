import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock.tsx";
import { Citation } from "./Citation.tsx";
import { CITATION_PATTERN } from "../constants.ts";
import type { Source } from "../types/api.ts";

/**
 * The real Markdown renderer. Loaded on demand — see Markdown.tsx for why.
 *
 * react-markdown builds React elements from an AST and never sets innerHTML, so model output
 * cannot inject markup. Raw HTML in the source is left un-rendered by default, which is exactly
 * what is wanted for untrusted text. No sanitizer is needed because no HTML is ever parsed.
 *
 * Partial Markdown is expected: mid-stream the text may end inside an unclosed fence or list. The
 * parser tolerates that and simply re-renders as more arrives.
 */

// ── Inline citations ─────────────────────────────────────────────────────────

/** A hast node, in the shape this walk needs. */
interface HastNode {
    type: string;
    tagName?: string;
    value?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
}

const citeElement = (position: number): HastNode => ({
    type: "element",
    tagName: "cite-ref",
    properties: { dataPosition: String(position) },
    children: [],
});

/** Splits one text node around any resolvable citations it contains. */
const splitTextNode = (value: string, positions: Set<number>): HastNode[] | null => {
    CITATION_PATTERN.lastIndex = 0;
    const out: HastNode[] = [];
    let cursor = 0;
    let matched = false;

    for (const match of value.matchAll(CITATION_PATTERN)) {
        const numbers = match[1]!.split(",").map((part) => Number(part.trim()));
        // All-or-nothing: `[2, 9]` with no source 9 stays literal rather than half-linked.
        if (!numbers.every((n) => positions.has(n))) continue;

        matched = true;
        const start = match.index;
        if (start > cursor) out.push({ type: "text", value: value.slice(cursor, start) });
        for (const n of numbers) out.push(citeElement(n));
        cursor = start + match[0].length;
    }

    if (!matched) return null;
    if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
    return out;
};

/**
 * A rehype transform that turns resolvable citation markers into `<cite-ref>` elements.
 *
 * Hand-rolled rather than pulled from a tree-walking package: it is a dozen lines, and the walk
 * has to skip code anyway, which a generic visitor would not do for free.
 */
const rehypeCitations = (positions: Set<number>) => () => (tree: HastNode) => {
    const walk = (node: HastNode) => {
        if (!node.children?.length) return;
        // Numbers inside code are array indices, not citations.
        if (node.tagName === "code" || node.tagName === "pre") return;

        const next: HastNode[] = [];
        let changed = false;

        for (const child of node.children) {
            if (child.type === "text" && typeof child.value === "string") {
                const split = splitTextNode(child.value, positions);
                if (split) {
                    next.push(...split);
                    changed = true;
                    continue;
                }
            }
            walk(child);
            next.push(child);
        }

        if (changed) node.children = next;
    };

    walk(tree);
};

// ── Renderer ─────────────────────────────────────────────────────────────────

/** Reads the language from react-markdown's `language-xxx` class on a fenced block. */
const languageOf = (className: unknown): string | null => {
    if (typeof className !== "string") return null;
    const match = /\blanguage-([\w+-]+)\b/.exec(className);
    return match ? match[1]! : null;
};

const MarkdownRenderer = ({ content, sources }: { content: string; sources: Source[] }) => {
    const positions = new Set(sources.map((source) => source.position));
    const byPosition = new Map(sources.map((source) => [source.position, source]));

    const components = {
        // External links must not hand the opener a window reference.
        a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
            </a>
        ),

        // `pre > code` is a fenced block; the language rides on the inner element's className.
        pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const props = (child as { props?: { className?: unknown } } | undefined)?.props;
            return <CodeBlock language={languageOf(props?.className)}>{children}</CodeBlock>;
        },

        // Wide tables scroll inside their own box; the thread column never scrolls sideways.
        table: ({ children }) => (
            <div className="table-scroll">
                <table>{children}</table>
            </div>
        ),

        // Not a real HTML tag: the rehype pass above emits it, and react-markdown routes it
        // here by tag name. Typed loosely because `Components` only knows intrinsic elements.
        "cite-ref": ({ node }: { node?: HastNode }) => {
            const source = byPosition.get(Number(node?.properties?.dataPosition));
            return source ? <Citation source={source} /> : null;
        },
    } as Components;

    return (
        <div className="markdown">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={positions.size > 0 ? [rehypeCitations(positions)] : []}
                components={components}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
};

export default MarkdownRenderer;

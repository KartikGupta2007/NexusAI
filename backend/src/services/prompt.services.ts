import {
    PROMPT_MAX_MEMORIES,
    PROMPT_MAX_MEMORY_CHARS,
    PROMPT_MAX_MESSAGE_CHARS,
    PROMPT_MAX_SUMMARY_CHARS,
    PROMPT_MAX_WEB_CONTENT_CHARS,
    PROMPT_MAX_WEB_RESULTS,
} from "../constants.ts";
import type { MessageSourceInput } from "../repositories/messageSource.repository.ts";
import type { WebSearchResult } from "./tavily.services.ts";

/**
 * Builds the Claude input from already-retrieved data, and maps citations back to sources.
 *
 * Reads nothing: every input is passed in, so this layer is pure and directly testable. The
 * shapes are structural rather than imports of the retrieval DTOs, so `buildQueryContext()`
 * output can be handed straight in without coupling the two modules.
 */

/** A web result as offered to Claude, under the id it must cite. */
export interface PromptSource {
    /** `source_1`, `source_2`, … — 1-based, assigned in the order results were given. */
    id: string;
    result: WebSearchResult;
}

export interface AnswerPromptInput {
    query: string;
    conversationSummary?: string | null;
    recentMessages?: readonly { role: "user" | "assistant" | "system"; content: string }[];
    relevantMemories?: readonly { content: string }[];
    webResults?: readonly WebSearchResult[];
}

export interface AssembledPrompt {
    prompt: string;
    /** The sources Claude was shown, and the only ids it may cite. */
    sources: PromptSource[];
}

/**
 * The block labels used in the prompt. Untrusted text has these neutralised so a web page
 * cannot close our block early and have what follows read as prompt structure.
 */
const BLOCK_TAGS = [
    "conversation_summary",
    "recent_messages",
    "memories",
    "memory",
    "web_results",
    "source",
    "user_question",
    "system",
] as const;

const DELIMITER_PATTERN = new RegExp(`</?\\s*(?:${BLOCK_TAGS.join("|")})\\b[^>]*>`, "gi");

/**
 * Defangs our own delimiters inside untrusted text.
 *
 * Without this, a retrieved page containing `</web_results>` would appear to end the data
 * block, and anything after it would be read as instructions from us rather than as page
 * content. Only our tag vocabulary is touched, so ordinary angle brackets and real HTML in a
 * snippet survive intact.
 */
const defang = (text: string): string => text.replace(DELIMITER_PATTERN, "[redacted-tag]");

const clamp = (text: string, limit: number): string => {
    const trimmed = text.trim();
    return trimmed.length > limit ? `${trimmed.slice(0, limit)}…[truncated]` : trimmed;
};

const prepare = (text: string, limit: number): string => defang(clamp(text, limit));

/** Assigns `source_N` ids deterministically: same input order, same ids, every time. */
export const toPromptSources = (results: readonly WebSearchResult[]): PromptSource[] =>
    results.slice(0, PROMPT_MAX_WEB_RESULTS).map((result, index) => ({
        id: `source_${index + 1}`,
        result,
    }));

export const buildAnswerPrompt = (input: AnswerPromptInput): AssembledPrompt => {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query.length === 0) {
        // Callers validate earlier too; this keeps an empty prompt from ever reaching Claude.
        throw new Error("buildAnswerPrompt requires a non-empty query");
    }

    const sources = toPromptSources(input.webResults ?? []);
    const blocks: string[] = [];

    const summary = input.conversationSummary?.trim();
    if (summary) {
        blocks.push(
            `<conversation_summary>\n${prepare(summary, PROMPT_MAX_SUMMARY_CHARS)}\n</conversation_summary>`,
        );
    }

    const messages = (input.recentMessages ?? []).filter((message) => message.content?.trim());
    if (messages.length > 0) {
        // Oldest first, as retrieval returns them, so it reads as a transcript.
        const rendered = messages
            .map((message) => `${message.role}: ${prepare(message.content, PROMPT_MAX_MESSAGE_CHARS)}`)
            .join("\n");
        blocks.push(`<recent_messages>\n${rendered}\n</recent_messages>`);
    }

    const memories = (input.relevantMemories ?? [])
        .filter((memory) => memory.content?.trim())
        .slice(0, PROMPT_MAX_MEMORIES);
    if (memories.length > 0) {
        const rendered = memories
            .map((memory) => `<memory>${prepare(memory.content, PROMPT_MAX_MEMORY_CHARS)}</memory>`)
            .join("\n");
        blocks.push(`<memories>\n${rendered}\n</memories>`);
    }

    if (sources.length > 0) {
        const rendered = sources
            .map(({ id, result }) =>
                [
                    `<source id="${id}">`,
                    `title: ${prepare(result.title, PROMPT_MAX_WEB_CONTENT_CHARS)}`,
                    `url: ${prepare(result.url, PROMPT_MAX_WEB_CONTENT_CHARS)}`,
                    `content: ${result.content ? prepare(result.content, PROMPT_MAX_WEB_CONTENT_CHARS) : "(no snippet provided)"}`,
                    `</source>`,
                ].join("\n"),
            )
            .join("\n");
        blocks.push(`<web_results>\n${rendered}\n</web_results>`);
    } else {
        // Stated rather than omitted: silence would let Claude assume a search happened.
        blocks.push(`<web_results>\n(no web search results available for this question)\n</web_results>`);
    }

    // The question goes last so it is the most recent thing in context, and is itself defanged
    // — the user is as capable of pasting a fake block delimiter as any web page.
    blocks.push(`<user_question>\n${prepare(query, PROMPT_MAX_MESSAGE_CHARS)}\n</user_question>`);

    return { prompt: blocks.join("\n\n"), sources };
};

/**
 * Resolves citation ids back to their sources, ready for `attachMessageSources()`.
 *
 * Unknown ids are dropped rather than raising: a model returning `source_9` when six were
 * offered is a mistake to ignore, not a reason to lose an otherwise good answer. Duplicates
 * collapse, and the order Claude chose is preserved — it ranked them.
 */
export const mapCitationsToSources = (
    citations: readonly string[],
    sources: readonly PromptSource[],
): MessageSourceInput[] => {
    const byId = new Map(sources.map((source) => [source.id, source.result]));
    const seen = new Set<string>();
    const mapped: MessageSourceInput[] = [];

    for (const citation of citations) {
        if (typeof citation !== "string") continue;
        const id = citation.trim();
        if (seen.has(id)) continue;

        const result = byId.get(id);
        if (!result) continue;

        seen.add(id);
        mapped.push({
            position: mapped.length + 1,
            url: result.url,
            title: result.title,
            content: result.content,
            favicon: result.favicon,
        });
    }

    return mapped;
};

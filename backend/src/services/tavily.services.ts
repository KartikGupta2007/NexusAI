import { tavily, type TavilyClient, type TavilySearchOptions } from "@tavily/core";
import { env } from "../config/env.ts";
import {
    MESSAGE_MAX_SOURCES,
    MESSAGE_SOURCE_MAX_CONTENT_CHARS,
    MESSAGE_SOURCE_MAX_TITLE_CHARS,
    MESSAGE_SOURCE_MAX_URL_CHARS,
    TAVILY_INCLUDE_FAVICON,
    TAVILY_MAX_QUERY_CHARS,
    TAVILY_MAX_RESULTS,
    TAVILY_SEARCH_DEPTH,
    TAVILY_SEARCH_TOPIC,
    TAVILY_TIMEOUT_SECONDS,
} from "../constants.ts";
import type { MessageSourceInput } from "../repositories/messageSource.repository.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Web search via Tavily. The provider is contained in this file; callers get our own
 * `WebSearchResult`, so swapping engines changes nothing above.
 */

export interface WebSearchResult {
    url: string;
    title: string;
    content: string | null;
    favicon: string | null;
}

/** The provider call, as a parameter so tests can stub it instead of hitting the network. */
export type TavilySearchExecutor = (
    query: string,
    options: TavilySearchOptions,
) => Promise<unknown>;

let client: TavilyClient | null = null;

/**
 * `apiKey` is required with no default: `tavily({ apiKey: undefined })` does not throw, it
 * quietly enters a rate-limited keyless mode, so the check has to be ours. A default here
 * would also make "no key" inexpressible, and a test asking for that path would hit the
 * real API.
 */
export const createTavilySearchExecutor =
    (apiKey: string | undefined): TavilySearchExecutor =>
    (query, options) => {
        const key = apiKey?.trim();
        if (!key) {
            throw new ApiError(503, "Web search is not configured", {
                code: "SEARCH_NOT_CONFIGURED",
            });
        }
        client ??= tavily({ apiKey: key });
        return client.search(query, options);
    };

const defaultExecutor: TavilySearchExecutor = (query, options) =>
    createTavilySearchExecutor(env.TAVILY_API_KEY)(query, options);

/**
 * Three buckets, because only three outcomes change what a caller does: fix the config, retry
 * later, or give up on web results for this turn. Classification is by message text because
 * the SDK throws a plain Error with no status property.
 *
 * The provider's message is never reused as ours — the SDK interpolates the raw response body
 * into it. It is attached as `cause` for the log line instead.
 */
const toApiError = (error: unknown): ApiError => {
    if (error instanceof ApiError) return error;

    const message = error instanceof Error ? error.message : String(error);

    // 429 is standard; 432/433 are Tavily's usage-limit statuses.
    if (/^4(29|32|33)\b|rate ?limit|too many requests|usage limit|quota|exceeded/i.test(message)) {
        return new ApiError(429, "Web search rate limit reached. Please try again shortly.", {
            code: "SEARCH_RATE_LIMITED",
            cause: error,
        });
    }
    if (/keyless/i.test(message) || (error as { name?: string }).name === "TavilyKeylessLimitError") {
        return new ApiError(503, "Web search is not configured", {
            code: "SEARCH_NOT_CONFIGURED",
            cause: error,
        });
    }
    return new ApiError(502, "Web search failed", { code: "SEARCH_FAILED", cause: error });
};

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * Guarantees every survivor is accepted by `attachMessageSources`, so search output can be
 * persisted without a second validation pass. Over-long URLs are dropped rather than
 * truncated — a cut URL is a broken link. A missing url or title makes a citation
 * unrenderable, so those go too. Bad individual entries are skipped; a bad envelope throws.
 */
const normalizeResults = (payload: unknown, limit: number): WebSearchResult[] => {
    const results = (payload as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) {
        throw new ApiError(502, "Web search failed", { code: "SEARCH_FAILED" });
    }

    const normalized: WebSearchResult[] = [];
    for (const entry of results) {
        if (normalized.length >= limit) break;
        if (entry === null || typeof entry !== "object") continue;

        const row = entry as Record<string, unknown>;
        const url = trimmed(row.url);
        const title = trimmed(row.title);
        if (!url || !title || url.length > MESSAGE_SOURCE_MAX_URL_CHARS) continue;

        const content = trimmed(row.content);
        const favicon = trimmed(row.favicon);
        normalized.push({
            url,
            title: title.slice(0, MESSAGE_SOURCE_MAX_TITLE_CHARS),
            content: content ? content.slice(0, MESSAGE_SOURCE_MAX_CONTENT_CHARS) : null,
            favicon: favicon || null,
        });
    }
    return normalized;
};

/**
 * An empty array means the provider found nothing. Every failure throws, so a caller can
 * always tell "no results" from "search broke".
 *
 * @throws ApiError 400 invalid query · 503 not configured · 429 rate limited · 502 failed.
 */
export const searchWeb = async (
    query: string,
    options: { maxResults?: number } = {},
    executor: TavilySearchExecutor = defaultExecutor,
): Promise<WebSearchResult[]> => {
    const text = typeof query === "string" ? query.trim() : "";
    if (!text) throw ApiError.badRequest("query must not be empty");
    if (text.length > TAVILY_MAX_QUERY_CHARS) {
        throw ApiError.badRequest(`query must be at most ${TAVILY_MAX_QUERY_CHARS} characters`);
    }

    // Never above MESSAGE_MAX_SOURCES: extra results could not be persisted as citations.
    const limit = Math.max(
        1,
        Math.min(options.maxResults ?? TAVILY_MAX_RESULTS, MESSAGE_MAX_SOURCES),
    );

    let payload: unknown;
    try {
        payload = await executor(text, {
            maxResults: limit,
            searchDepth: TAVILY_SEARCH_DEPTH as TavilySearchOptions["searchDepth"],
            topic: TAVILY_SEARCH_TOPIC as TavilySearchOptions["topic"],
            // Seconds — the SDK multiplies by 1000 itself. Its own default is 60.
            timeout: TAVILY_TIMEOUT_SECONDS,
            includeFavicon: TAVILY_INCLUDE_FAVICON,
        });
    } catch (error) {
        const mapped = toApiError(error);
        console.error(`[search] ${mapped.code}`, error);
        throw mapped;
    }

    return normalizeResults(payload, limit);
};

/** Numbers results 1..N in relevance order — the input `attachMessageSources` expects. */
export const toMessageSourceInputs = (results: WebSearchResult[]): MessageSourceInput[] =>
    results.map((result, index) => ({ position: index + 1, ...result }));
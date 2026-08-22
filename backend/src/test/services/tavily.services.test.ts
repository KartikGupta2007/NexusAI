/**
 * Tavily web-search service.
 *
 * The provider boundary is stubbed throughout — `searchWeb`'s third parameter is the executor,
 * so every case here runs with a fake and **no test in this file makes a network request or
 * uses TAVILY_API_KEY**. Nothing else in the suite touches Tavily either.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
} from "../../constants.ts";
import { ApiError } from "../../utils/ApiError.ts";
import {
    createTavilySearchExecutor,
    searchWeb,
    toMessageSourceInputs,
    type TavilySearchExecutor,
} from "../../services/tavily.services.ts";

/** A provider stub that records what it was asked, and returns `payload`. */
const stub = (payload: unknown) => {
    const calls: { query: string; options: Record<string, unknown> }[] = [];
    const executor: TavilySearchExecutor = async (query, options) => {
        calls.push({ query, options: options as Record<string, unknown> });
        return payload;
    };
    return { executor, calls };
};

/** A provider stub that rejects with `error`. */
const failing = (error: unknown): TavilySearchExecutor => async () => {
    throw error;
};

const hit = (over: Record<string, unknown> = {}) => ({
    title: "NVIDIA Official Site",
    url: "https://www.nvidia.com/",
    content: "NVIDIA designs GPUs.",
    score: 0.9,
    publishedDate: "2026-01-01",
    favicon: "https://www.nvidia.com/favicon.ico",
    id: "1",
    ...over,
});

const expectApiError = async (operation: Promise<unknown>, statusCode: number, code?: string) => {
    try {
        await operation;
    } catch (error) {
        assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
        assert.equal(error.statusCode, statusCode, `message: ${error.message}`);
        if (code) assert.equal(error.code, code);
        return error;
    }
    throw new assert.AssertionError({ message: `expected a ${statusCode} rejection` });
};

describe("searchWeb: request", () => {
    it("1: sends the query with the configured search parameters", async () => {
        const { executor, calls } = stub({ results: [hit()] });
        await searchWeb("what is nvidia", {}, executor);

        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.query, "what is nvidia");
        assert.deepEqual(calls[0]!.options, {
            maxResults: TAVILY_MAX_RESULTS,
            searchDepth: TAVILY_SEARCH_DEPTH,
            topic: TAVILY_SEARCH_TOPIC,
            timeout: TAVILY_TIMEOUT_SECONDS,
            includeFavicon: TAVILY_INCLUDE_FAVICON,
        });
        // Seconds, not milliseconds — the SDK multiplies by 1000 itself.
        assert.ok(TAVILY_TIMEOUT_SECONDS < 120, "timeout looks like milliseconds");
    });

    it("2: the query is trimmed before it is sent", async () => {
        const { executor, calls } = stub({ results: [] });
        await searchWeb("   what is nvidia \n\t ", {}, executor);
        assert.equal(calls[0]!.query, "what is nvidia");
    });

    it("11: maxResults is honoured and clamped to MESSAGE_MAX_SOURCES", async () => {
        const { executor, calls } = stub({ results: [] });

        await searchWeb("q", { maxResults: 3 }, executor);
        assert.equal(calls[0]!.options.maxResults, 3);

        await searchWeb("q", { maxResults: MESSAGE_MAX_SOURCES + 50 }, executor);
        assert.equal(calls[1]!.options.maxResults, MESSAGE_MAX_SOURCES,
            "must not request more than can be persisted as citations");

        await searchWeb("q", { maxResults: 0 }, executor);
        assert.equal(calls[2]!.options.maxResults, 1, "must request at least one result");
    });

    it("11b: more results than requested are truncated on the way out", async () => {
        const { executor } = stub({ results: Array.from({ length: 25 }, (_, i) => hit({ id: String(i), url: `https://e.example/${i}` })) });
        assert.equal((await searchWeb("q", { maxResults: 4 }, executor)).length, 4);
        assert.equal((await searchWeb("q", {}, executor)).length, TAVILY_MAX_RESULTS);
    });
});

describe("searchWeb: query validation", () => {
    it("3/4/5: invalid queries are rejected without calling the provider", async () => {
        let called = false;
        const spy: TavilySearchExecutor = async () => { called = true; return { results: [] }; };

        await expectApiError(searchWeb("", {}, spy), 400);
        await expectApiError(searchWeb("   \n\t ", {}, spy), 400);
        await expectApiError(searchWeb("x".repeat(TAVILY_MAX_QUERY_CHARS + 1), {}, spy), 400);
        await expectApiError(searchWeb(null as unknown as string, {}, spy), 400);
        await expectApiError(searchWeb(42 as unknown as string, {}, spy), 400);

        assert.equal(called, false, "the provider must not be called for an invalid query");
    });

    it("a query at exactly the limit is accepted", async () => {
        const { executor, calls } = stub({ results: [] });
        await searchWeb("y".repeat(TAVILY_MAX_QUERY_CHARS), {}, executor);
        assert.equal(calls[0]!.query.length, TAVILY_MAX_QUERY_CHARS);
    });
});

describe("searchWeb: normalization", () => {
    it("7: a successful response is normalized to WebSearchResult", async () => {
        const { executor } = stub({
            query: "what is nvidia",
            responseTime: 1.2,
            images: [],
            requestId: "req-1",
            results: [hit(), hit({ id: "2", url: "https://en.wikipedia.org/wiki/Nvidia", title: "Nvidia" })],
        });

        const results = await searchWeb("what is nvidia", {}, executor);
        assert.equal(results.length, 2);
        assert.deepEqual(results[0], {
            url: "https://www.nvidia.com/",
            title: "NVIDIA Official Site",
            content: "NVIDIA designs GPUs.",
            favicon: "https://www.nvidia.com/favicon.ico",
        });
        // Provider-only fields must not leak through.
        for (const result of results) {
            assert.deepEqual(Object.keys(result).sort(), ["content", "favicon", "title", "url"]);
        }
        const raw = JSON.stringify(results);
        for (const leaked of ["score", "publishedDate", "requestId", "rawContent", '"id"']) {
            assert.ok(!raw.includes(leaked), `${leaked} leaked into the DTO`);
        }
    });

    it("8/9: missing or blank content and favicon become null", async () => {
        const { executor } = stub({
            results: [
                hit({ content: undefined, favicon: undefined }),
                hit({ id: "2", url: "https://b.example/", content: "   ", favicon: "  " }),
                hit({ id: "3", url: "https://c.example/", content: null, favicon: null }),
            ],
        });

        const results = await searchWeb("q", {}, executor);
        assert.equal(results.length, 3);
        for (const result of results) {
            assert.equal(result.content, null);
            assert.equal(result.favicon, null);
        }
    });

    it("8b: a result with no usable url or title is dropped", async () => {
        const { executor } = stub({
            results: [
                hit({ title: "" }),
                hit({ id: "2", url: "   " }),
                hit({ id: "3", url: undefined }),
                hit({ id: "4", title: null }),
                hit({ id: "5", url: "https://good.example/", title: "Good" }),
            ],
        });

        const results = await searchWeb("q", {}, executor);
        assert.equal(results.length, 1, "only the renderable result should survive");
        assert.equal(results[0]!.title, "Good");
    });

    it("10: url, title and content are trimmed", async () => {
        const { executor } = stub({
            results: [hit({ url: "  https://a.example/  ", title: "  Padded  ", content: "  snippet  " })],
        });
        const [result] = await searchWeb("q", {}, executor);
        assert.equal(result!.url, "https://a.example/");
        assert.equal(result!.title, "Padded");
        assert.equal(result!.content, "snippet");
    });

    it("over-long fields are handled so the result stays attachable", async () => {
        const { executor } = stub({
            results: [
                // Over-long URL: dropped, never truncated — a cut URL is a broken link.
                hit({ url: `https://a.example/${"x".repeat(MESSAGE_SOURCE_MAX_URL_CHARS)}` }),
                hit({
                    id: "2",
                    url: "https://b.example/",
                    title: "t".repeat(MESSAGE_SOURCE_MAX_TITLE_CHARS + 100),
                    content: "c".repeat(MESSAGE_SOURCE_MAX_CONTENT_CHARS + 500),
                }),
            ],
        });

        const results = await searchWeb("q", {}, executor);
        assert.equal(results.length, 1, "the over-long URL should have been dropped");
        assert.equal(results[0]!.title.length, MESSAGE_SOURCE_MAX_TITLE_CHARS);
        assert.equal(results[0]!.content!.length, MESSAGE_SOURCE_MAX_CONTENT_CHARS);
    });

    it("an empty result set is an empty array, not an error", async () => {
        const { executor } = stub({ results: [] });
        assert.deepEqual(await searchWeb("obscure query", {}, executor), []);
    });

    it("15: a malformed envelope is rejected safely", async () => {
        for (const payload of [{}, null, undefined, { results: null }, { results: "nope" }, { results: {} }, "text", 42]) {
            const returning: TavilySearchExecutor = async () => payload;
            await expectApiError(
                searchWeb("q", {}, returning), 502, "SEARCH_FAILED",
            );
        }
    });

    it("15b: malformed individual entries are skipped, not fatal", async () => {
        const { executor } = stub({
            results: [null, "string", 42, [], hit({ url: "https://ok.example/", title: "OK" })],
        });
        const results = await searchWeb("q", {}, executor);
        assert.equal(results.length, 1);
        assert.equal(results[0]!.url, "https://ok.example/");
    });
});

describe("searchWeb: provider failures", () => {
    it("6: a missing API key is a clear configuration error", async () => {
        for (const key of [undefined, "", "   "]) {
            const error = await expectApiError(
                searchWeb("q", {}, createTavilySearchExecutor(key)), 503, "SEARCH_NOT_CONFIGURED");
            assert.match(error.message, /not configured/i);
        }
    });

    it("12/14: auth, timeout and network failures all map to SEARCH_FAILED", async () => {
        // Collapsed on purpose: none of these change what a caller does — the web results are
        // unavailable for this turn either way. Only rate limiting (retry) and missing config
        // (fix the deployment) get their own code.
        for (const failure of [
            new Error("401 Error: unauthorized"),
            new Error("Invalid API key provided"),
            new Error("Request timed out after 15 seconds."),
            new TypeError("fetch failed"),
            Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
            new Error("500 Error: {\"something\":\"odd\"}"),
            "plain string",
            { weird: true },
        ]) {
            await expectApiError(searchWeb("q", {}, failing(failure)), 502, "SEARCH_FAILED");
        }
    });

    it("13: rate limiting is distinguished, because a caller can retry it", async () => {
        for (const message of [
            "429 Error: too many requests",
            "432 Error: usage limit exceeded",
            "433 Error: plan limit",
            "Your rate limit has been reached",
        ]) {
            await expectApiError(searchWeb("q", {}, failing(new Error(message))), 429, "SEARCH_RATE_LIMITED");
        }
    });

    it("14b: keyless-mode exhaustion reads as misconfiguration, not throttling", async () => {
        const error = Object.assign(new Error("keyless limit reached"), { name: "TavilyKeylessLimitError" });
        await expectApiError(searchWeb("q", {}, failing(error)), 503, "SEARCH_NOT_CONFIGURED");
    });
});

describe("searchWeb: secrecy", () => {
    it("16: no API key or raw provider body appears in a thrown error", async () => {
        const fakeKey = "tvly-SUPERSECRET-abcdef123456";
        const providerMessage = `401 Error: {"detail":{"error":"bad key ${fakeKey}"}}`;

        const error = await expectApiError(searchWeb("q", {}, failing(new Error(providerMessage))), 502);

        // The message we surface is ours, not the provider's.
        assert.ok(!error.message.includes(fakeKey), "API key leaked into the error message");
        assert.ok(!error.message.includes("detail"), "raw provider body leaked into the error message");
        assert.equal(error.message, "Web search failed");
        assert.deepEqual(error.errors, []);

        // The error handler serialises success/code/message/errors — none may carry the key.
        const wireShape = JSON.stringify({
            success: false, code: error.code, message: error.message, errors: error.errors,
        });
        assert.ok(!wireShape.includes(fakeKey));
        assert.ok(!wireShape.includes("SUPERSECRET"));
    });

    it("16b: the configured key never appears in any error this service throws", async () => {
        const configured = process.env.TAVILY_API_KEY?.trim();
        const failures: unknown[] = [
            new Error("401 unauthorized"), new Error("429 rate limit"),
            new Error("Request timed out after 15 seconds."), new Error("boom"),
        ];
        for (const failure of failures) {
            try {
                await searchWeb("q", {}, failing(failure));
                assert.fail("expected a rejection");
            } catch (error) {
                const serialized = `${(error as ApiError).message} ${(error as ApiError).code}`;
                if (configured && configured.length > 0) {
                    assert.ok(!serialized.includes(configured), "configured key leaked");
                }
            }
        }
    });
});

describe("toMessageSourceInputs", () => {
    it("17: normalized results are directly usable as message-source input", async () => {
        const { executor } = stub({
            results: [
                hit({ url: "https://www.nvidia.com/", title: "NVIDIA" }),
                hit({ id: "2", url: "https://en.wikipedia.org/wiki/Nvidia", title: "History", content: undefined }),
                hit({ id: "3", url: "https://www.britannica.com/money/Nvidia", title: "Britannica" }),
            ],
        });

        const sources = toMessageSourceInputs(await searchWeb("what is nvidia", {}, executor));

        assert.deepEqual(sources.map((s) => s.position), [1, 2, 3], "positions are 1..N in relevance order");
        assert.deepEqual(Object.keys(sources[0]!).sort(),
            ["content", "favicon", "position", "title", "url"]);

        // Mirrors the message-source layer's own validation, so attachMessageSources() cannot
        // reject what this produces.
        assert.ok(sources.length <= MESSAGE_MAX_SOURCES);
        assert.equal(new Set(sources.map((s) => s.position)).size, sources.length, "positions unique");
        for (const source of sources) {
            assert.ok(Number.isInteger(source.position) && source.position >= 1);
            assert.ok(source.url.trim().length > 0 && source.url.length <= MESSAGE_SOURCE_MAX_URL_CHARS);
            assert.ok(source.title.trim().length > 0 && source.title.length <= MESSAGE_SOURCE_MAX_TITLE_CHARS);
            assert.ok(source.content == null || source.content.length <= MESSAGE_SOURCE_MAX_CONTENT_CHARS);
            // Whitespace-only would fail the DB's `~ '\S'` check.
            assert.match(source.url, /\S/);
            assert.match(source.title, /\S/);
        }
        assert.equal(sources[1]!.content, null);
    });

    it("an empty search maps to an empty source list", () => {
        assert.deepEqual(toMessageSourceInputs([]), []);
    });
});

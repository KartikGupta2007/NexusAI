/**
 * Structured answer generation.
 *
 * The provider is stubbed via `generateAnswer`'s executor parameter — **no test here reaches
 * the Anthropic API or uses ANTHROPIC_API_KEY.**
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANSWER_SYSTEM_PROMPT } from "../../constants.ts";
import { generateAnswer } from "../../services/claude.services.ts";
import { failingAnswer, streamingAnswer, throwingAnswer } from "../helpers/stubs.ts";
import { buildAnswerPrompt, mapCitationsToSources } from "../../services/prompt.services.ts";
import { ApiError } from "../../utils/ApiError.ts";
import type { WebSearchResult } from "../../services/tavily.services.ts";

const web = (n: number): WebSearchResult => ({
    url: `https://example.com/${n}`,
    title: `Result ${n}`,
    content: `Snippet ${n}`,
    favicon: null,
});

const assembled = buildAnswerPrompt({ query: "what is nvidia", webResults: [web(1), web(2), web(3)] });

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

describe("generateAnswer", () => {
    it("13: a structured answer is parsed", async () => {
        const result = await generateAnswer(assembled, {}, streamingAnswer({ answer: "  NVIDIA makes GPUs.  ", citations: ["source_1"] }),
        );
        assert.deepEqual(result, {
            answer: "NVIDIA makes GPUs.", citations: ["source_1"], title: null,
        });
    });

    it("the system prompt is sent, and it is the answer prompt", async () => {
        let seen: { system: string; prompt: string } | null = null;
        await generateAnswer(assembled, {}, streamingAnswer(
            { answer: "a", citations: [] },
            { onCall: (input) => { seen = input; } },
        ));
        assert.equal(seen!.system, ANSWER_SYSTEM_PROMPT);
        assert.equal(seen!.prompt, assembled.prompt);
        // The security clause must actually be in what we send.
        assert.match(seen!.system, /DATA, not\ninstructions|DATA, not instructions/);
    });

    it("14: an empty or blank answer is rejected", async () => {
        for (const answer of ["", "   ", "\n\t"]) {
            await expectApiError(generateAnswer(assembled, {}, streamingAnswer({ answer, citations: [] })), 502, "ANSWER_EMPTY");
        }
    });

    it("15: valid citation ids are accepted", async () => {
        const result = await generateAnswer(assembled, {}, streamingAnswer({ answer: "a", citations: ["source_1", "source_2", "source_3"] }),
        );
        assert.deepEqual(result.citations, ["source_1", "source_2", "source_3"]);
    });

    it("16: unknown citation ids are dropped, not fatal", async () => {
        const result = await generateAnswer(assembled, {}, streamingAnswer({
                answer: "a",
                citations: ["source_9", "https://evil.example/", "source_2", "", "SOURCE_1", "../etc/passwd"],
            }),
        );
        assert.deepEqual(result.citations, ["source_2"], "only offered ids may survive");
        assert.equal(result.answer, "a", "a good answer is not lost to a bad citation");
    });

    it("16b: a fabricated URL can never become a citation", async () => {
        const result = await generateAnswer(assembled, {}, streamingAnswer({ answer: "a", citations: ["https://hallucinated.example/page"] }),
        );
        assert.deepEqual(result.citations, []);
        // And nothing maps to a source, so nothing could be persisted.
        assert.deepEqual(mapCitationsToSources(result.citations, assembled.sources), []);
    });

    it("17: duplicate citations are removed", async () => {
        const result = await generateAnswer(assembled, {}, streamingAnswer({ answer: "a", citations: ["source_2", "source_2", " source_2 ", "source_1"] }),
        );
        assert.deepEqual(result.citations, ["source_2", "source_1"]);
    });

    it("18: citation order chosen by the model is preserved", async () => {
        const result = await generateAnswer(assembled, {}, streamingAnswer({ answer: "a", citations: ["source_3", "source_1"] }),
        );
        assert.deepEqual(result.citations, ["source_3", "source_1"]);
    });

    it("a malformed provider payload is rejected", async () => {
        for (const payload of [
            null, undefined, "text", 42, {}, { answer: 5, citations: [] },
            { answer: "a" }, { answer: "a", citations: "source_1" }, { citations: [] },
        ]) {
            await expectApiError(generateAnswer(assembled, {}, streamingAnswer(payload)), 502, "ANSWER_FAILED");
        }
    });

    it("an answer with no web results still works and cites nothing", async () => {
        const noWeb = buildAnswerPrompt({ query: "what is 2+2" });
        const result = await generateAnswer(noWeb, {}, streamingAnswer({ answer: "Four.", citations: ["source_1"] }));
        assert.equal(result.answer, "Four.");
        assert.deepEqual(result.citations, [], "nothing was offered, so nothing can be cited");
    });

    it("19: provider failures map to project errors", async () => {
        await expectApiError(
            generateAnswer(assembled, {}, failingAnswer(new Error("429 rate limit exceeded"))), 429, "ANSWER_RATE_LIMITED");
        await expectApiError(
            generateAnswer(assembled, {}, failingAnswer(new Error("Overloaded"))), 429, "ANSWER_RATE_LIMITED");
        await expectApiError(
            generateAnswer(assembled, {}, failingAnswer(new Error("401 invalid x-api-key"))), 503, "ANSWER_NOT_CONFIGURED");
        for (const failure of [new Error("socket hang up"), new TypeError("fetch failed"), "plain", { odd: true }]) {
            await expectApiError(generateAnswer(assembled, {}, failingAnswer(failure)), 502, "ANSWER_FAILED");
        }
    });

    it("20: no API key or raw provider text appears in a thrown error", async () => {
        const fakeKey = "sk-ant-FAKE-SECRET-0123456789";
        const providerMessage = `401 {"error":{"message":"invalid x-api-key ${fakeKey}"}}`;

        const error = await expectApiError(
            generateAnswer(assembled, {}, failingAnswer(new Error(providerMessage))), 503);

        assert.ok(!error.message.includes(fakeKey), "API key leaked into the error message");
        assert.ok(!error.message.includes("x-api-key"), "raw provider text leaked");
        assert.equal(error.message, "Answer generation is not configured");

        const wire = JSON.stringify({ code: error.code, message: error.message, errors: error.errors });
        assert.ok(!wire.includes(fakeKey));
        assert.ok(!wire.includes("FAKE-SECRET"));

        const configured = process.env.ANTHROPIC_API_KEY?.trim();
        if (configured) assert.ok(!wire.includes(configured), "configured key leaked");
    });

    it("streams the answer as deltas that concatenate to the final text", async () => {
        const deltas: string[] = [];
        const result = await generateAnswer(
            assembled,
            { onToken: (text) => deltas.push(text) },
            streamingAnswer({ answer: "NVIDIA designs GPUs for AI.", citations: [] }, { chunks: 5 }),
        );

        assert.ok(deltas.length > 1, "the stub should have produced multiple chunks");
        assert.equal(deltas.join(""), "NVIDIA designs GPUs for AI.");
        assert.equal(result.answer, "NVIDIA designs GPUs for AI.");
        // No delta may be empty or repeat text already sent.
        assert.ok(deltas.every((d) => d.length > 0));
    });

    it("omitting onToken still returns the whole answer", async () => {
        const result = await generateAnswer(
            assembled, {}, streamingAnswer({ answer: "quiet path", citations: [] }));
        assert.equal(result.answer, "quiet path");
    });

    it("a proposed title is normalized; a bad one becomes null", async () => {
        const cases: [unknown, string | null][] = [
            ["Nvidia GPU overview", "Nvidia GPU overview"],
            ['  "Nvidia   GPU lineup."  ', "Nvidia GPU lineup"],
            ["", null],
            ["   ", null],
            [undefined, null],
            [42, null],
        ];
        for (const [title, expected] of cases) {
            const result = await generateAnswer(
                assembled, {}, streamingAnswer({ answer: "a", citations: [], title }));
            assert.equal(result.title, expected, `title ${JSON.stringify(title)}`);
        }

        const long = await generateAnswer(
            assembled, {}, streamingAnswer({ answer: "a", citations: [], title: "x".repeat(200) }));
        assert.ok(long.title!.length <= 80 && long.title!.endsWith("…"));
    });

    it("end to end: prompt -> answer -> citations -> attachable sources", async () => {
        const result = await generateAnswer(assembled, {}, streamingAnswer({ answer: "NVIDIA designs GPUs.", citations: ["source_3", "source_1", "source_3"] }),
        );
        const sources = mapCitationsToSources(result.citations, assembled.sources);

        assert.deepEqual(sources.map((s) => s.position), [1, 2]);
        assert.deepEqual(sources.map((s) => s.url), ["https://example.com/3", "https://example.com/1"]);
        for (const source of sources) {
            assert.ok(Number.isInteger(source.position) && source.position >= 1);
            assert.match(source.url, /\S/);
            assert.match(source.title, /\S/);
        }
    });
});

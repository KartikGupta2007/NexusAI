import { generateObject, generateText, streamObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { env } from "../config/env.ts";
import {
    ANSWER_MAX_TOKENS,
    ANSWER_SYSTEM_PROMPT,
    CONVERSATION_SUMMARY_PROMPT,
    CONVERSATION_TITLE_MAX_CHARS,
    MEMORY_EXTRACTION_MAX_TOKENS,
    MEMORY_EXTRACTION_PROMPT,
    MEMORY_MAX_PER_CALL,
    MODEL,
    SUMMARY_MAX_TOKENS,
} from "../constants.ts";
import { ApiError } from "../utils/ApiError.ts";
import type { AssembledPrompt } from "./prompt.services.ts";

// ── Answer generation ────────────────────────────────────────────────────────

/**
 * Structured answer generation, reusing the provider set up above — no second client.
 *
 * `generateObject` rather than free-text parsing: the citation list has to be machine-readable,
 * and scraping ids out of prose is how hallucinated citations get through.
 */

/** What Claude returns, after validation. */
export interface GeneratedAnswer {
    answer: string;
    /** Verified against the ids actually offered; deduped; Claude's ordering kept. */
    citations: string[];
    /** Proposed conversation title. Null when absent or unusable. Applied only on a new chat. */
    title: string | null;
}

/**
 * Sent to the model, so it documents the contract: `answer` is declared first, making it the
 * first field emitted and therefore the part that streams.
 */
const answerSchema = z.object({
    answer: z.string(),
    citations: z.array(z.string()),
    title: z.string().optional(),
});

/**
 * Used to validate what came back. Identical except that `title` is tolerated in any shape.
 *
 * The strict schema above would reject the whole payload over a malformed title, throwing away a
 * perfectly good answer for a field that only labels a sidebar. Here a bad title degrades to
 * null via normalizeTitle; answer and citations stay strict.
 */
const answerResultSchema = z.object({
    answer: z.string(),
    citations: z.array(z.string()),
    title: z.unknown().optional(),
});

/**
 * The provider call, as a parameter so tests can stub it instead of reaching the API.
 *
 * Mirrors `streamObject`'s result: `partialObjectStream` yields progressively-filled, *unvalidated*
 * objects for streaming, and `object` resolves to the validated whole once generation finishes.
 */
export type AnswerStreamExecutor = (input: { system: string; prompt: string }) => {
    partialObjectStream: AsyncIterable<Record<string, unknown> | undefined>;
    object: Promise<unknown>;
};

const defaultAnswerStreamExecutor: AnswerStreamExecutor = ({ system, prompt }) => {
    if (!env.ANTHROPIC_API_KEY?.trim()) {
        throw new ApiError(503, "Answer generation is not configured", {
            code: "ANSWER_NOT_CONFIGURED",
        });
    }

    return streamObject({
        model: anthropic(MODEL),
        system,
        prompt,
        schema: answerSchema,
        maxOutputTokens: ANSWER_MAX_TOKENS,
    });
};

/**
 * Three buckets, because only three outcomes change what a caller does: fix the config, retry
 * later, or give up on a generated answer.
 *
 * The provider's message is never reused as ours — it can quote request content back.
 */
const toAnswerError = (error: unknown): ApiError => {
    if (error instanceof ApiError) return error;

    const message = error instanceof Error ? error.message : String(error);

    if (/rate ?limit|429|too many requests|overloaded|quota/i.test(message)) {
        return new ApiError(429, "The model is busy. Please try again shortly.", {
            code: "ANSWER_RATE_LIMITED",
            cause: error,
        });
    }
    if (/api ?key|401|403|unauthoriz|authentication/i.test(message)) {
        return new ApiError(503, "Answer generation is not configured", {
            code: "ANSWER_NOT_CONFIGURED",
            cause: error,
        });
    }
    return new ApiError(502, "Answer generation failed", { code: "ANSWER_FAILED", cause: error });
};

/**
 * Streams an answer for an assembled prompt, then validates the whole thing.
 *
 * `onToken` receives the answer text as it arrives — deltas only, computed from the growing
 * `answer` field, so a caller can forward them straight to a client. Omit it and the call simply
 * accumulates: one code path either way, so streaming is never a separate untested branch.
 *
 * Validation happens on the completed object, never on a partial: partials are explicitly
 * unvalidated by the SDK, and citations cannot be checked against the offered ids until the list
 * is finished. The answer must be non-empty text, and every citation must be an id we actually
 * offered — unknown ids are dropped rather than fatal.
 *
 * @throws ApiError 503 not configured · 429 model busy · 502 generation failed.
 */
export const generateAnswer = async (
    assembled: AssembledPrompt,
    options: { onToken?: (delta: string) => void } = {},
    executor: AnswerStreamExecutor = defaultAnswerStreamExecutor,
): Promise<GeneratedAnswer> => {
    let raw: unknown;
    try {
        const stream = executor({ system: ANSWER_SYSTEM_PROMPT, prompt: assembled.prompt });

        let emitted = 0;
        for await (const partial of stream.partialObjectStream) {
            const text = typeof partial?.answer === "string" ? partial.answer : "";
            // Only ever forward growth. A partial JSON parse can briefly shorten a string as
            // escapes resolve, and re-sending or rewinding text would corrupt the client's view.
            if (text.length > emitted) {
                options.onToken?.(text.slice(emitted));
                emitted = text.length;
            }
        }

        raw = await stream.object;
    } catch (error) {
        const mapped = toAnswerError(error);
        console.error(`[answer] ${mapped.code}`, error);
        throw mapped;
    }

    const parsed = answerResultSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ApiError(502, "Answer generation failed", { code: "ANSWER_FAILED" });
    }

    const answer = parsed.data.answer.trim();
    if (answer.length === 0) {
        throw new ApiError(502, "Answer generation returned an empty answer", {
            code: "ANSWER_EMPTY",
        });
    }

    const offered = new Set(assembled.sources.map((source) => source.id));
    const citations: string[] = [];
    for (const citation of parsed.data.citations) {
        const id = typeof citation === "string" ? citation.trim() : "";
        if (offered.has(id) && !citations.includes(id)) citations.push(id);
    }

    return { answer, citations, title: normalizeTitle(parsed.data.title) };
};

/** Model-proposed titles are untrusted text: collapse, bound, and reject anything empty. */
const normalizeTitle = (title: unknown): string | null => {
    if (typeof title !== "string") return null;
    const collapsed = title.trim().replace(/\s+/g, " ").replace(/^["'\s]+|["'\s.]+$/g, "");
    if (collapsed.length === 0) return null;
    return collapsed.length > CONVERSATION_TITLE_MAX_CHARS
        ? `${collapsed.slice(0, CONVERSATION_TITLE_MAX_CHARS - 1).trimEnd()}…`
        : collapsed;
};


// ── Post-answer generation: summary refresh and memory extraction ─────────────

/** Provider seam for the two post-answer calls, stubbed in tests. */
export type TextExecutor = (input: { system: string; prompt: string }) => Promise<unknown>;

const requireAnthropicKey = () => {
    if (!env.ANTHROPIC_API_KEY?.trim()) {
        throw new ApiError(503, "Answer generation is not configured", {
            code: "ANSWER_NOT_CONFIGURED",
        });
    }
};

const defaultSummaryExecutor: TextExecutor = async ({ system, prompt }) => {
    requireAnthropicKey();
    const { text } = await generateText({
        model: anthropic(MODEL),
        system,
        prompt,
        maxOutputTokens: SUMMARY_MAX_TOKENS,
    });
    return text;
};

const defaultExtractionExecutor: TextExecutor = async ({ system, prompt }) => {
    requireAnthropicKey();
    const { object } = await generateObject({
        model: anthropic(MODEL),
        system,
        prompt,
        schema: memoriesSchema,
        maxOutputTokens: MEMORY_EXTRACTION_MAX_TOKENS,
    });
    return object;
};

const memoriesSchema = z.object({ memories: z.array(z.string()) });

/**
 * Rewrites the rolling conversation summary.
 *
 * Returns null rather than throwing when the model gives back nothing usable: a summary is an
 * optimisation, and the caller must never fabricate one. The CONVERSATION_SUMMARY_PROMPT
 * carries the placeholders this fills.
 */
export const generateConversationSummary = async (
    input: {
        previousSummary: string | null;
        recentMessages: readonly { role: string; content: string }[];
    },
    executor: TextExecutor = defaultSummaryExecutor,
): Promise<string | null> => {
    const transcript = input.recentMessages
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n");

    const prompt = CONVERSATION_SUMMARY_PROMPT.replace(
        "{{PREVIOUS_SUMMARY}}",
        input.previousSummary?.trim() || "(none yet)",
    ).replace("{{RECENT_MESSAGES}}", transcript || "(no messages)");

    const raw = await executor({ system: ANSWER_SYSTEM_PROMPT, prompt });
    const summary = typeof raw === "string" ? raw.trim() : "";
    return summary.length > 0 ? summary : null;
};

/**
 * Extracts durable, privacy-filtered knowledge from one completed turn.
 *
 * The privacy rules live in MEMORY_EXTRACTION_PROMPT; this only enforces the shape. An empty
 * list is the expected answer for most turns, so it is never an error.
 *
 * Whatever comes back is model output, so it is filtered here too: non-strings dropped,
 * trimmed, blanks dropped, capped at MEMORY_MAX_PER_CALL. rememberTexts would reject a bad
 * batch outright, and one malformed entry should not cost the whole turn's learning.
 */
export const extractMemories = async (
    input: { query: string; answer: string },
    executor: TextExecutor = defaultExtractionExecutor,
): Promise<string[]> => {
    const prompt = MEMORY_EXTRACTION_PROMPT.replace("{{USER_QUERY}}", input.query).replace(
        "{{ASSISTANT_RESPONSE}}",
        input.answer,
    );

    const raw = await executor({ system: ANSWER_SYSTEM_PROMPT, prompt });
    const parsed = memoriesSchema.safeParse(raw);
    if (!parsed.success) return [];

    const memories: string[] = [];
    for (const memory of parsed.data.memories) {
        const text = typeof memory === "string" ? memory.trim() : "";
        if (text.length > 0 && !memories.includes(text)) memories.push(text);
        if (memories.length >= MEMORY_MAX_PER_CALL) break;
    }
    return memories;
};

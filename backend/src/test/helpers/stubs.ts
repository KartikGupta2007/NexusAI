import type { AnswerStreamExecutor } from "../../services/claude.services.ts";

/**
 * Turns a finished payload into an AnswerStreamExecutor.
 *
 * The `answer` text is emitted in growing slices so the streaming path is genuinely exercised —
 * a single-chunk stub would pass even if delta computation were broken.
 *
 * `payload` is `unknown` so malformed-response cases (a string, a number, a wrong-typed field)
 * stay expressible without casts at every call site.
 */
export const streamingAnswer = (
    payload: unknown,
    options: { chunks?: number; onCall?: (input: { system: string; prompt: string }) => void } = {},
): AnswerStreamExecutor => (input) => {
    options.onCall?.(input);

    const answer =
        typeof (payload as { answer?: unknown } | null)?.answer === "string"
            ? (payload as { answer: string }).answer
            : "";
    const step = Math.max(1, Math.ceil(answer.length / (options.chunks ?? 4)));

    return {
        partialObjectStream: (async function* () {
            for (let cut = step; cut < answer.length; cut += step) {
                yield { answer: answer.slice(0, cut) };
            }
            if (payload && typeof payload === "object") yield payload as Record<string, unknown>;
        })(),
        object: Promise.resolve(payload),
    };
};

/** A stream executor whose stream fails part-way through. */
export const failingAnswer = (error: unknown): AnswerStreamExecutor => () => {
    const object = Promise.reject(error);
    // Pre-attach a handler: generateAnswer throws out of the for-await before it reaches
    // `object`, and an unobserved rejection would surface as a process warning.
    object.catch(() => undefined);
    return {
        partialObjectStream: (async function* () {
            throw error;
        })(),
        object,
    };
};

/** A stream executor that throws synchronously, as the real one does when the key is missing. */
export const throwingAnswer = (error: unknown): AnswerStreamExecutor => () => {
    throw error;
};

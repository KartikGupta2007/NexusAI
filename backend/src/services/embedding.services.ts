import {
    env as transformersEnv,
    pipeline,
    type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { env } from "../config/env.ts";
import {
    EMBEDDING_DIMENSIONS,
    EMBEDDING_DTYPE,
    EMBEDDING_MAX_INPUT_CHARS,
    EMBEDDING_MODEL_ID,
} from "../constants.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Local text embeddings. No embedding API, no API key: the model runs in this process via
 * onnxruntime-node, whose native binaries ship in the npm tarball.
 *
 * Callers see `embedText` / `embedTexts` and a dimension constant. Which model produces the
 * vectors is not part of that contract — swapping models means editing this file and adding
 * a migration for the new dimension, and nothing else.
 */

/**
 * BGE-M3 pools the CLS token; it is not a mean-pooling model, and using the wrong pooling
 * silently produces vectors that embed fine but retrieve badly. `normalize` gives unit-length
 * vectors so cosine distance in pgvector is a pure angle comparison.
 *
 * Deliberately local: this is the argument shape of a transformers.js call, not an
 * application constant, and hoisting it would drag that library's option vocabulary into
 * constants.ts. The model facts it encodes belong to this file alone.
 */
const POOLING_OPTIONS = { pooling: "cls", normalize: true } as const;

transformersEnv.cacheDir = env.embeddingCacheDir;

/**
 * The in-flight or settled load, never the resolved pipeline.
 *
 * Caching the *promise* is what makes concurrent first-requests safe: ten requests arriving
 * while the model is still downloading all await the same promise and one model is loaded.
 * Caching the resolved value instead would let each of those ten start its own load.
 */
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

const loadExtractor = (): Promise<FeatureExtractionPipeline> => {
    extractorPromise ??= pipeline("feature-extraction", EMBEDDING_MODEL_ID, {
        dtype: EMBEDDING_DTYPE,
    }).catch((error: unknown) => {
        // Clear the cache so a failed download (offline, disk full) can be retried instead
        // of poisoning every later call with the same rejected promise.
        extractorPromise = null;
        throw error;
    });

    return extractorPromise;
};

/**
 * Loads the model without embedding anything.
 *
 * Optional: the first embedText() call would do this anyway. Useful at boot to move the
 * one-off download cost off the first user's request.
 */
export const warmUpEmbeddingModel = async (): Promise<void> => {
    await loadExtractor();
};

/** True once the model is resident, so callers can report readiness without forcing a load. */
export const isEmbeddingModelLoaded = (): boolean => extractorPromise !== null;

const normalizeInput = (text: string, label: string): string => {
    if (typeof text !== "string") {
        throw ApiError.badRequest(`${label} must be a string`);
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) {
        // Embedding empty text yields a vector that is similar to everything, which
        // quietly poisons retrieval. Refuse rather than store it.
        throw ApiError.badRequest(`${label} must not be empty`);
    }
    if (trimmed.length > EMBEDDING_MAX_INPUT_CHARS) {
        throw ApiError.badRequest(
            `${label} must be at most ${EMBEDDING_MAX_INPUT_CHARS} characters (received ${trimmed.length})`,
        );
    }

    return trimmed;
};

const assertDimensions = (vector: number[], index: number): number[] => {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
        // A dimension drift means the model no longer matches the vector(1024) column, and
        // every insert would fail at the database with a far less obvious message.
        throw new Error(
            `Embedding ${index} has ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}. ` +
                `Model ${EMBEDDING_MODEL_ID} does not match the database schema.`,
        );
    }
    if (!vector.every(Number.isFinite)) {
        throw new Error(`Embedding ${index} contains non-finite values`);
    }
    return vector;
};

/**
 * The single inference path, and the only place the model is called.
 *
 * Exactly one text goes into the tensor, always. Both public functions route through here, so
 * a vector never depends on what else was being embedded alongside it — see embedTexts().
 *
 * `text` must already have passed normalizeInput().
 */
const embedOne = async (text: string, index: number): Promise<number[]> => {
    const extractor = await loadExtractor();
    const output = await extractor([text], POOLING_OPTIONS);

    // With pooling the tensor is [1, EMBEDDING_DIMENSIONS], so tolist() nests the vector.
    const [vector] = output.tolist() as number[][];
    if (!vector) {
        throw new Error(`Model returned no embedding for input ${index}`);
    }

    return assertDimensions(vector, index);
};

/** Embeds one string. Trims input and rejects empty text. */
export const embedText = async (text: string): Promise<number[]> =>
    embedOne(normalizeInput(text, "text"), 0);

/**
 * Embeds several strings — one inference call each, not one batched forward pass.
 *
 * It used to be a single batched call. Under q8 weights onnxruntime derives activation
 * quantisation scales per tensor at run time, so a batched vector depends on what else shared
 * its batch: measured at ~1.2% cosine drift, and present even when every input is the same
 * length and no padding is required. Because memories are written through this function while
 * queries are embedded through embedText(), batching left stored and query vectors in subtly
 * different spaces — ranking survived it, but no invariant held.
 *
 * Embedding each text alone makes this exactly equivalent to calling embedText() on every
 * element, which is the invariant retrieval is entitled to assume. The cost is N forward
 * passes rather than one; at the batch sizes this actually sees (a handful of extracted
 * memories per turn) that is the right trade.
 *
 * Sequential rather than concurrent on purpose. Concurrent run() calls against one
 * onnxruntime session are not a documented guarantee, and reintroducing any nondeterminism
 * is the exact thing this function exists to avoid.
 *
 * Order of the results matches the order of the input.
 */
export const embedTexts = async (texts: string[]): Promise<number[][]> => {
    if (!Array.isArray(texts) || texts.length === 0) {
        throw ApiError.badRequest("texts must be a non-empty array");
    }

    // Validate every element before running any inference, so one bad input rejects the whole
    // call rather than leaving the earlier texts already embedded.
    const inputs = texts.map((text, index) => normalizeInput(text, `texts[${index}]`));

    const vectors: number[][] = [];
    for (const [index, input] of inputs.entries()) {
        vectors.push(await embedOne(input, index));
    }
    return vectors;
};

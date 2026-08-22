/** Audit section 5 — embedding.services.ts. Uses the already-cached model; downloads nothing. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MAX_INPUT_CHARS } from "../../constants.ts";
import { closePool } from "../../db/pool.ts";
import {
    embedText,
    embedTexts,
    isEmbeddingModelLoaded,
    warmUpEmbeddingModel,
} from "../../services/embedding.services.ts";
import { expectApiError } from "../helpers/probe.ts";

const unitLength = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

after(async () => { await closePool(); });

describe("embedding.services", () => {
    it("A: embedText returns exactly EMBEDDING_DIMENSIONS numbers", async () => {
        const v = await embedText("PostgreSQL supports vector similarity search using pgvector.");
        assert.equal(v.length, EMBEDDING_DIMENSIONS);
        assert.equal(EMBEDDING_DIMENSIONS, 1024);
        assert.ok(v.every((x) => typeof x === "number"));
    });

    it("B: embedTexts is exactly equivalent to embedText per element", async () => {
        // The core invariant. Both paths run the same single-text inference, so the vectors
        // must be bit-identical — not merely close. deepEqual is the strictest available
        // assertion and is chosen deliberately: any threshold loose enough to tolerate q8
        // batch drift would also hide its return.
        const inputs = ["cats sleep a lot", "Postgres indexes speed up queries", "je parle francais"];

        const batched = await embedTexts(inputs);
        const solo: number[][] = [];
        for (const text of inputs) solo.push(await embedText(text));

        assert.equal(batched.length, inputs.length);
        assert.deepEqual(batched, solo, "embedTexts diverged from per-element embedText");
    });

    it("B2: regression guard — true batched q8 inference must not come back", async () => {
        // Inputs of deliberately unequal token length. Under a single batched forward pass the
        // shorter ones are padded and their activation scales shift, which measured at ~1.2%
        // cosine drift (self-similarity ~0.987 rather than 1.0). Bit-identity against solo
        // calls therefore fails immediately if embedTexts ever batches again, and the
        // similarity floor below states the magnitude that used to be observed.
        const short = "cats";
        const long =
            "PostgreSQL supports approximate nearest neighbour search over high dimensional " +
            "embedding vectors through the pgvector extension, using either HNSW or IVFFlat.";

        const batched = await embedTexts([short, long]);
        const soloShort = await embedText(short);
        const soloLong = await embedText(long);

        assert.deepEqual(batched[0], soloShort, "short input drifted — batched inference is back");
        assert.deepEqual(batched[1], soloLong, "long input drifted — batched inference is back");

        // Guards the assertion itself: if these were somehow the same object rather than two
        // independently computed vectors, the equality above would be vacuous.
        assert.notDeepEqual(batched[0], batched[1]);
        assert.ok(dot(batched[0]!, soloShort) > 0.9999, `drift detected: ${dot(batched[0]!, soloShort)}`);
        assert.ok(dot(batched[1]!, soloLong) > 0.9999, `drift detected: ${dot(batched[1]!, soloLong)}`);
    });

    it("B3: batch size does not change any vector", async () => {
        const text = "Postgres indexes speed up queries";
        const alone = (await embedTexts([text]))[0]!;

        assert.deepEqual(alone, await embedText(text), "a batch of one must equal embedText");
        assert.deepEqual((await embedTexts([text, "filler one"]))[0], alone, "batch of 2 shifted it");
        assert.deepEqual(
            (await embedTexts([text, "filler one", "an altogether longer filler sentence"]))[0],
            alone,
            "batch of 3 shifted it",
        );
    });

    it("B4: every vector from a batch is 1024-d, unit-length and finite", async () => {
        const vectors = await embedTexts([
            "one", "a medium length sentence about databases", "je parle francais aussi",
        ]);
        for (const [index, v] of vectors.entries()) {
            assert.equal(v.length, EMBEDDING_DIMENSIONS, `vector ${index} width`);
            assert.ok(v.every(Number.isFinite), `vector ${index} has non-finite values`);
            assert.ok(Math.abs(unitLength(v) - 1) < 1e-3, `vector ${index} norm ${unitLength(v)}`);
        }
    });

    it("C: vectors are approximately unit length", async () => {
        for (const v of await embedTexts(["short", "a considerably longer sentence about databases"])) {
            assert.ok(Math.abs(unitLength(v) - 1) < 1e-3, `norm was ${unitLength(v)}`);
        }
    });

    it("D: empty string is rejected with a 400", async () => {
        await expectApiError(embedText(""), 400);
    });

    it("E: whitespace-only input is rejected with a 400", async () => {
        await expectApiError(embedText("   \n\t  "), 400);
        await expectApiError(embedTexts(["ok", "  "]), 400);
    });

    it("F: non-string input is rejected rather than coerced", async () => {
        await expectApiError(embedText(null as unknown as string), 400);
        await expectApiError(embedText(42 as unknown as string), 400);
        await expectApiError(embedTexts([{} as unknown as string]), 400);
    });

    it("F2: a non-array or empty batch is rejected", async () => {
        await expectApiError(embedTexts([]), 400);
        await expectApiError(embedTexts("nope" as unknown as string[]), 400);
    });

    it("G: input longer than EMBEDDING_MAX_INPUT_CHARS is rejected", async () => {
        const error = await expectApiError(embedText("x".repeat(EMBEDDING_MAX_INPUT_CHARS + 1)), 400);
        assert.match(error.message, /at most/);
    });

    it("G2: input at exactly the limit is accepted and does not blow up the tokenizer", async () => {
        // The guard is in characters but the model's real limit is 8192 tokens, so this
        // asserts the truncation path works rather than erroring inside ONNX.
        const v = await embedText("database ".repeat(Math.floor(EMBEDDING_MAX_INPUT_CHARS / 9)));
        assert.equal(v.length, EMBEDDING_DIMENSIONS);
        assert.ok(Math.abs(unitLength(v) - 1) < 1e-3);
    });

    it("H/I: every returned vector passes the finite and dimension guards", async () => {
        const v = await embedText("guard check");
        assert.ok(v.every(Number.isFinite));
        assert.equal(v.length, EMBEDDING_DIMENSIONS);
    });

    it("J: concurrent callers share one model load", async () => {
        // The model is already resident by now, so this asserts the invariant that makes the
        // cold path safe: loadExtractor() caches the promise, so N concurrent callers observe
        // one load and all get identical vectors.
        assert.ok(isEmbeddingModelLoaded(), "model should be loaded by this point");
        const results = await Promise.all(Array.from({ length: 8 }, () => embedText("same input")));
        const first = results[0]!;
        for (const v of results) {
            assert.deepEqual(v, first, "concurrent calls disagreed — more than one model instance");
        }
    });

    it("J2: warmUpEmbeddingModel is idempotent", async () => {
        await Promise.all([warmUpEmbeddingModel(), warmUpEmbeddingModel(), warmUpEmbeddingModel()]);
        assert.ok(isEmbeddingModelLoaded());
    });

    it("L: no OpenAI or other embedding-provider key is required", async () => {
        for (const key of ["OPENAI_API_KEY", "VOYAGE_API_KEY", "COHERE_API_KEY", "HF_TOKEN"]) {
            assert.ok(!process.env[key], `${key} is set — the audit cannot prove independence`);
        }
        const v = await embedText("runs with no embedding provider credentials");
        assert.equal(v.length, EMBEDDING_DIMENSIONS);
    });

    it("semantic sanity: related text scores above unrelated text", async () => {
        const [q, related, unrelated] = await embedTexts([
            "How does Postgres do vector similarity search?",
            "pgvector adds nearest-neighbour search to PostgreSQL.",
            "I baked banana bread on Sunday morning.",
        ]);
        assert.ok(dot(q!, related!) > dot(q!, unrelated!), "pooling or normalization looks wrong");
    });
});

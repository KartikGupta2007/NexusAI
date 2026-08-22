/**
 * Retrieval service — context assembly.
 *
 * Runs against the real database and the real local model, like the rest of the suite: what is
 * under test is whether three independently-owned reads compose into one correct context, and
 * mocking the sources would only prove the mocks were called.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONVERSATION_RECENT_MESSAGE_LIMIT, MEMORY_DEFAULT_RECALL_LIMIT } from "../../constants.ts";
import { closePool } from "../../db/pool.ts";
import { saveConversationSummary } from "../../services/conversationSummary.services.ts";
import { rememberTexts } from "../../services/memory.services.ts";
import { buildQueryContext } from "../../services/retrieval.services.ts";
import {
    addProbeMessages,
    cleanupProbes,
    createProbeConversation,
    createProbeUser,
    expectApiError,
} from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

const PGVECTOR_MEMORY = "The NexusAI backend stores embeddings in Neon Postgres using pgvector.";
const BAKING_MEMORY = "Sourdough starter needs feeding twice a day before baking.";
const VECTOR_QUERY = "How does NexusAI store embedding vectors?";

describe("buildQueryContext", () => {
    it("1: an existing summary is returned", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await saveConversationSummary(user, conv, { summary: "User is wiring up pgvector retrieval." });

        const context = await buildQueryContext({ userId: user, conversationId: conv, query: VECTOR_QUERY });
        assert.equal(context.conversationSummary, "User is wiring up pgvector retrieval.");
    });

    it("2: an absent summary is null, not an error", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);

        const context = await buildQueryContext({ userId: user, conversationId: conv, query: VECTOR_QUERY });
        assert.equal(context.conversationSummary, null);
    });

    it("3/4: recent messages are retrieved, capped by the constant, oldest-first", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await addProbeMessages(conv, [
            { role: "system", content: "boot" },
            { role: "user", content: "m1" },
            { role: "assistant", content: "m2" },
            { role: "user", content: "m3" },
            { role: "assistant", content: "m4" },
            { role: "user", content: "m5" },
        ]);

        const context = await buildQueryContext({ userId: user, conversationId: conv, query: VECTOR_QUERY });

        assert.equal(context.recentMessages.length, CONVERSATION_RECENT_MESSAGE_LIMIT);
        assert.equal(CONVERSATION_RECENT_MESSAGE_LIMIT, 4);
        // Chronological: the newest four, oldest of those first. Not the whole conversation.
        assert.deepEqual(context.recentMessages.map((m) => m.content), ["m2", "m3", "m4", "m5"]);
        assert.deepEqual(context.recentMessages.map((m) => m.role),
            ["assistant", "user", "assistant", "user"]);
        assert.ok(!context.recentMessages.some((m) => m.content === "boot"), "must not fetch everything");
        // The context DTO must not leak row internals.
        assert.deepEqual(Object.keys(context.recentMessages[0]!).sort(), ["content", "role"]);
    });

    it("5: memories relevant to the current query are retrieved", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await rememberTexts(user, [PGVECTOR_MEMORY]);

        const context = await buildQueryContext({ userId: user, conversationId: conv, query: VECTOR_QUERY });

        assert.equal(context.relevantMemories.length, 1);
        assert.equal(context.relevantMemories[0]!.content, PGVECTOR_MEMORY);
        assert.ok(context.relevantMemories[0]!.similarity > 0.4,
            `similarity ${context.relevantMemories[0]!.similarity} is implausibly low`);
        // Public memory shape, not a raw row.
        assert.deepEqual(Object.keys(context.relevantMemories[0]!).sort(),
            ["content", "conversationId", "createdAt", "id", "similarity", "source", "updatedAt"]);
    });

    it("5b: the query drives recall — a different query selects a different memory", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await rememberTexts(user, [PGVECTOR_MEMORY, BAKING_MEMORY]);

        const vectorCtx = await buildQueryContext({ userId: user, conversationId: conv, query: VECTOR_QUERY });
        const bakingCtx = await buildQueryContext({
            userId: user, conversationId: conv, query: "How do I look after a sourdough starter?",
        });

        assert.equal(vectorCtx.relevantMemories[0]!.content, PGVECTOR_MEMORY);
        assert.equal(bakingCtx.relevantMemories[0]!.content, BAKING_MEMORY);
    });

    it("5c: recall is capped by MEMORY_DEFAULT_RECALL_LIMIT", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await rememberTexts(user, Array.from({ length: MEMORY_DEFAULT_RECALL_LIMIT + 3 }, (_, i) =>
            `Fact ${i}: NexusAI stores embedding vectors in Postgres with pgvector for search.`));

        const context = await buildQueryContext({ userId: user, conversationId: conv, query: VECTOR_QUERY });
        assert.equal(context.relevantMemories.length, MEMORY_DEFAULT_RECALL_LIMIT);
        assert.equal(MEMORY_DEFAULT_RECALL_LIMIT, 5);
    });

    it("6: a query with nothing relevant yields an empty memory list", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await rememberTexts(user, [BAKING_MEMORY]);

        // The default distance threshold from constants.ts must exclude the weak hit.
        const context = await buildQueryContext({
            userId: user, conversationId: conv,
            query: "Explain Kubernetes ingress controller TLS termination.",
        });
        assert.deepEqual(context.relevantMemories, []);
    });

    it("7: a conversation with no messages yields an empty message list", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await rememberTexts(user, [PGVECTOR_MEMORY]);

        const context = await buildQueryContext({ userId: user, conversationId: conv, query: VECTOR_QUERY });
        assert.deepEqual(context.recentMessages, []);
        assert.equal(context.relevantMemories.length, 1, "an empty conversation must not suppress recall");
    });

    it("8: a brand-new conversation for a brand-new user is valid empty context", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);

        const context = await buildQueryContext({ userId: user, conversationId: conv, query: VECTOR_QUERY });
        assert.deepEqual(context, {
            conversationSummary: null,
            recentMessages: [],
            relevantMemories: [],
        });
    });

    it("9: user B cannot obtain context for user A's conversation", async () => {
        const a = await createProbeUser(), b = await createProbeUser();
        const convA = await createProbeConversation(a);
        await addProbeMessages(convA, [{ role: "user", content: "A's private message" }]);
        await saveConversationSummary(a, convA, { summary: "A's private summary." });

        const denied = await expectApiError(
            buildQueryContext({ userId: b, conversationId: convA, query: VECTOR_QUERY }), 404);
        const missing = await expectApiError(
            buildQueryContext({
                userId: b, conversationId: "00000000-0000-0000-0000-000000000000", query: VECTOR_QUERY,
            }), 404);

        // Indistinguishable, so the service cannot be used to probe for other users' ids.
        assert.equal(denied.message, missing.message);
        assert.equal(denied.code, missing.code);
    });

    it("9b: one user's memories never appear in the other's context", async () => {
        const a = await createProbeUser(), b = await createProbeUser();
        const convA = await createProbeConversation(a);
        const convB = await createProbeConversation(b);
        await rememberTexts(a, ["A's secret: the staging database lives in eu-central-1."]);
        await rememberTexts(b, ["B's note: the frontend uses Vite and React."]);

        const ctxA = await buildQueryContext({
            userId: a, conversationId: convA, query: "Where does the staging database live?",
        });
        const ctxB = await buildQueryContext({
            userId: b, conversationId: convB, query: "Where does the staging database live?",
        });

        assert.equal(ctxA.relevantMemories.length, 1);
        assert.match(ctxA.relevantMemories[0]!.content, /staging database/);

        // B asks A's exact question and must not reach A's memory.
        assert.ok(!JSON.stringify(ctxB).includes("staging database"), "A's memory leaked into B's context");
        assert.ok(!JSON.stringify(ctxA).includes("Vite"), "B's memory leaked into A's context");
    });

    it("10: the service delegates rather than reimplementing SQL or vector search", async () => {
        const source = readFileSync(
            fileURLToPath(new URL("../../services/retrieval.services.ts", import.meta.url)), "utf8");

        // No SQL and no pgvector operator of its own.
        for (const forbidden of ["SELECT", "INSERT", "UPDATE ", "DELETE", "FROM ", "<=>", "::vector"]) {
            assert.ok(!source.includes(forbidden), `retrieval.services.ts contains "${forbidden}"`);
        }
        // No database handle and no direct repository/embedding access at runtime.
        assert.ok(!source.includes('from "../db/pool'), "must not import the pool");
        assert.ok(!source.includes('from "./embedding.services'), "must not embed on its own");
        assert.ok(!/^import \{[^}]*\} from "\.\.\/repositories/m.test(source),
            "must not make value imports from repositories");

        // It must delegate to the owning services.
        assert.ok(source.includes("getConversationContext("), "should reuse conversationContext.services");
        assert.ok(source.includes("recallRelevantMemories("), "should reuse memory.services");

        // And declare no limits of its own — those live in constants.ts.
        assert.ok(!/=\s*\d+;/.test(source), "retrieval.services.ts declares a numeric literal constant");
    });
});

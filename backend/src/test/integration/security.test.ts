/**
 * Audit section 7 — IDOR across the whole implemented surface.
 *
 * The fixture is the one described in the audit brief:
 *   user A: conversation A, summary A, memories A
 *   user B: conversation B
 * Then B attempts every read and write against A's ids. Each assertion targets the
 * repository or service directly, deliberately bypassing routes and middleware — the point is
 * that ownership holds in SQL even when nothing above it is checking.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { closePool, query } from "../../db/pool.ts";
import {
    findConversationForUser,
    findConversationsByUserId,
    findConversationWithMessages,
    findMessagesForUserConversation,
    findRecentMessagesForUserConversation,
} from "../../repositories/conversation.repository.ts";
import {
    deleteConversationSummary,
    findSummaryByConversationId,
    upsertConversationSummary,
} from "../../repositories/conversationSummary.repository.ts";
import {
    countMemoriesForUser,
    deleteMemoryForUser,
    searchMemoriesByEmbedding,
} from "../../repositories/vectorMemory.repository.ts";
import { getConversationContext } from "../../services/conversationContext.services.ts";
import {
    getConversationSummary,
    saveConversationSummary,
} from "../../services/conversationSummary.services.ts";
import { embedText } from "../../services/embedding.services.ts";
import { recallRelevantMemories, rememberTexts } from "../../services/memory.services.ts";
import {
    addProbeMessages,
    cleanupProbes,
    createProbeConversation,
    createProbeUser,
    expectApiError,
} from "../helpers/probe.ts";

const SECRET = "A's private note: the deploy key rotation is scheduled for Friday.";

let userA = "", userB = "", convA = "", convB = "", memoryA = "", queryVector: number[] = [];

before(async () => {
    userA = await createProbeUser();
    userB = await createProbeUser();
    convA = await createProbeConversation(userA, "A's conversation");
    convB = await createProbeConversation(userB, "B's conversation");
    await addProbeMessages(convA, [
        { role: "user", content: "A asks something private" },
        { role: "assistant", content: SECRET },
    ]);
    await saveConversationSummary(userA, convA, { summary: "A is rotating deploy keys." });
    const [memory] = await rememberTexts(userA, [SECRET], { conversationId: convA });
    memoryA = memory!.id;
    queryVector = await embedText("deploy key rotation");
});

after(async () => { await cleanupProbes(); await closePool(); });

describe("IDOR: conversations", () => {
    it("B cannot resolve A's conversation", async () => {
        assert.equal(await findConversationForUser(convA, userB), null);
        assert.equal(await findConversationWithMessages(convA, userB), null);
    });

    it("A's conversation never appears in B's listing", async () => {
        const ids = (await findConversationsByUserId(userB)).map((c) => c.id);
        assert.deepEqual(ids, [convB]);
    });

    it("B cannot read A's messages by either message query", async () => {
        assert.deepEqual(await findMessagesForUserConversation(convA, userB), []);
        assert.deepEqual(await findRecentMessagesForUserConversation(convA, userB, 4), []);
    });

    it("B cannot read A's conversation context, and gets an indistinguishable 404", async () => {
        const denied = await expectApiError(getConversationContext(userB, convA), 404);
        const missing = await expectApiError(getConversationContext(userB, randomUUID()), 404);
        assert.equal(denied.statusCode, missing.statusCode);
        assert.equal(denied.message, missing.message);
        assert.equal(denied.code, missing.code);
    });
});

describe("IDOR: conversation summaries", () => {
    it("B cannot read A's summary", async () => {
        assert.equal(await findSummaryByConversationId(convA, userB), null);
        await expectApiError(getConversationSummary(userB, convA), 404);
    });

    it("B cannot overwrite A's summary", async () => {
        assert.equal(
            await upsertConversationSummary({
                conversationId: convA, userId: userB,
                summary: "injected by B", lastMessageId: null, messageCount: 0,
            }),
            null,
            "the upsert must write nothing for a non-owner",
        );
        await expectApiError(saveConversationSummary(userB, convA, { summary: "injected by B" }), 404);

        const stillA = await getConversationSummary(userA, convA);
        assert.equal(stillA?.summary, "A is rotating deploy keys.", "A's summary was modified");
    });

    it("B cannot delete A's summary", async () => {
        assert.equal(await deleteConversationSummary(convA, userB), false);
        assert.ok(await getConversationSummary(userA, convA));
    });
});

describe("IDOR: vector memories", () => {
    it("B's semantic search cannot reach A's memory, even with the exact query vector", async () => {
        assert.deepEqual(
            await searchMemoriesByEmbedding({ userId: userB, embedding: queryVector, limit: 50, maxDistance: 2 }),
            [],
        );
        assert.deepEqual(await recallRelevantMemories(userB, "deploy key rotation", { maxDistance: 2 }), []);
        assert.equal(await countMemoriesForUser(userB), 0);
    });

    it("A's memory content never appears in any result B can obtain", async () => {
        const leaked = JSON.stringify([
            await recallRelevantMemories(userB, SECRET, { limit: 50, maxDistance: 2 }),
            await findConversationsByUserId(userB),
            await findMessagesForUserConversation(convA, userB),
        ]);
        assert.ok(!leaked.includes("deploy key"), "A's secret leaked into B's results");
    });

    it("B cannot delete A's memory by id", async () => {
        assert.equal(await deleteMemoryForUser(memoryA, userB), false);
        assert.equal(await countMemoriesForUser(userA), 1, "A's memory was deleted by B");
    });

    it("A still has full access to everything after B's attempts", async () => {
        const context = await getConversationContext(userA, convA);
        assert.equal(context.summary, "A is rotating deploy keys.");
        assert.equal(context.recentMessages.length, 2);
        assert.equal(context.recentMessages[1]!.content, SECRET);
        assert.equal((await recallRelevantMemories(userA, "deploy key rotation", { maxDistance: 2 })).length, 1);
    });
});

describe("IDOR: a forged user id is not a bypass", () => {
    it("a random uuid as userId reaches nothing", async () => {
        const forged = randomUUID();
        assert.equal(await findConversationForUser(convA, forged), null);
        assert.equal(await findSummaryByConversationId(convA, forged), null);
        assert.deepEqual(
            await searchMemoriesByEmbedding({ userId: forged, embedding: queryVector, limit: 10, maxDistance: 2 }),
            [],
        );
        assert.deepEqual(await findConversationsByUserId(forged), []);
    });

    it("A's rows are still intact and owned by A", async () => {
        const { rows } = await query<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM conversations WHERE id = $1 AND user_id = $2`, [convA, userA]);
        assert.equal(rows[0]!.n, 1);
    });
});

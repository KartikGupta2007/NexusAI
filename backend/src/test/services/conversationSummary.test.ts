/** Audit section 3 — conversation_summaries: CRUD, upsert, timestamps, ownership, cascade. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { closePool, query } from "../../db/pool.ts";
import {
    deleteConversationSummary,
    findSummaryByConversationId,
} from "../../repositories/conversationSummary.repository.ts";
import {
    getConversationSummary,
    saveConversationSummary,
} from "../../services/conversationSummary.services.ts";
import {
    addProbeMessages,
    cleanupProbes,
    createProbeConversation,
    createProbeUser,
    expectApiError,
    PG,
    expectPgError,
} from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

const countSummaries = async (conversationId: string) =>
    (await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM conversation_summaries WHERE conversation_id = $1`,
        [conversationId],
    )).rows[0]!.n;

describe("conversation summaries", () => {
    it("A: a conversation with no summary yields null, not an error", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        assert.equal(await getConversationSummary(user, conv), null);
    });

    it("B/C: a summary can be saved and read back exactly", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        const [, lastId] = await addProbeMessages(conv, [
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
        ]);

        const saved = await saveConversationSummary(user, conv, {
            summary: "User is investigating pgvector index types.",
            lastMessageId: lastId!,
            messageCount: 2,
        });
        assert.equal(saved.summary, "User is investigating pgvector index types.");
        assert.equal(saved.lastMessageId, lastId);
        assert.equal(saved.messageCount, 2);

        const read = await getConversationSummary(user, conv);
        assert.equal(read?.summary, saved.summary);
        assert.equal(read?.lastMessageId, lastId, "BIGINT watermark must survive the round trip");
        assert.equal(typeof read?.lastMessageId, "string", "BIGINT must stay a string");
    });

    it("D/E/F: update is an upsert — one row, created_at frozen, updated_at advances", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);

        const first = await saveConversationSummary(user, conv, { summary: "First version." });
        assert.equal(await countSummaries(conv), 1);

        const second = await saveConversationSummary(user, conv, {
            summary: "Second version.",
            messageCount: 6,
        });

        assert.equal(second.summary, "Second version.");
        assert.equal(await countSummaries(conv), 1, "upsert must not create a second row");
        assert.equal(
            +new Date(second.createdAt), +new Date(first.createdAt),
            "created_at must not change on update",
        );
        assert.ok(
            +new Date(second.updatedAt) > +new Date(first.updatedAt),
            `updated_at must advance: ${first.updatedAt.toISOString()} -> ${second.updatedAt.toISOString()}`,
        );
        assert.equal(second.messageCount, 6);
    });

    it("G: user B cannot read user A's summary", async () => {
        const a = await createProbeUser(), b = await createProbeUser();
        const conv = await createProbeConversation(a);
        await saveConversationSummary(a, conv, { summary: "A's private summary." });

        const denied = await expectApiError(getConversationSummary(b, conv), 404);
        const missing = await expectApiError(getConversationSummary(b, randomUUID()), 404);
        assert.equal(denied.message, missing.message, "must not distinguish existing from foreign");
        assert.equal(denied.code, missing.code);

        // The repository alone must also refuse, not just the service.
        assert.equal(await findSummaryByConversationId(conv, b), null);
    });

    it("G2: user B cannot update or delete user A's summary", async () => {
        const a = await createProbeUser(), b = await createProbeUser();
        const conv = await createProbeConversation(a);
        await saveConversationSummary(a, conv, { summary: "A's original." });

        await expectApiError(saveConversationSummary(b, conv, { summary: "injected by B" }), 404);
        assert.equal(await deleteConversationSummary(conv, b), false, "B's delete must be a no-op");

        const stillA = await getConversationSummary(a, conv);
        assert.equal(stillA?.summary, "A's original.", "A's summary must be untouched");
        assert.equal(await countSummaries(conv), 1);
    });

    it("H: deleting the conversation cascades the summary away", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await saveConversationSummary(user, conv, { summary: "To be cascaded." });
        assert.equal(await countSummaries(conv), 1);

        await query(`DELETE FROM conversations WHERE id = $1`, [conv]);
        assert.equal(await countSummaries(conv), 0);
    });

    it("H2: deleting the user cascades the summary away", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await saveConversationSummary(user, conv, { summary: "To be cascaded via user." });

        await query(`DELETE FROM users WHERE id = $1`, [user]);
        assert.equal(await countSummaries(conv), 0);
    });

    it("I: blank and whitespace-only summaries are rejected with a 400", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await expectApiError(saveConversationSummary(user, conv, { summary: "" }), 400);
        await expectApiError(saveConversationSummary(user, conv, { summary: "   \n " }), 400);
        assert.equal(await countSummaries(conv), 0, "no row may be written for invalid input");
    });

    it("I2: the not-blank CHECK also holds at the database level", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        await expectPgError(
            query(`INSERT INTO conversation_summaries (conversation_id, summary) VALUES ($1, '   ')`, [conv]),
            PG.CHECK,
        );
    });

    it("last_message_id ON DELETE SET NULL degrades instead of breaking the row", async () => {
        const user = await createProbeUser();
        const conv = await createProbeConversation(user);
        const [msgId] = await addProbeMessages(conv, [{ role: "user", content: "will be deleted" }]);
        await saveConversationSummary(user, conv, { summary: "Has a watermark.", lastMessageId: msgId! });

        await query(`DELETE FROM messages WHERE id = $1`, [msgId]);

        const after = await getConversationSummary(user, conv);
        assert.ok(after, "the summary row must survive its watermark being deleted");
        assert.equal(after.lastMessageId, null, "watermark should be NULL, not dangling");
        assert.equal(after.summary, "Has a watermark.");
    });
});

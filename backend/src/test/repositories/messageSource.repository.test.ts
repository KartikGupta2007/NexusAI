/** message_sources — constraints, ordering, ownership, cascades. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { closePool, query } from "../../db/pool.ts";
import {
    deleteMessageSourcesForUserMessage,
    findMessageSourcesForUserMessage,
    insertMessageSources,
    replaceMessageSources,
} from "../../repositories/messageSource.repository.ts";
import {
    addProbeMessage,
    cleanupProbes,
    createProbeAssistantMessage,
    createProbeConversation,
    createProbeUser,
    expectPgError,
    PG,
} from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

const WIKI = { position: 1, url: "https://en.wikipedia.org/wiki/Nvidia", title: "Nvidia" };
const NVIDIA = { position: 2, url: "https://www.nvidia.com/", title: "NVIDIA Official" };
const BRITANNICA = { position: 3, url: "https://www.britannica.com/money/Nvidia", title: "Britannica" };

const countSources = async (messageId: string) =>
    (await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM message_sources WHERE message_id = $1::bigint`, [messageId],
    )).rows[0]!.n;

describe("message_sources: insert and retrieve", () => {
    it("1/2: a source can be inserted and retrieved", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        const inserted = await insertMessageSources({ messageId, userId, sources: [WIKI] });

        assert.equal(inserted.length, 1);
        assert.equal(inserted[0]!.url, WIKI.url);
        assert.equal(inserted[0]!.title, WIKI.title);
        assert.equal(inserted[0]!.position, 1);

        const read = await findMessageSourcesForUserMessage(messageId, userId);
        assert.equal(read.length, 1);
        assert.equal(read[0]!.id, inserted[0]!.id);
    });

    it("3: multiple sources preserve position, in one round trip", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        // Deliberately out of order on the way in — order must come from `position`, not input
        // order and not created_at (all three rows share NOW()).
        await insertMessageSources({ messageId, userId, sources: [BRITANNICA, WIKI, NVIDIA] });

        const read = await findMessageSourcesForUserMessage(messageId, userId);
        assert.deepEqual(read.map((s) => s.position), [1, 2, 3]);
        assert.deepEqual(read.map((s) => s.title), ["Nvidia", "NVIDIA Official", "Britannica"]);

        const timestamps = new Set(read.map((s) => s.created_at.toISOString()));
        assert.equal(timestamps.size, 1, "batch shares created_at — so position must carry order");
    });

    it("8/9: content and favicon are optional", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await insertMessageSources({
            messageId, userId,
            sources: [
                { ...WIKI, content: "Nvidia is a technology company.", favicon: "https://en.wikipedia.org/favicon.ico" },
                { ...NVIDIA, content: null, favicon: null },
                BRITANNICA, // content/favicon omitted entirely
            ],
        });

        const read = await findMessageSourcesForUserMessage(messageId, userId);
        assert.equal(read[0]!.content, "Nvidia is a technology company.");
        assert.match(read[0]!.favicon!, /favicon\.ico$/);
        assert.equal(read[1]!.content, null);
        assert.equal(read[1]!.favicon, null);
        assert.equal(read[2]!.content, null, "omitted content must arrive as NULL");
        assert.equal(read[2]!.favicon, null);
    });

    it("a message with no sources is an empty array", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        assert.deepEqual(await findMessageSourcesForUserMessage(messageId, userId), []);
    });

    it("URLs and titles containing SQL metacharacters are stored verbatim", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        const nasty = {
            position: 1,
            url: "https://example.com/?q=1');DROP TABLE message_sources;--",
            title: "O'Reilly \"quoted\" -- title; DROP TABLE users;",
        };
        await insertMessageSources({ messageId, userId, sources: [nasty] });

        const read = await findMessageSourcesForUserMessage(messageId, userId);
        assert.equal(read[0]!.url, nasty.url);
        assert.equal(read[0]!.title, nasty.title);
        // The tables are all still there.
        assert.equal((await query(`SELECT COUNT(*) FROM message_sources`)).rows.length, 1);
    });
});

describe("message_sources: constraints", () => {
    it("4: a duplicate (message_id, position) is rejected", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await insertMessageSources({ messageId, userId, sources: [WIKI] });
        await expectPgError(
            insertMessageSources({ messageId, userId, sources: [{ ...NVIDIA, position: 1 }] }),
            PG.UNIQUE,
        );
        assert.equal(await countSources(messageId), 1);
    });

    it("4b: a duplicate position inside one batch is rejected", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await expectPgError(
            insertMessageSources({ messageId, userId, sources: [WIKI, { ...NVIDIA, position: 1 }] }),
            PG.UNIQUE,
        );
        assert.equal(await countSources(messageId), 0, "the whole statement must roll back");
    });

    it("5: position below 1 is rejected", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        for (const position of [0, -1]) {
            await expectPgError(
                insertMessageSources({ messageId, userId, sources: [{ ...WIKI, position }] }),
                PG.CHECK,
            );
        }
        assert.equal(await countSources(messageId), 0);
    });

    it("6: a blank url is rejected", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        for (const url of ["", "   "]) {
            await expectPgError(
                insertMessageSources({ messageId, userId, sources: [{ ...WIKI, url }] }),
                PG.CHECK,
            );
        }
    });

    it("7: a blank title is rejected", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        for (const title of ["", "  \t "]) {
            await expectPgError(
                insertMessageSources({ messageId, userId, sources: [{ ...WIKI, title }] }),
                PG.CHECK,
            );
        }
    });

    it("10: a nonexistent message_id inserts nothing", async () => {
        const { userId } = await createProbeAssistantMessage();
        // The INSERT ... SELECT finds no message row, so there is nothing to insert. It is not
        // an FK error because the statement never produces a candidate row.
        assert.deepEqual(
            await insertMessageSources({ messageId: "999999999999", userId, sources: [WIKI] }),
            [],
        );
    });

    it("10b: NULL url/title/message_id are rejected at the column level", async () => {
        const { messageId } = await createProbeAssistantMessage();
        await expectPgError(
            query(`INSERT INTO message_sources (message_id, position, url, title) VALUES (NULL,1,'u','t')`),
            PG.NOT_NULL);
        await expectPgError(
            query(`INSERT INTO message_sources (message_id, position, url, title) VALUES ($1::bigint,1,NULL,'t')`, [messageId]),
            PG.NOT_NULL);
        await expectPgError(
            query(`INSERT INTO message_sources (message_id, position, url, title) VALUES ($1::bigint,1,'u',NULL)`, [messageId]),
            PG.NOT_NULL);
        await expectPgError(
            query(`INSERT INTO message_sources (message_id, position, url, title) VALUES (424242424242,1,'u','t')`),
            PG.FOREIGN_KEY);
    });
});

describe("message_sources: ownership", () => {
    it("11/12/13: only the owner can read, write or delete a message's sources", async () => {
        const { userId: a, messageId } = await createProbeAssistantMessage();
        const b = await createProbeUser();
        await insertMessageSources({ messageId, userId: a, sources: [WIKI, NVIDIA] });

        // 11 — owner
        assert.equal((await findMessageSourcesForUserMessage(messageId, a)).length, 2);

        // 12 — foreign user
        assert.deepEqual(await findMessageSourcesForUserMessage(messageId, b), []);
        assert.deepEqual(
            await insertMessageSources({ messageId, userId: b, sources: [BRITANNICA] }), [],
            "B's insert must write nothing",
        );
        assert.equal(await deleteMessageSourcesForUserMessage(messageId, b), 0,
            "B's delete must remove nothing");

        // 13 — forged user id
        const forged = "00000000-0000-0000-0000-000000000000";
        assert.deepEqual(await findMessageSourcesForUserMessage(messageId, forged), []);
        assert.deepEqual(await insertMessageSources({ messageId, userId: forged, sources: [BRITANNICA] }), []);

        // A's data is exactly as it was.
        assert.equal(await countSources(messageId), 2);
        assert.deepEqual((await findMessageSourcesForUserMessage(messageId, a)).map((s) => s.title),
            ["Nvidia", "NVIDIA Official"]);
    });

    it("14: A's url, title and content never appear in anything B can read", async () => {
        const { userId: a, messageId } = await createProbeAssistantMessage();
        const b = await createProbeUser();
        await insertMessageSources({
            messageId, userId: a,
            sources: [{ position: 1, url: "https://secret.internal/a", title: "A-SECRET-TITLE", content: "A-SECRET-BODY" }],
        });

        const visibleToB = JSON.stringify(await findMessageSourcesForUserMessage(messageId, b));
        for (const secret of ["secret.internal", "A-SECRET-TITLE", "A-SECRET-BODY"]) {
            assert.ok(!visibleToB.includes(secret), `${secret} leaked to B`);
        }
    });
});

describe("message_sources: replace", () => {
    it("replaceMessageSources swaps the whole set atomically", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await insertMessageSources({ messageId, userId, sources: [WIKI, NVIDIA, BRITANNICA] });
        assert.equal(await countSources(messageId), 3);

        // Fewer sources than before: the stale third row must not survive at the tail.
        const replaced = await replaceMessageSources({
            messageId, userId,
            sources: [{ position: 1, url: "https://new.example/one", title: "New One" }],
        });
        assert.equal(replaced.length, 1);
        assert.equal(await countSources(messageId), 1);
        assert.deepEqual((await findMessageSourcesForUserMessage(messageId, userId)).map((s) => s.title),
            ["New One"]);
    });

    it("a foreign replace neither deletes nor inserts", async () => {
        const { userId: a, messageId } = await createProbeAssistantMessage();
        const b = await createProbeUser();
        await insertMessageSources({ messageId, userId: a, sources: [WIKI] });

        assert.deepEqual(
            await replaceMessageSources({ messageId, userId: b, sources: [NVIDIA] }), [],
        );
        assert.equal(await countSources(messageId), 1, "B's replace destroyed A's sources");
    });
});

describe("message_sources: cascades", () => {
    it("16: deleting the message deletes its sources", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await insertMessageSources({ messageId, userId, sources: [WIKI, NVIDIA] });

        await query(`DELETE FROM messages WHERE id = $1::bigint`, [messageId]);
        assert.equal(await countSources(messageId), 0);
    });

    it("17: deleting the conversation deletes messages and their sources", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const messageId = await addProbeMessage(conversationId, "assistant");
        await insertMessageSources({ messageId, userId, sources: [WIKI] });

        await query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
        assert.equal(await countSources(messageId), 0);
    });

    it("18: deleting the user cascades all the way down to sources", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await insertMessageSources({ messageId, userId, sources: [WIKI, NVIDIA, BRITANNICA] });
        assert.equal(await countSources(messageId), 3);

        await query(`DELETE FROM users WHERE id = $1`, [userId]);
        assert.equal(await countSources(messageId), 0);
    });
});

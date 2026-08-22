/** messageSource.services — validation, normalization, limits, ownership, DTO shape. */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
    MESSAGE_MAX_SOURCES,
    MESSAGE_SOURCE_MAX_CONTENT_CHARS,
    MESSAGE_SOURCE_MAX_TITLE_CHARS,
    MESSAGE_SOURCE_MAX_URL_CHARS,
} from "../../constants.ts";
import { closePool, query } from "../../db/pool.ts";
import type { MessageSourceInput } from "../../repositories/messageSource.repository.ts";
import {
    attachMessageSources,
    clearMessageSources,
    getMessageSources,
} from "../../services/messageSource.services.ts";
import {
    addProbeMessage,
    cleanupProbes,
    createProbeAssistantMessage,
    createProbeConversation,
    createProbeUser,
    expectApiError,
} from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

const SOURCES: MessageSourceInput[] = [
    { position: 1, url: "https://www.nvidia.com/", title: "NVIDIA", content: "GPU maker.", favicon: "https://www.nvidia.com/favicon.ico" },
    { position: 2, url: "https://en.wikipedia.org/wiki/Nvidia", title: "NVIDIA History" },
    { position: 3, url: "https://www.britannica.com/money/Nvidia", title: "Britannica" },
];

const countSources = async (messageId: string) =>
    (await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM message_sources WHERE message_id = $1::bigint`, [messageId],
    )).rows[0]!.n;

describe("messageSource.services", () => {
    it("21/22: attaches sources in order and returns a camelCase public DTO", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        const attached = await attachMessageSources(userId, messageId, SOURCES);

        assert.deepEqual(attached.map((s) => s.position), [1, 2, 3]);
        assert.deepEqual(attached.map((s) => s.title), ["NVIDIA", "NVIDIA History", "Britannica"]);

        // No snake_case, and no columns the frontend has no use for.
        assert.deepEqual(Object.keys(attached[0]!).sort(),
            ["content", "createdAt", "favicon", "id", "position", "title", "url"]);
        const serialized = JSON.stringify(attached);
        for (const leaked of ["message_id", "created_at", "messageId"]) {
            assert.ok(!serialized.includes(leaked), `${leaked} exposed in the DTO`);
        }
        assert.equal(attached[1]!.content, null, "omitted content becomes null");
    });

    it("reads back what was attached, ordered by position", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await attachMessageSources(userId, messageId, [SOURCES[2]!, SOURCES[0]!, SOURCES[1]!]);

        const read = await getMessageSources(userId, messageId);
        assert.deepEqual(read.map((s) => s.position), [1, 2, 3]);
        assert.deepEqual(read.map((s) => s.title), ["NVIDIA", "NVIDIA History", "Britannica"]);
    });

    it("a message with no sources reads as an empty array", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        assert.deepEqual(await getMessageSources(userId, messageId), []);
    });

    it("19: invalid input is rejected with a 400 before anything is written", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await attachMessageSources(userId, messageId, [SOURCES[0]!]);

        const bad: [string, MessageSourceInput[]][] = [
            ["blank url", [{ position: 1, url: "   ", title: "t" }]],
            ["tab-only url", [{ position: 1, url: "\t", title: "t" }]],
            ["blank title", [{ position: 1, url: "https://a.example/", title: "  " }]],
            ["tab-only title", [{ position: 1, url: "https://a.example/", title: "\t\n" }]],
            ["position 0", [{ position: 0, url: "https://a.example/", title: "t" }]],
            ["negative position", [{ position: -3, url: "https://a.example/", title: "t" }]],
            ["fractional position", [{ position: 1.5, url: "https://a.example/", title: "t" }]],
            ["duplicate positions", [
                { position: 1, url: "https://a.example/", title: "a" },
                { position: 1, url: "https://b.example/", title: "b" },
            ]],
            ["over-long url", [{ position: 1, url: `https://a.example/${"x".repeat(MESSAGE_SOURCE_MAX_URL_CHARS)}`, title: "t" }]],
            ["over-long title", [{ position: 1, url: "https://a.example/", title: "x".repeat(MESSAGE_SOURCE_MAX_TITLE_CHARS + 1) }]],
            ["bad element in an otherwise good batch", [SOURCES[0]!, { position: 2, url: "", title: "t" }]],
        ];

        for (const [label, sources] of bad) {
            await expectApiError(attachMessageSources(userId, messageId, sources), 400);
            assert.equal(await countSources(messageId), 1, `"${label}" modified stored sources`);
        }
        // The original source is untouched.
        assert.equal((await getMessageSources(userId, messageId))[0]!.title, "NVIDIA");
    });

    it("20: the source count limit is enforced", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        const many = Array.from({ length: MESSAGE_MAX_SOURCES + 1 }, (_, i) => ({
            position: i + 1, url: `https://example.com/${i}`, title: `Source ${i}`,
        }));

        const error = await expectApiError(attachMessageSources(userId, messageId, many), 400);
        assert.match(error.message, new RegExp(String(MESSAGE_MAX_SOURCES)));
        assert.equal(await countSources(messageId), 0);

        // Exactly at the limit is accepted.
        const atLimit = many.slice(0, MESSAGE_MAX_SOURCES);
        assert.equal((await attachMessageSources(userId, messageId, atLimit)).length, MESSAGE_MAX_SOURCES);
    });

    it("over-long content is truncated, not rejected", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        const [stored] = await attachMessageSources(userId, messageId, [
            { position: 1, url: "https://a.example/", title: "t", content: "y".repeat(MESSAGE_SOURCE_MAX_CONTENT_CHARS + 500) },
        ]);
        assert.equal(stored!.content!.length, MESSAGE_SOURCE_MAX_CONTENT_CHARS);
    });

    it("whitespace is trimmed and blank content/favicon normalise to null", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        const [stored] = await attachMessageSources(userId, messageId, [
            { position: 1, url: "  https://a.example/  ", title: "  Padded Title  ", content: "   ", favicon: "  " },
        ]);
        assert.equal(stored!.url, "https://a.example/");
        assert.equal(stored!.title, "Padded Title");
        assert.equal(stored!.content, null, "whitespace-only content should be null, not ''");
        assert.equal(stored!.favicon, null);
    });

    it("attaching replaces the previous set rather than appending", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await attachMessageSources(userId, messageId, SOURCES);
        assert.equal(await countSources(messageId), 3);

        const replaced = await attachMessageSources(userId, messageId, [
            { position: 1, url: "https://fresh.example/", title: "Fresh" },
        ]);
        assert.equal(replaced.length, 1);
        assert.equal(await countSources(messageId), 1, "stale sources survived the replace");
    });

    it("an empty array clears the sources", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await attachMessageSources(userId, messageId, SOURCES);
        assert.deepEqual(await attachMessageSources(userId, messageId, []), []);
        assert.equal(await countSources(messageId), 0);
    });

    it("clearMessageSources reports how many it removed", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        await attachMessageSources(userId, messageId, SOURCES);
        assert.equal(await clearMessageSources(userId, messageId), 3);
        assert.equal(await clearMessageSources(userId, messageId), 0);
    });

    it("16: sources may only be attached to an assistant message", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);

        for (const role of ["user", "system"] as const) {
            const messageId = await addProbeMessage(conversationId, role);
            const error = await expectApiError(
                attachMessageSources(userId, messageId, [SOURCES[0]!]), 400);
            assert.match(error.message, /assistant/);
            assert.equal(await countSources(messageId), 0);
        }

        const assistantId = await addProbeMessage(conversationId, "assistant");
        assert.equal((await attachMessageSources(userId, assistantId, [SOURCES[0]!])).length, 1);
    });

    it("15: a foreign message is a 404 identical to a nonexistent one", async () => {
        const { userId: a, messageId } = await createProbeAssistantMessage();
        const b = await createProbeUser();
        await attachMessageSources(a, messageId, SOURCES);

        const foreign = await expectApiError(getMessageSources(b, messageId), 404);
        const missing = await expectApiError(getMessageSources(b, "999999999999"), 404);
        assert.equal(foreign.message, missing.message);
        assert.equal(foreign.code, missing.code);

        // B cannot write to it either, and A's sources are unchanged.
        await expectApiError(attachMessageSources(b, messageId, [{ position: 1, url: "https://evil.example/", title: "evil" }]), 404);
        await expectApiError(clearMessageSources(b, messageId), 404);
        assert.equal(await countSources(messageId), 3);
        assert.deepEqual((await getMessageSources(a, messageId)).map((s) => s.title),
            ["NVIDIA", "NVIDIA History", "Britannica"]);
    });

    it("20: BIGINT message ids are handled as strings throughout", async () => {
        const { userId, messageId } = await createProbeAssistantMessage();
        assert.equal(typeof messageId, "string");
        await attachMessageSources(userId, messageId, [SOURCES[0]!]);

        // A value beyond Number.MAX_SAFE_INTEGER must not be coerced into a number en route.
        const huge = "9007199254740993";
        assert.notEqual(Number(huge).toString(), huge, "premise: this id is unsafe as a JS number");
        await expectApiError(getMessageSources(userId, huge), 404);
    });
});

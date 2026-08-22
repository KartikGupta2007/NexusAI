/**
 * Credit enforcement on the chat endpoints, over real HTTP.
 *
 * Providers are stubbed through `setChatDepsForTests`, so **no test here reaches Tavily or
 * Anthropic**. The stub is installed in `before` and cleared in `after`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import app from "../../app.ts";
import { CREDITS_PER_QUERY, DEFAULT_USER_CREDITS } from "../../constants.ts";
import { closePool, query } from "../../db/pool.ts";
import { setChatDepsForTests } from "../../services/chat.services.ts";
import { signAccessToken } from "../../services/token.services.ts";
import {
    cleanupProbes,
    createProbeConversation,
    createProbeUser,
    readProbeCredits,
    setProbeCredits,
} from "../helpers/probe.ts";
import { streamingAnswer } from "../helpers/stubs.ts";

type Json = Record<string, any>;

let baseUrl = "";
let server: ReturnType<typeof app.listen>;
let searchCalls = 0;
let answerCalls = 0;

const WEB = {
    results: [{ title: "NVIDIA", url: "https://www.nvidia.com/", content: "GPUs.", score: 1, publishedDate: "", id: "1" }],
};

const emailOf = async (id: string) =>
    (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [id])).rows[0]!.email;

const tokenFor = async (id: string) => signAccessToken({ id, email: await emailOf(id) });

/** POST returning either the parsed JSON body or the raw SSE text. */
const post = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    return {
        status: response.status,
        contentType,
        text,
        json: contentType.includes("application/json") ? (JSON.parse(text) as Json) : null,
    };
};

/** Parses an SSE body into [event, data] pairs. */
const parseEvents = (raw: string): { event: string; data: Json }[] =>
    raw
        .split("\n\n")
        .filter((block) => block.trim().length > 0)
        .map((block) => {
            const event = /^event: (.+)$/m.exec(block)?.[1] ?? "";
            const data = /^data: (.+)$/m.exec(block)?.[1] ?? "{}";
            return { event, data: JSON.parse(data) as Json };
        });

const messageCount = async (userId: string) =>
    (await query<{ n: number }>(
        `SELECT COUNT(*)::int n FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = $1`, [userId])).rows[0]!.n;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

    setChatDepsForTests({
        search: async () => { searchCalls += 1; return WEB; },
        answer: streamingAnswer(
            { answer: "NVIDIA designs GPUs.", citations: ["source_1"], title: "Nvidia overview" },
            { chunks: 4, onCall: () => { answerCalls += 1; } },
        ),
        summary: async () => "A summary.",
        extract: async () => ({ memories: [] }),
    });
});

after(async () => {
    setChatDepsForTests(null);
    await cleanupProbes();
    await new Promise((resolve) => server.close(resolve));
    await closePool();
});

describe("credits: successful requests", () => {
    it("12/22/23/24: /chat/new charges 20 once and reports the balance on done only", async () => {
        const userId = await createProbeUser();
        const token = await tokenFor(userId);
        const before = await readProbeCredits(userId);

        const { status, contentType, text } = await post("/chat/new", { query: "Tell me about Nvidia" }, token);
        assert.equal(status, 200);
        assert.match(contentType, /text\/event-stream/);

        const events = parseEvents(text);
        const done = events.find((e) => e.event === "done")!;
        const tokens = events.filter((e) => e.event === "token");

        // 22 — the balance rides on done.
        assert.equal(done.data.creditsRemaining, before - CREDITS_PER_QUERY);
        assert.equal(done.data.creditsRemaining, DEFAULT_USER_CREDITS - CREDITS_PER_QUERY);
        assert.equal(done.data.title, "Nvidia overview");

        // 23 — and nowhere else.
        assert.ok(tokens.length > 0, "the answer should have streamed");
        for (const event of tokens) {
            assert.ok(!("creditsRemaining" in event.data), "token events must not carry the balance");
        }
        for (const event of events.filter((e) => e.event !== "done")) {
            assert.ok(!("creditsRemaining" in event.data), `${event.event} must not carry the balance`);
        }

        // 24 — charged exactly once.
        assert.equal(await readProbeCredits(userId), before - CREDITS_PER_QUERY);
    });

    it("13: /chat/:conversationId charges 20 and reports the balance, with no title", async () => {
        const userId = await createProbeUser();
        const token = await tokenFor(userId);
        const conversationId = await createProbeConversation(userId, "Original title");
        const before = await readProbeCredits(userId);

        const { status, text } = await post(`/chat/${conversationId}`, { query: "and their AI GPUs?" }, token);
        assert.equal(status, 200);

        const done = parseEvents(text).find((e) => e.event === "done")!;
        assert.equal(done.data.creditsRemaining, before - CREDITS_PER_QUERY);
        assert.equal(done.data.conversationId, conversationId);
        // Existing contract preserved: continuing never retitles.
        assert.equal(done.data.title, null);
        assert.equal(await readProbeCredits(userId), before - CREDITS_PER_QUERY);
    });

    it("successive queries walk the balance down by 20 each", async () => {
        const userId = await createProbeUser();
        const token = await tokenFor(userId);
        await setProbeCredits(userId, 60);

        for (const expected of [40, 20, 0]) {
            const { text } = await post("/chat/new", { query: "another question" }, token);
            assert.equal(parseEvents(text).find((e) => e.event === "done")!.data.creditsRemaining, expected);
        }

        // Fourth attempt has nothing left.
        const { status, json } = await post("/chat/new", { query: "one too many" }, token);
        assert.equal(status, 402);
        assert.equal(json!.code, "INSUFFICIENT_CREDITS");
    });
});

describe("credits: insufficient balance", () => {
    it("14/15/16/17/18: a 402 in JSON, with nothing written and no provider touched", async () => {
        const userId = await createProbeUser();
        const token = await tokenFor(userId);
        await setProbeCredits(userId, CREDITS_PER_QUERY - 1);
        const conversationId = await createProbeConversation(userId);

        const searchBefore = searchCalls;
        const answerBefore = answerCalls;
        const messagesBefore = await messageCount(userId);

        for (const path of ["/chat/new", `/chat/${conversationId}`]) {
            const { status, contentType, json } = await post(path, { query: "a question" }, token);

            assert.equal(status, 402, `${path} should be payment-required`);
            assert.match(contentType, /application\/json/, "must not open an event stream");
            assert.equal(json!.success, false);
            assert.equal(json!.code, "INSUFFICIENT_CREDITS");
            assert.equal(json!.message, "You do not have enough credits for this query.");
            // No SQL or internal detail.
            assert.deepEqual(json!.errors, []);
            assert.ok(!JSON.stringify(json).match(/UPDATE|SELECT|users|pg/i));
        }

        assert.equal(searchCalls, searchBefore, "17: Tavily must not be called");
        assert.equal(answerCalls, answerBefore, "18: Claude must not be called");
        assert.equal(await messageCount(userId), messagesBefore, "16: no message may be created");
        assert.equal(await readProbeCredits(userId), CREDITS_PER_QUERY - 1, "balance untouched");
    });

    it("a zero balance is rejected too, and no conversation is created", async () => {
        const userId = await createProbeUser();
        const token = await tokenFor(userId);
        await setProbeCredits(userId, 0);

        const { status } = await post("/chat/new", { query: "hello" }, token);
        assert.equal(status, 402);
        assert.equal((await query<{ n: number }>(
            `SELECT COUNT(*)::int n FROM conversations WHERE user_id = $1`, [userId])).rows[0]!.n, 0);
    });
});

describe("credits: rejected requests cost nothing", () => {
    it("19: an invalid query does not consume credits", async () => {
        const userId = await createProbeUser();
        const token = await tokenFor(userId);
        const before = await readProbeCredits(userId);

        for (const body of [{}, { query: "" }, { query: "   " }, { query: 42 }, { query: "x".repeat(2001) }]) {
            const { status } = await post("/chat/new", body, token);
            assert.equal(status, 400);
        }
        assert.equal(await readProbeCredits(userId), before, "validation failures must be free");
    });

    it("20: an unauthorized request does not consume credits", async () => {
        const userId = await createProbeUser();
        const before = await readProbeCredits(userId);

        assert.equal((await post("/chat/new", { query: "hi" })).status, 401);
        assert.equal((await post("/chat/new", { query: "hi" }, "not-a-token")).status, 401);
        assert.equal(await readProbeCredits(userId), before);
    });

    it("21: a foreign or unknown conversation does not consume credits", async () => {
        const owner = await createProbeUser();
        const intruder = await createProbeUser();
        const token = await tokenFor(intruder);
        const conversationId = await createProbeConversation(owner);
        const before = await readProbeCredits(intruder);

        assert.equal((await post(`/chat/${conversationId}`, { query: "intrusion" }, token)).status, 404);
        assert.equal((await post(`/chat/${randomUUID()}`, { query: "q" }, token)).status, 404);
        assert.equal(await readProbeCredits(intruder), before, "a 404 must be free");
        assert.equal(await readProbeCredits(owner), DEFAULT_USER_CREDITS, "the owner is untouched");
    });

    it("a client cannot supply credits or userId to top itself up", async () => {
        const userId = await createProbeUser();
        const token = await tokenFor(userId);
        await setProbeCredits(userId, CREDITS_PER_QUERY - 1);

        for (const body of [
            { query: "hi", credits: 10_000 },
            { query: "hi", userId: randomUUID() },
            { query: "hi", creditsRemaining: 999 },
        ]) {
            const { status } = await post("/chat/new", body, token);
            assert.equal(status, 400, "the strict body schema must reject unknown keys");
        }
        assert.equal(await readProbeCredits(userId), CREDITS_PER_QUERY - 1);
    });
});

describe("credits: concurrency over HTTP", () => {
    it("25: two concurrent chat requests cannot overspend", async () => {
        const userId = await createProbeUser();
        const token = await tokenFor(userId);
        await setProbeCredits(userId, CREDITS_PER_QUERY);

        const [first, second] = await Promise.all([
            post("/chat/new", { query: "first concurrent" }, token),
            post("/chat/new", { query: "second concurrent" }, token),
        ]);

        const statuses = [first.status, second.status].sort();
        assert.deepEqual(statuses, [200, 402], "exactly one request may be served");
        assert.equal(await readProbeCredits(userId), 0);
        assert.ok((await readProbeCredits(userId)) >= 0, "balance may never go negative");

        // The served one reports the true post-charge balance.
        const served = [first, second].find((r) => r.status === 200)!;
        assert.equal(parseEvents(served.text).find((e) => e.event === "done")!.data.creditsRemaining, 0);
    });
});

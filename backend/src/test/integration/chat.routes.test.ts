/**
 * The chat routes over real HTTP.
 *
 * Covers everything that resolves *before* the pipeline reaches a provider: routing order,
 * auth, body/param validation, and ownership. The pipeline itself is covered in
 * chat.services.test.ts with stubbed providers — so **no test here reaches Tavily or
 * Anthropic**, and none is allowed to run the full pipeline.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import app from "../../app.ts";
import { closePool, query } from "../../db/pool.ts";
import { CHAT_MAX_QUERY_CHARS } from "../../constants.ts";
import { signAccessToken } from "../../services/token.services.ts";
import { cleanupProbes, createProbeConversation, createProbeUser } from "../helpers/probe.ts";

type Json = Record<string, any>;

let baseUrl = "";
let server: ReturnType<typeof app.listen>;
const userA = { id: "", email: "", token: "" };
const userB = { id: "", email: "", token: "" };
let convA = "";

const post = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Json };
};

const emailOf = async (id: string) =>
    (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [id])).rows[0]!.email;

const conversationCount = async (userId: string) =>
    (await query<{ n: number }>(
        `SELECT COUNT(*)::int n FROM conversations WHERE user_id = $1`, [userId])).rows[0]!.n;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

    userA.id = await createProbeUser();
    userB.id = await createProbeUser();
    userA.email = await emailOf(userA.id);
    userB.email = await emailOf(userB.id);
    userA.token = signAccessToken(userA);
    userB.token = signAccessToken(userB);
    convA = await createProbeConversation(userA.id, "A's conversation");
});

after(async () => {
    await cleanupProbes();
    await new Promise((resolve) => server.close(resolve));
    await closePool();
});

describe("POST /api/v1/chat/new", () => {
    it("14: an unauthenticated request is rejected", async () => {
        const { status, body } = await post("/chat/new", { query: "hello" });
        assert.equal(status, 401);
        assert.equal(body.success, false);
    });

    it("13: an invalid query is a 400 and creates nothing", async () => {
        const before = await conversationCount(userA.id);
        for (const payload of [
            {}, { query: "" }, { query: "   " },
            { query: "x".repeat(CHAT_MAX_QUERY_CHARS + 1) }, { query: 42 }, { query: null },
        ]) {
            const { status, body } = await post("/chat/new", payload, userA.token);
            assert.equal(status, 400, `payload ${JSON.stringify(payload)} should be rejected`);
            assert.equal(body.code, "BAD_REQUEST");
            assert.equal(body.message, "Validation failed");
        }
        assert.equal(await conversationCount(userA.id), before, "no conversation may be created");
    });

    it("15: a client cannot smuggle userId to act as another user", async () => {
        const before = await conversationCount(userB.id);
        const { status, body } = await post(
            "/chat/new", { query: "hello", userId: userB.id }, userA.token);

        // The strict schema rejects unknown keys outright rather than ignoring them.
        assert.equal(status, 400);
        assert.equal(body.message, "Validation failed");
        assert.equal(await conversationCount(userB.id), before, "B gained a conversation");
    });

    it("401 takes precedence over 400 for an anonymous caller with a bad body", async () => {
        const { status } = await post("/chat/new", {}, undefined);
        assert.equal(status, 401);
    });
});

describe("POST /api/v1/chat/:conversationId", () => {
    it("unauthenticated is rejected before ownership is considered", async () => {
        const { status } = await post(`/chat/${convA}`, { query: "hello" });
        assert.equal(status, 401);
    });

    it("19/20: a foreign conversation is a 404 identical to a nonexistent one", async () => {
        const foreign = await post(`/chat/${convA}`, { query: "intrusion" }, userB.token);
        const missing = await post(`/chat/${randomUUID()}`, { query: "q" }, userB.token);

        assert.equal(foreign.status, 404);
        assert.deepEqual(foreign.body, missing.body, "responses must be indistinguishable");
        assert.ok(!JSON.stringify(foreign.body).includes("A's conversation"));

        // 21 — and nothing was written into A's conversation.
        const { rows } = await query<{ n: number }>(
            `SELECT COUNT(*)::int n FROM messages WHERE conversation_id = $1`, [convA]);
        assert.equal(rows[0]!.n, 0);
    });

    it("18: conversationId in the body is rejected, never used", async () => {
        const { status, body } = await post(
            `/chat/${convA}`, { query: "q", conversationId: randomUUID() }, userA.token);
        assert.equal(status, 400);
        assert.equal(body.message, "Validation failed");
    });

    it("17: a malformed conversationId is a 400 naming that param", async () => {
        const { status, body } = await post("/chat/not-a-uuid", { query: "q" }, userA.token);
        assert.equal(status, 400);
        assert.deepEqual(body.errors, [
            { field: "conversationId", message: "conversationId must be a valid conversation id" },
        ]);
    });

    it("an invalid query is rejected on the continue route too", async () => {
        const { status } = await post(`/chat/${convA}`, { query: "  " }, userA.token);
        assert.equal(status, 400);
    });
});

describe("SSE contract", () => {
    it("pre-stream failures are still real HTTP statuses, not events", async () => {
        // Auth, validation and ownership all resolve before the stream opens, so they keep
        // JSON error responses rather than degrading into 200 + an error event.
        for (const [path, body, token, status] of [
            ["/chat/new", { query: "hi" }, undefined, 401],
            ["/chat/new", {}, userA.token, 400],
            [`/chat/${convA}`, { query: "hi" }, userB.token, 404],
            ["/chat/not-a-uuid", { query: "hi" }, userA.token, 400],
        ] as [string, unknown, string | undefined, number][]) {
            const response = await fetch(`${baseUrl}${path}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, status, `${path} expected ${status}`);
            assert.match(
                response.headers.get("content-type") ?? "", /application\/json/,
                "a pre-stream failure must not be an event stream",
            );
        }
    });
});

describe("routing", () => {
    it('"/new" is matched before "/:conversationId"', async () => {
        // The two routes fail differently on a bad body, which is what proves which one matched:
        // /new validates only the body, so the error names `query`; /:conversationId validates
        // the param first, so "new" would be reported as an invalid conversationId.
        const { status, body } = await post("/chat/new", {}, userA.token);
        assert.equal(status, 400);
        const fields = (body.errors as Json[]).map((e) => e.field);
        assert.ok(fields.includes("query"), `expected a query error, got ${JSON.stringify(fields)}`);
        assert.ok(
            !fields.includes("conversationId"),
            '"new" was captured as a conversationId — route order is wrong',
        );
    });

    it("the retired prototype endpoint is gone", async () => {
        const { status } = await post("/chat/NexusAI-ask", { query: "hello" }, userA.token);
        // Reaches /:conversationId, which rejects it as a malformed id — there is no legacy route.
        assert.equal(status, 400);
    });

    it("GET is not routed on either chat endpoint", async () => {
        for (const path of ["/chat/new", `/chat/${convA}`]) {
            const response = await fetch(`${baseUrl}${path}`, {
                headers: { authorization: `Bearer ${userA.token}` },
            });
            assert.equal(response.status, 404, `GET ${path} should not be routed`);
        }
    });
});

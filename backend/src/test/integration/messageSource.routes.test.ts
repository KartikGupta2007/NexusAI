/**
 * GET /api/v1/messages/:messageId/sources — over real HTTP against the real app.
 *
 * Boots the Express app on an ephemeral port and calls it with fetch, so requireAuth,
 * validateParams, the controller, and the error middleware are all exercised as wired.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import app from "../../app.ts";
import { closePool } from "../../db/pool.ts";
import { attachMessageSources } from "../../services/messageSource.services.ts";
import { signAccessToken } from "../../services/token.services.ts";
import {
    addProbeMessage,
    cleanupProbes,
    createProbeConversation,
    createProbeUser,
} from "../helpers/probe.ts";

type Json = Record<string, any>;

let baseUrl = "";
let server: ReturnType<typeof app.listen>;

const userA = { id: "", email: "", token: "" };
const userB = { id: "", email: "", token: "" };
let messageA = "";
let userRoleMessageA = "";

const get = async (path: string, token?: string): Promise<{ status: number; body: Json }> => {
    const response = await fetch(`${baseUrl}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: (await response.json()) as Json };
};

const emailOf = async (id: string) => {
    const { query } = await import("../../db/pool.ts");
    return (await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [id])).rows[0]!.email;
};

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

    const conversationA = await createProbeConversation(userA.id);
    messageA = await addProbeMessage(conversationA, "assistant", "Here is what I found.");
    userRoleMessageA = await addProbeMessage(conversationA, "user", "what is nvidia?");

    // Attached out of order on purpose — the endpoint must sort by position.
    await attachMessageSources(userA.id, messageA, [
        { position: 3, url: "https://www.britannica.com/money/Nvidia", title: "Britannica" },
        { position: 1, url: "https://www.nvidia.com/", title: "NVIDIA", content: "GPU maker.", favicon: "https://www.nvidia.com/favicon.ico" },
        { position: 2, url: "https://en.wikipedia.org/wiki/Nvidia", title: "NVIDIA History" },
    ]);
});

after(async () => {
    await cleanupProbes();
    await new Promise((resolve) => server.close(resolve));
    await closePool();
});

describe("GET /api/v1/messages/:messageId/sources", () => {
    it("23/26: the owner receives their sources ordered by position", async () => {
        const { status, body } = await get(`/messages/${messageA}/sources`, userA.token);

        assert.equal(status, 200);
        assert.equal(body.success, true);
        assert.equal(body.message, "Message sources fetched successfully");

        const sources = body.data.sources as Json[];
        assert.equal(sources.length, 3);
        assert.deepEqual(sources.map((s) => s.position), [1, 2, 3]);
        assert.deepEqual(sources.map((s) => s.title), ["NVIDIA", "NVIDIA History", "Britannica"]);
    });

    it("21: the payload carries exactly what the frontend needs, in camelCase", async () => {
        const { body } = await get(`/messages/${messageA}/sources`, userA.token);
        const [first, second] = body.data.sources as Json[];

        assert.deepEqual(Object.keys(first!).sort(),
            ["content", "createdAt", "favicon", "id", "position", "title", "url"]);
        assert.equal(first!.url, "https://www.nvidia.com/");
        assert.equal(first!.content, "GPU maker.");
        assert.match(first!.favicon, /favicon\.ico$/);
        assert.equal(typeof first!.createdAt, "string", "timestamps serialise as ISO strings");
        assert.equal(second!.content, null, "missing snippet is null, not absent");

        const raw = JSON.stringify(body);
        for (const internal of ["message_id", "created_at", "user_id"]) {
            assert.ok(!raw.includes(internal), `${internal} leaked into the response`);
        }
    });

    it("a message with no sources returns an empty array, not a 404", async () => {
        const { status, body } = await get(`/messages/${userRoleMessageA}/sources`, userA.token);
        assert.equal(status, 200);
        assert.deepEqual(body.data.sources, []);
    });

    it("24: an unauthenticated request is rejected", async () => {
        const { status, body } = await get(`/messages/${messageA}/sources`);
        assert.equal(status, 401);
        assert.equal(body.success, false);
        assert.ok(!JSON.stringify(body).includes("nvidia.com"));
    });

    it("24b: an invalid token is rejected", async () => {
        const { status } = await get(`/messages/${messageA}/sources`, "not-a-real-token");
        assert.equal(status, 401);
    });

    it("25: user B cannot read A's sources, and cannot tell them from nonexistent", async () => {
        const foreign = await get(`/messages/${messageA}/sources`, userB.token);
        const missing = await get(`/messages/999999999999/sources`, userB.token);

        assert.equal(foreign.status, 404);
        assert.deepEqual(foreign.body, missing.body, "responses must be indistinguishable");

        const raw = JSON.stringify(foreign.body);
        for (const secret of ["nvidia.com", "NVIDIA", "Britannica", "GPU maker"]) {
            assert.ok(!raw.includes(secret), `${secret} leaked to user B`);
        }
    });

    it("a malformed messageId is a 400, not a 500", async () => {
        for (const bad of ["not-a-number", "1.5", "-1", "0", "abc123"]) {
            const { status, body } = await get(`/messages/${bad}/sources`, userA.token);
            assert.equal(status, 400, `"${bad}" should be a validation error`);
            assert.equal(body.code, "BAD_REQUEST");
            assert.equal(body.message, "Validation failed");
        }
    });

    it("401 takes precedence over 400 for an anonymous caller with a malformed id", async () => {
        const { status } = await get("/messages/not-a-number/sources");
        assert.equal(status, 401);
    });

    it("no write endpoints are exposed for sources", async () => {
        // Sources are backend-generated; a client must not be able to rewrite the citations
        // under an assistant answer. Only GET is routed.
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
            const response = await fetch(`${baseUrl}/messages/${messageA}/sources`, {
                method,
                headers: { authorization: `Bearer ${userA.token}`, "content-type": "application/json" },
                body: method === "DELETE" ? undefined : JSON.stringify({ sources: [] }),
            });
            assert.equal(response.status, 404, `${method} should not be routed`);
        }
        // And A's sources are still intact.
        const { body } = await get(`/messages/${messageA}/sources`, userA.token);
        assert.equal((body.data.sources as Json[]).length, 3);
    });
});

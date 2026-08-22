/**
 * The chat pipeline end to end against the real database, with the two providers stubbed
 * through `ChatDeps`. **No test here reaches Tavily or Anthropic.**
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { closePool, query } from "../../db/pool.ts";
import { findMessagesForUserConversation } from "../../repositories/conversation.repository.ts";
import { countMemoriesForUser } from "../../repositories/vectorMemory.repository.ts";
import {
    processChatMessage,
    startNewChat,
    conversationTitleFromQuery,
    type ChatDeps,
} from "../../services/chat.services.ts";
import { getConversationSummary } from "../../services/conversationSummary.services.ts";
import { getMessageSources } from "../../services/messageSource.services.ts";
import { ApiError } from "../../utils/ApiError.ts";
import { failingAnswer, streamingAnswer } from "../helpers/stubs.ts";
import {
    cleanupProbes,
    createProbeConversation,
    createProbeUser,
    expectApiError,
} from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

const WEB = {
    results: [
        { title: "NVIDIA Official", url: "https://www.nvidia.com/", content: "GPU maker.", favicon: "https://www.nvidia.com/favicon.ico", score: 1, publishedDate: "", id: "1" },
        { title: "NVIDIA History", url: "https://en.wikipedia.org/wiki/Nvidia", content: "Founded 1993.", score: 1, publishedDate: "", id: "2" },
        { title: "Britannica", url: "https://www.britannica.com/money/Nvidia", content: "Overview.", score: 1, publishedDate: "", id: "3" },
    ],
};

/** Records the order steps ran in, so execution order can be asserted. */
const makeDeps = (over: Partial<ChatDeps> = {}) => {
    const calls: string[] = [];
    const deps: ChatDeps = {
        search: async (q) => { calls.push(`search:${q}`); return WEB; },
        answer: streamingAnswer(
            { answer: "NVIDIA designs GPUs.", citations: ["source_1", "source_3"], title: "Nvidia GPU overview" },
            { onCall: () => calls.push("answer") },
        ),
        summary: async () => { calls.push("summary"); return "The user asked about NVIDIA."; },
        extract: async () => { calls.push("extract"); return { memories: ["The user is researching GPUs."] }; },
        ...over,
    };
    return { deps, calls };
};

describe("startNewChat", () => {
    it("1-12: creates the conversation, runs the pipeline, returns the turn", async () => {
        const userId = await createProbeUser();
        const { deps, calls } = makeDeps();

        const turn = await startNewChat({ userId, query: "Tell me about Nvidia" }, deps);
        await turn.postAnswer;

        // 10/11/12 — response payload
        assert.match(turn.conversationId, /^[0-9a-f-]{36}$/);
        assert.equal(turn.answer, "NVIDIA designs GPUs.");
        assert.equal(turn.sources.length, 2);

        // 2/3 — conversation exists and belongs to the caller
        const { rows } = await query<{ user_id: string; title: string }>(
            `SELECT user_id, title FROM conversations WHERE id = $1`, [turn.conversationId]);
        assert.equal(rows[0]!.user_id, userId);
        // Claude proposed a title, so it replaced the deterministic fallback.
        assert.equal(rows[0]!.title, "Nvidia GPU overview");
        assert.equal(turn.title, "Nvidia GPU overview");
        assert.equal(turn.suggestedTitle, "Nvidia GPU overview");

        // 4/6 — both messages, in order, with the right roles
        const messages = await findMessagesForUserConversation(turn.conversationId, userId);
        assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
        assert.equal(messages[0]!.content, "Tell me about Nvidia");
        assert.equal(messages[1]!.content, "NVIDIA designs GPUs.");

        // 7 — sources attached to the assistant message, in citation order
        const stored = await getMessageSources(userId, messages[1]!.id);
        assert.deepEqual(stored.map((s) => s.url),
            ["https://www.nvidia.com/", "https://www.britannica.com/money/Nvidia"]);
        assert.deepEqual(stored.map((s) => s.position), [1, 2]);

        // 8 — summary updated
        const summary = await getConversationSummary(userId, turn.conversationId);
        assert.equal(summary?.summary, "The user asked about NVIDIA.");

        // 9 — memories extracted and stored
        assert.equal(await countMemoriesForUser(userId), 1);

        // 5 — the whole pipeline ran, in order
        assert.deepEqual(calls, ["search:Tell me about Nvidia", "answer", "summary", "extract"]);
    });

    it("falls back to the deterministic title when Claude proposes none", async () => {
        const userId = await createProbeUser();
        const { deps } = makeDeps({
            answer: streamingAnswer({ answer: "a", citations: [] }), // no title field
        });

        const turn = await startNewChat({ userId, query: "Tell me about Nvidia" }, deps);
        await turn.postAnswer;

        assert.equal(turn.suggestedTitle, null);
        assert.equal(turn.title, "Tell me about Nvidia");
        const { rows } = await query<{ title: string }>(
            `SELECT title FROM conversations WHERE id = $1`, [turn.conversationId]);
        assert.equal(rows[0]!.title, "Tell me about Nvidia");
    });

    it("streams the answer while starting a new chat", async () => {
        const userId = await createProbeUser();
        const { deps } = makeDeps();
        const deltas: string[] = [];
        let startedWith = "";

        const turn = await startNewChat({ userId, query: "Tell me about Nvidia" }, deps, {
            onToken: (text) => deltas.push(text),
            onConversationCreated: (id) => { startedWith = id; },
        });
        await turn.postAnswer;

        assert.equal(startedWith, turn.conversationId, "the id must be emitted before the answer");
        assert.ok(deltas.length > 1, "answer should arrive in multiple deltas");
        assert.equal(deltas.join(""), "NVIDIA designs GPUs.");
    });

    it("titles are deterministic and bounded", () => {
        assert.equal(conversationTitleFromQuery("  Tell me   about Nvidia  "), "Tell me about Nvidia");
        const long = conversationTitleFromQuery("x".repeat(300));
        assert.ok(long.length <= 80 && long.endsWith("…"));
    });
});

describe("processChatMessage", () => {
    it("16-27: continues an existing conversation without creating one", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId, "existing");
        const before = (await query<{ n: number }>(
            `SELECT COUNT(*)::int n FROM conversations WHERE user_id = $1`, [userId])).rows[0]!.n;

        const { deps, calls } = makeDeps();
        const turn = await processChatMessage({ userId, conversationId, query: "What about AI GPUs?" }, deps);
        await turn.postAnswer;

        assert.equal(turn.conversationId, conversationId);
        assert.equal(turn.answer, "NVIDIA designs GPUs.");

        // 21 — no new conversation
        const after = (await query<{ n: number }>(
            `SELECT COUNT(*)::int n FROM conversations WHERE user_id = $1`, [userId])).rows[0]!.n;
        assert.equal(after, before, "continuing must not create a conversation");

        // 22/23 — messages landed in the right conversation
        const messages = await findMessagesForUserConversation(conversationId, userId);
        assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);

        // 24/25/26
        assert.equal((await getMessageSources(userId, messages[1]!.id)).length, 2);
        assert.ok(await getConversationSummary(userId, conversationId));
        assert.equal(await countMemoriesForUser(userId), 1);
        assert.deepEqual(calls, ["search:What about AI GPUs?", "answer", "summary", "extract"]);
    });

    it("continuing a conversation NEVER changes its title", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId, "Original title");
        const titleOf = async () => (await query<{ title: string }>(
            `SELECT title FROM conversations WHERE id = $1`, [conversationId])).rows[0]!.title;

        // Claude proposes a title on every turn; the continue path must ignore it.
        for (const q of ["first follow-up", "second follow-up"]) {
            const turn = await processChatMessage({ userId, conversationId, query: q }, makeDeps().deps);
            await turn.postAnswer;
            assert.equal(turn.suggestedTitle, "Nvidia GPU overview", "the model did propose one");
            assert.equal(turn.title, null, "continuing must report no title change");
            assert.equal(await titleOf(), "Original title", "the title was overwritten");
        }
    });

    it("streams the answer while continuing a conversation", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const deltas: string[] = [];

        const turn = await processChatMessage(
            { userId, conversationId, query: "q" }, makeDeps().deps,
            { onToken: (text) => deltas.push(text) },
        );
        await turn.postAnswer;

        assert.ok(deltas.length > 1);
        assert.equal(deltas.join(""), turn.answer);
    });

    it("28-31: the prompt carries retrieval context and web results", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);

        let seenPrompt = "";
        const { deps } = makeDeps({
            answer: streamingAnswer(
                { answer: "ok", citations: [] },
                { onCall: ({ prompt }) => { seenPrompt = prompt; } },
            ),
        });

        // Give the conversation a summary and the user a memory so both should surface.
        await processChatMessage({ userId, conversationId, query: "first question" }, makeDeps().deps)
            .then((t) => t.postAnswer);
        const second = await processChatMessage({ userId, conversationId, query: "second question" }, deps);
        await second.postAnswer;

        assert.ok(seenPrompt.includes("<user_question>"), "prompt builder ran");
        assert.ok(seenPrompt.includes("second question"));
        assert.ok(seenPrompt.includes("<recent_messages>"), "retrieval context reached the prompt");
        assert.ok(seenPrompt.includes("first question"), "earlier turn is in context");
        assert.ok(seenPrompt.includes("<web_results>") && seenPrompt.includes("source_1"), "Tavily reached the prompt");
        assert.ok(seenPrompt.includes("<conversation_summary>"), "summary reached the prompt");
    });

    it("32/33: only offered citation ids become sources", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const { deps } = makeDeps({
            answer: streamingAnswer({
                answer: "a",
                citations: ["source_2", "source_99", "https://hallucinated.example/", "source_2"],
            }),
        });

        const turn = await processChatMessage({ userId, conversationId, query: "q" }, deps);
        await turn.postAnswer;
        assert.equal(turn.sources.length, 1, "unknown and duplicate ids must not create sources");
        assert.equal(turn.sources[0]!.url, "https://en.wikipedia.org/wiki/Nvidia");
        assert.ok(!JSON.stringify(turn.sources).includes("hallucinated"));
    });

    it("no citations means no sources", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const { deps } = makeDeps({ answer: streamingAnswer({ answer: "a", citations: [] }) });
        const turn = await processChatMessage({ userId, conversationId, query: "q" }, deps);
        await turn.postAnswer;
        assert.deepEqual(turn.sources, []);
    });

    it("34/35: summary and memory work run only after the assistant message exists", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);

        const order: string[] = [];
        const { deps } = makeDeps({
            summary: async () => {
                const messages = await findMessagesForUserConversation(conversationId, userId);
                order.push(`summary-sees-${messages.map((m) => m.role).join("+")}`);
                return "s";
            },
            extract: async () => {
                const messages = await findMessagesForUserConversation(conversationId, userId);
                order.push(`extract-sees-${messages.map((m) => m.role).join("+")}`);
                return { memories: [] };
            },
        });

        const turn = await processChatMessage({ userId, conversationId, query: "q" }, deps);
        await turn.postAnswer;
        assert.deepEqual(order, ["summary-sees-user+assistant", "extract-sees-user+assistant"]);
    });

    it("36/37: a summary or memory failure does not destroy the answer", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const { deps } = makeDeps({
            summary: async () => { throw new Error("summary provider down"); },
            extract: async () => { throw new Error("extraction provider down"); },
        });

        const turn = await processChatMessage({ userId, conversationId, query: "q" }, deps);
        await assert.doesNotReject(turn.postAnswer, "post-answer work must never reject");

        assert.equal(turn.answer, "NVIDIA designs GPUs.");
        assert.equal(turn.sources.length, 2);
        const messages = await findMessagesForUserConversation(conversationId, userId);
        assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
        // Nothing fabricated on failure.
        assert.equal(await getConversationSummary(userId, conversationId), null);
        assert.equal(await countMemoriesForUser(userId), 0);
    });

    it("38: a Claude failure leaves no assistant message and no sources", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const { deps } = makeDeps({ answer: failingAnswer(new Error("model exploded")) });

        await expectApiError(processChatMessage({ userId, conversationId, query: "q" }, deps), 502);

        const messages = await findMessagesForUserConversation(conversationId, userId);
        assert.deepEqual(messages.map((m) => m.role), ["user"], "the user's question stays, no assistant turn");
        assert.equal(
            (await query<{ n: number }>(
                `SELECT COUNT(*)::int n FROM message_sources ms
                   JOIN messages m ON m.id = ms.message_id
                  WHERE m.conversation_id = $1`, [conversationId])).rows[0]!.n,
            0);
        assert.equal(await getConversationSummary(userId, conversationId), null);
    });

    it("a search failure aborts before any assistant message", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const { deps } = makeDeps({ search: async () => { throw new Error("429 rate limit"); } });

        await expectApiError(processChatMessage({ userId, conversationId, query: "q" }, deps), 429);
        assert.deepEqual(
            (await findMessagesForUserConversation(conversationId, userId)).map((m) => m.role), ["user"]);
    });

    it("39: user B cannot post into user A's conversation", async () => {
        const a = await createProbeUser();
        const b = await createProbeUser();
        const conversationId = await createProbeConversation(a);
        const { deps, calls } = makeDeps();

        const denied = await expectApiError(
            processChatMessage({ userId: b, conversationId, query: "intrusion" }, deps), 404);
        const missing = await expectApiError(
            processChatMessage({ userId: b, conversationId: randomUUID(), query: "q" }, deps), 404);
        assert.equal(denied.message, missing.message);
        assert.equal(denied.code, missing.code);

        // Nothing was written and no provider was called.
        assert.deepEqual(await findMessagesForUserConversation(conversationId, a), []);
        assert.deepEqual(calls, [], "a foreign conversation must not reach the providers");
    });

    it("40/41: raw provider output and internal prompt never reach the result", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const { deps } = makeDeps();
        const turn = await processChatMessage({ userId, conversationId, query: "q" }, deps);
        await turn.postAnswer;

        const wire = JSON.stringify({
            conversationId: turn.conversationId, answer: turn.answer, sources: turn.sources,
        });
        for (const internal of ["score", "publishedDate", "rawContent", "_prompt", "<web_results>",
            "<user_question>", "source_1", "You are NexusAI"]) {
            assert.ok(!wire.includes(internal), `${internal} leaked into the response`);
        }
        // Sources are the public DTO shape.
        assert.deepEqual(Object.keys(turn.sources[0]!).sort(),
            ["content", "createdAt", "favicon", "id", "position", "title", "url"]);
    });

    it("an invalid query is rejected before anything is written", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const { deps, calls } = makeDeps();

        for (const q of ["", "   ", "x".repeat(2001), null as unknown as string]) {
            await expectApiError(processChatMessage({ userId, conversationId, query: q }, deps), 400);
        }
        assert.deepEqual(await findMessagesForUserConversation(conversationId, userId), []);
        assert.deepEqual(calls, []);
    });

    it("the search query is clipped to Tavily's limit while Claude sees the whole question", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const longQuery = `${"word ".repeat(300)}end`.trim();

        let searchedWith = "";
        let promptSeen = "";
        const { deps } = makeDeps({
            search: async (q) => { searchedWith = q; return WEB; },
            answer: streamingAnswer(
                { answer: "a", citations: [] },
                { onCall: ({ prompt }) => { promptSeen = prompt; } },
            ),
        });

        const turn = await processChatMessage({ userId, conversationId, query: longQuery }, deps);
        await turn.postAnswer;

        // searchWeb trims its own input, so a slice landing on a space is 399 rather than 400.
        assert.equal(searchedWith, longQuery.slice(0, 400).trim());
        assert.ok(searchedWith.length <= 400, `search input was ${searchedWith.length} chars`);
        assert.ok(longQuery.length > 400, "premise: the question exceeds Tavily's limit");
        assert.ok(promptSeen.includes("word word"), "Claude still received the question");
    });

    it("the conversation's updated_at advances so the sidebar reorders", async () => {
        const userId = await createProbeUser();
        const conversationId = await createProbeConversation(userId);
        const at = async () => (await query<{ updated_at: Date }>(
            `SELECT updated_at FROM conversations WHERE id = $1`, [conversationId])).rows[0]!.updated_at;

        const before = await at();
        const turn = await processChatMessage({ userId, conversationId, query: "q" }, makeDeps().deps);
        await turn.postAnswer;
        assert.ok(+(await at()) > +before, "updated_at should move on a new turn");
    });
});

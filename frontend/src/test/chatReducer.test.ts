import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState, toChatMessages } from "../state/chatReducer.ts";
import type { ChatAction, ChatState } from "../state/chatReducer.ts";
import { makeSource } from "./helpers/fakeBackend.ts";

/**
 * The streaming contract, tested without a renderer.
 *
 * Every rule that matters — one assistant message per turn, sources attach to it, a continuation
 * never renames the thread, a stop keeps what streamed — is a property of this reducer, so it can
 * be pinned down here rather than inferred from the DOM.
 */

const apply = (state: ChatState, ...actions: ChatAction[]): ChatState =>
    actions.reduce(chatReducer, state);

/** A thread mid-answer: the user's question plus one streaming assistant message. */
const streaming = (query = "Tell me about Nvidia"): ChatState =>
    apply(initialChatState, { type: "submit", userKey: "u1", assistantKey: "a1", query });

describe("submit", () => {
    it("adds the user message and exactly one assistant message to stream into", () => {
        const state = streaming();

        expect(state.messages).toHaveLength(2);
        expect(state.messages[0]).toMatchObject({ role: "user", content: "Tell me about Nvidia" });
        expect(state.messages[1]).toMatchObject({ role: "assistant", content: "", status: "streaming" });
        expect(state.isStreaming).toBe(true);
    });
});

describe("token", () => {
    it("concatenates many tokens into one assistant message", () => {
        const state = apply(
            streaming(),
            { type: "token", text: "NVIDIA " },
            { type: "token", text: "is " },
            { type: "token", text: "a " },
            { type: "token", text: "technology " },
            { type: "token", text: "company." },
        );

        // The count is the assertion that matters: a token must never create a message.
        expect(state.messages).toHaveLength(2);
        expect(state.messages[1]!.content).toBe("NVIDIA is a technology company.");
    });

    it("treats an empty token as a no-op and returns the identical state object", () => {
        const before = apply(streaming(), { type: "token", text: "NVIDIA" });
        const after = chatReducer(before, { type: "token", text: "" });

        // Referential equality, so an empty frame cannot even cause a re-render.
        expect(after).toBe(before);
    });

    it("ignores tokens once no message is streaming", () => {
        const finished = apply(
            streaming(),
            { type: "token", text: "done" },
            { type: "done", conversationId: "c1", title: "T" },
        );

        expect(chatReducer(finished, { type: "token", text: " extra" })).toBe(finished);
    });
});

describe("sources", () => {
    it("attaches the sources to the streaming assistant message", () => {
        const sources = [makeSource({ id: "s1", position: 1 }), makeSource({ id: "s2", position: 2 })];
        const state = apply(streaming(), { type: "token", text: "text" }, { type: "sources", sources });

        expect(state.messages[1]!.sources).toEqual(sources);
        expect(state.messages[0]!.sources).toEqual([]);
    });

    it("accepts sources that arrive after the tokens", () => {
        const sources = [makeSource()];
        const state = apply(
            streaming(),
            { type: "token", text: "answer" },
            { type: "sources", sources },
            { type: "done", conversationId: "c1", title: null },
        );

        expect(state.messages[1]).toMatchObject({ content: "answer", sources, status: "complete" });
    });
});

describe("done", () => {
    it("records the title of a new conversation and ends the stream", () => {
        const state = apply(
            streaming(),
            { type: "start", conversationId: "c1" },
            { type: "token", text: "answer" },
            { type: "done", conversationId: "c1", title: "Nvidia GPU overview" },
        );

        expect(state).toMatchObject({
            conversationId: "c1",
            title: "Nvidia GPU overview",
            isStreaming: false,
        });
        expect(state.messages[1]!.status).toBe("complete");
    });

    it("keeps the existing title when a continuation reports none", () => {
        const opened: ChatState = {
            conversationId: "c1",
            title: "Nvidia GPU overview",
            messages: [],
            isStreaming: false,
        };

        const state = apply(
            opened,
            { type: "submit", userKey: "u2", assistantKey: "a2", query: "What about their AI GPUs?" },
            { type: "token", text: "The H100…" },
            // A continuation sends title: null — it must not blank the sidebar entry.
            { type: "done", conversationId: "c1", title: null },
        );

        expect(state.title).toBe("Nvidia GPU overview");
    });
});

describe("start", () => {
    it("records the backend's conversation id before the answer finishes", () => {
        const state = apply(streaming(), { type: "start", conversationId: "conv-42" });

        expect(state.conversationId).toBe("conv-42");
        expect(state.isStreaming).toBe(true);
        expect(state.messages[1]!.status).toBe("streaming");
    });
});

describe("failed", () => {
    it("keeps the user's message and marks the assistant placeholder", () => {
        const state = apply(streaming(), { type: "failed", message: "Too many requests right now." });

        expect(state.messages[0]).toMatchObject({ role: "user", content: "Tell me about Nvidia" });
        expect(state.messages[1]).toMatchObject({
            role: "assistant",
            status: "failed",
            error: "Too many requests right now.",
        });
        expect(state.isStreaming).toBe(false);
    });
});

describe("stopped", () => {
    it("preserves the partial answer that streamed before the stop", () => {
        const state = apply(
            streaming(),
            { type: "token", text: "NVIDIA is a " },
            { type: "stopped" },
        );

        expect(state.messages[1]).toMatchObject({ content: "NVIDIA is a ", status: "stopped" });
        expect(state.isStreaming).toBe(false);
    });

    it("marks a stop before any token as a failure rather than an empty answer", () => {
        const state = apply(streaming(), { type: "stopped" });

        expect(state.messages[1]!.status).toBe("failed");
    });
});

describe("retryRemoved", () => {
    it("drops a failed placeholder so a retry does not stack them", () => {
        const state = apply(
            streaming(),
            { type: "failed", message: "nope" },
            { type: "retryRemoved" },
        );

        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]!.role).toBe("user");
    });

    it("leaves a completed thread untouched", () => {
        const finished = apply(
            streaming(),
            { type: "token", text: "answer" },
            { type: "done", conversationId: "c1", title: null },
        );

        expect(chatReducer(finished, { type: "retryRemoved" })).toBe(finished);
    });
});

describe("toChatMessages", () => {
    it("maps persisted rows and drops system prompt scaffolding", () => {
        const messages = toChatMessages(
            [
                { id: "1", role: "system", content: "scaffolding", createdAt: "" },
                { id: "2", role: "user", content: "Tell me about Nvidia", createdAt: "" },
                { id: "3", role: "assistant", content: "NVIDIA is…", createdAt: "" },
            ],
            { "3": [makeSource({ id: "s9" })] },
        );

        expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(messages[1]!.sources).toHaveLength(1);
        expect(messages.every((message) => message.status === "complete")).toBe(true);
    });
});

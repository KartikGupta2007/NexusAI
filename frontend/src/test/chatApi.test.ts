import { afterEach, describe, expect, it } from "vitest";
import { streamExistingChat, streamNewChat } from "../api/chat.ts";
import { request } from "../api/client.ts";
import { ApiError, describeError } from "../api/errors.ts";
import type { ChatStreamEvent } from "../types/api.ts";
import { installFakeBackend, makeSource } from "./helpers/fakeBackend.ts";
import type { FakeBackend } from "./helpers/fakeBackend.ts";

/**
 * The API layer in isolation: which endpoint each flow posts to, what it sends, and how a failure
 * before the stream opens differs from one reported inside it.
 */

let backend: FakeBackend;

afterEach(() => backend?.restore());

/** Consumes a stream into an array, driving the fake backend alongside it. */
const drain = async (
    events: AsyncGenerator<ChatStreamEvent>,
    script: (handle: Awaited<ReturnType<FakeBackend["awaitChat"]>>) => void,
): Promise<ChatStreamEvent[]> => {
    const pending = backend.awaitChat().then(script);
    const collected: ChatStreamEvent[] = [];
    for await (const event of events) collected.push(event);
    await pending;
    return collected;
};

describe("endpoint selection", () => {
    it("posts a new chat to /chat/new and sends only the query", async () => {
        backend = installFakeBackend();

        await drain(streamNewChat("Tell me about Nvidia"), (chat) => chat.close());

        const [call] = backend.chatCalls();
        expect(call).toMatchObject({ method: "POST", path: "/api/v1/chat/new" });
        // Ownership, identity and credits are the backend's to decide — never sent from here.
        expect(call!.body).toEqual({ query: "Tell me about Nvidia" });
        expect(call!.credentials).toBe("include");
    });

    it("posts a continuation to /chat/:conversationId with the id in the path", async () => {
        backend = installFakeBackend();

        await drain(streamExistingChat("conv-7", "What about their AI GPUs?"), (chat) => chat.close());

        const [call] = backend.chatCalls();
        expect(call!.path).toBe("/api/v1/chat/conv-7");
        expect(call!.body).toEqual({ query: "What about their AI GPUs?" });
        // The id belongs in the URL only; repeating it in the body is explicitly forbidden.
        expect(call!.body).not.toHaveProperty("conversationId");
    });

    it("encodes a conversation id that would otherwise change the path", async () => {
        backend = installFakeBackend();

        await drain(streamExistingChat("a/../b", "hi"), (chat) => chat.close());

        expect(backend.chatCalls()[0]!.path).toBe("/api/v1/chat/a%2F..%2Fb");
    });

    it("refuses to continue without a conversation id", () => {
        backend = installFakeBackend();

        expect(() => streamExistingChat("", "hi")).toThrow(ApiError);
    });
});

describe("typed events", () => {
    it("yields start, token, sources and done in the order they were written", async () => {
        backend = installFakeBackend();
        const sources = [makeSource({ id: "s1", position: 1 })];

        const events = await drain(streamNewChat("Tell me about Nvidia"), (chat) => {
            chat.start("conv-1");
            chat.token("NVIDIA ");
            chat.token("is ");
            chat.sources(sources);
            chat.done({ conversationId: "conv-1", title: "Nvidia GPU overview", creditsRemaining: 480 });
            chat.close();
        });

        expect(events).toEqual([
            { type: "start", conversationId: "conv-1" },
            { type: "token", text: "NVIDIA " },
            { type: "token", text: "is " },
            { type: "sources", sources },
            {
                type: "done",
                conversationId: "conv-1",
                title: "Nvidia GPU overview",
                creditsRemaining: 480,
            },
        ]);
    });

    it("reads title as null when a continuation omits it", async () => {
        backend = installFakeBackend();

        const events = await drain(streamExistingChat("conv-1", "more"), (chat) => {
            chat.raw('event: done\ndata: {"conversationId":"conv-1","creditsRemaining":460}\n\n');
            chat.close();
        });

        expect(events).toEqual([
            { type: "done", conversationId: "conv-1", title: null, creditsRemaining: 460 },
        ]);
    });

    it("surfaces an in-band error event", async () => {
        backend = installFakeBackend();

        const events = await drain(streamNewChat("q"), (chat) => {
            chat.error({ code: "SEARCH_FAILED", message: "Web search failed" });
            chat.close();
        });

        expect(events).toEqual([
            { type: "error", code: "SEARCH_FAILED", message: "Web search failed" },
        ]);
    });

    it("drops frames whose payload does not match the protocol", async () => {
        backend = installFakeBackend();

        const events = await drain(streamNewChat("q"), (chat) => {
            chat.raw("event: token\ndata: not json\n\n");
            chat.raw('event: token\ndata: {"text":42}\n\n');
            chat.raw("event: mystery\ndata: {}\n\n");
            chat.token("real");
            chat.close();
        });

        expect(events).toEqual([{ type: "token", text: "real" }]);
    });
});

describe("session renewal", () => {
    /**
     * The access token is short-lived and the refresh cookie is not. Before this existed the
     * session simply ended at the access token's expiry — a reload signed the user out, and a
     * question typed after it came back "Your session expired".
     */
    it("renews the session on a 401 and replays the request", async () => {
        backend = installFakeBackend();
        backend.failNextChat({ status: 401, code: "MISSING_ACCESS_TOKEN", message: "Authentication required" });

        const events = await drain(streamNewChat("q"), (chat) => {
            chat.token("answered after renewal");
            chat.close();
        });

        expect(events).toEqual([{ type: "token", text: "answered after renewal" }]);
        expect(backend.refreshCalls()).toHaveLength(1);
        // The original attempt, then the replay — the user's question is not lost.
        expect(backend.chatCalls()).toHaveLength(2);
    });

    it("gives up when the refresh token is dead, without replaying", async () => {
        backend = installFakeBackend();
        backend.expireRefreshToken();
        backend.failNextChat({ status: 401, code: "MISSING_ACCESS_TOKEN", message: "Authentication required" });

        await expect(streamNewChat("q").next()).rejects.toMatchObject({ name: "ApiError", status: 401 });

        expect(backend.refreshCalls()).toHaveLength(1);
        // One attempt only: a renewal that failed means the session is genuinely over.
        expect(backend.chatCalls()).toHaveLength(1);
    });

    it("renews once for a burst of 401s, so rotation cannot race itself", async () => {
        backend = installFakeBackend({ user: null });

        // Two requests in flight together, both rejected. A second rotation would present a
        // token the first had just revoked, which the backend reads as replay.
        const first = request<unknown>("/user/me").catch(() => "failed");
        const second = request<unknown>("/user/me").catch(() => "failed");
        await Promise.all([first, second]);

        expect(backend.refreshCalls()).toHaveLength(1);
    });
});

describe("failures before the stream opens", () => {
    const expectApiError = async (status: number, code: string) => {
        backend = installFakeBackend();
        // A 401 only reaches the caller once renewal has failed too; anything else would be
        // retried behind its back. See "session renewal" above.
        backend.expireRefreshToken();
        backend.failNextChat({ status, code, message: "backend says no" });

        const events = streamNewChat("q");
        await expect(events.next()).rejects.toMatchObject({ name: "ApiError", status, code });
    };

    it("throws ApiError on 402 insufficient credits", async () => {
        await expectApiError(402, "INSUFFICIENT_CREDITS");
    });

    it("throws ApiError on 401 unauthenticated", async () => {
        await expectApiError(401, "MISSING_ACCESS_TOKEN");
    });

    it("throws ApiError on 404 unknown conversation", async () => {
        await expectApiError(404, "NOT_FOUND");
    });

    it("throws ApiError on 429 rate limiting", async () => {
        await expectApiError(429, "TOO_MANY_REQUESTS");
    });

    it("throws ApiError on 503 provider failure", async () => {
        await expectApiError(503, "SEARCH_NOT_CONFIGURED");
    });
});

describe("abort", () => {
    /** Opens a stream and pulls one token, leaving the generator suspended on a yield. */
    const openWithOneToken = async (controller: AbortController) => {
        backend = installFakeBackend();
        const events = streamNewChat("q", controller.signal);

        const chatReady = backend.awaitChat();
        // Pull the first event so the request has actually been issued.
        const first = events.next();
        (await chatReady).token("partial");
        expect((await first).value).toEqual({ type: "token", text: "partial" });

        return events;
    };

    // Abort has two arrival points, and the caller has to survive both. Which one happens is a
    // race between the user's click and the network, so neither is the "normal" case.

    it("ends the stream cleanly when aborted between frames", async () => {
        const controller = new AbortController();
        const events = await openWithOneToken(controller);

        // Suspended on a yield: resuming sees the flag and returns rather than reading again.
        controller.abort();

        expect(await events.next()).toEqual({ value: undefined, done: true });
    });

    it("rejects with an AbortError when aborted while awaiting the next frame", async () => {
        const controller = new AbortController();
        const events = await openWithOneToken(controller);

        // Already waiting on the socket: the aborted body errors the pending read.
        const pending = events.next();
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    });
});

describe("describeError", () => {
    it("gives insufficient credits a user-facing sentence with no backend detail", () => {
        const message = describeError(
            new ApiError(402, "INSUFFICIENT_CREDITS", "You do not have enough credits for this query."),
        );

        expect(message).toBe("You don't have enough credits to run this query.");
    });

    it("never leaks an unexpected server message", () => {
        expect(describeError(new ApiError(500, "INTERNAL_ERROR", "pg: relation does not exist"))).toBe(
            "The server had a problem. Please try again.",
        );
    });

    it("maps the remaining statuses the backend can return", () => {
        expect(describeError(new ApiError(401, "UNAUTHORIZED", "x"))).toMatch(/sign in again/i);
        expect(describeError(new ApiError(404, "NOT_FOUND", "x"))).toMatch(/no longer available/i);
        expect(describeError(new ApiError(429, "TOO_MANY_REQUESTS", "x"))).toMatch(/too many requests/i);
        expect(describeError(new DOMException("aborted", "AbortError"))).toBe("Stopped.");
    });
});

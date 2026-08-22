import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeBackend, makeSource } from "./helpers/fakeBackend.ts";
import type { ChatHandle, FakeBackend } from "./helpers/fakeBackend.ts";
import { renderApp } from "./helpers/renderApp.tsx";

/**
 * End-to-end through the real components, router and state, against a fake that speaks the
 * backend's actual wire format. These are the behaviours a user would notice breaking.
 */

let backend: FakeBackend;

afterEach(() => backend?.restore());

/** Emits frames inside act(), so React has flushed before the assertion runs. */
const emit = (write: (chat: ChatHandle) => void, chat: ChatHandle) =>
    act(async () => {
        write(chat);
        // Lets the reader loop pick the bytes up before act() settles.
        await Promise.resolve();
    });

const assistantTurns = () => document.querySelectorAll(".turn-assistant");
const userTurns = () => document.querySelectorAll(".turn-user");
const answerText = () => document.querySelector(".turn-assistant .markdown")?.textContent ?? "";

const NVIDIA_SOURCES = [
    makeSource({ id: "src-a", position: 1, url: "https://www.nvidia.com/en-us/", title: "NVIDIA" }),
    makeSource({
        id: "src-b",
        position: 2,
        url: "https://en.wikipedia.org/wiki/Nvidia",
        title: "Nvidia — Wikipedia",
        favicon: null,
    }),
];

describe("new chat flow", () => {
    it("posts to /chat/new, adopts the id from start, and keeps streaming into one message", async () => {
        backend = installFakeBackend();
        const app = renderApp("/");
        await app.ready();

        await app.ask("Tell me about Nvidia");
        const chat = await backend.awaitChat();

        // The endpoint is chosen from the route, with no user involvement.
        expect(chat.path).toBe("/api/v1/chat/new");
        // The user's message is on screen before a single byte comes back.
        expect(userTurns()).toHaveLength(1);
        expect(screen.getByText("Tell me about Nvidia")).toBeInTheDocument();

        await emit((c) => c.start("conv-1"), chat);

        // The URL moves as soon as the id is known — long before the answer finishes.
        await waitFor(() => expect(app.path()).toBe("/chat/conv-1"));

        // …and the stream that produced that id must survive the navigation.
        await emit((c) => c.token("NVIDIA "), chat);
        await emit((c) => c.token("is "), chat);
        await emit((c) => c.token("a "), chat);
        await emit((c) => c.token("technology company."), chat);

        await waitFor(() => expect(answerText()).toBe("NVIDIA is a technology company."));
        // Four tokens, still one assistant message.
        expect(assistantTurns()).toHaveLength(1);
    });

    it("renders sources as links to the real URLs and never shows internal ids", async () => {
        backend = installFakeBackend();
        const app = renderApp("/");
        await app.ready();

        await app.ask("Tell me about Nvidia");
        const chat = await backend.awaitChat();
        await emit((c) => c.start("conv-1"), chat);
        await emit((c) => c.token("NVIDIA designs GPUs."), chat);
        await emit((c) => c.sources(NVIDIA_SOURCES), chat);

        const sources = await screen.findByRole("region", { name: "Sources" });
        const links = within(sources).getAllByRole("link");

        expect(links).toHaveLength(2);
        expect(links[0]).toHaveAttribute("href", "https://www.nvidia.com/en-us/");
        expect(links[1]).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Nvidia");
        // Opening in a new tab must not hand over a window reference.
        expect(links[0]).toHaveAttribute("target", "_blank");
        expect(links[0]).toHaveAttribute("rel", expect.stringContaining("noopener"));
        // Titles and hosts, never database ids.
        expect(within(sources).getByText("NVIDIA")).toBeInTheDocument();
        expect(sources.textContent).toContain("nvidia.com");
        expect(sources.textContent).not.toContain("src-a");
    });

    it("takes the title and credit balance from done and shows both in the sidebar", async () => {
        backend = installFakeBackend({ user: { credits: 500 } });
        const app = renderApp("/");
        await app.ready();

        expect(screen.getByText("500")).toBeInTheDocument();

        await app.ask("Tell me about Nvidia");
        const chat = await backend.awaitChat();
        await emit((c) => c.start("conv-1"), chat);
        await emit((c) => c.token("NVIDIA is a technology company."), chat);
        await emit((c) => c.sources(NVIDIA_SOURCES), chat);
        await emit(
            (c) =>
                c.done({ conversationId: "conv-1", title: "Nvidia GPU overview", creditsRemaining: 480 }),
            chat,
        );
        await emit((c) => c.close(), chat);

        // The sidebar title comes from the backend; nothing is derived from the query here.
        await waitFor(() =>
            expect(screen.getByRole("link", { name: "Nvidia GPU overview" })).toBeInTheDocument(),
        );
        // 500 → 480, reported rather than computed.
        await waitFor(() => expect(screen.getByText("480")).toBeInTheDocument());
        expect(screen.queryByText("500")).not.toBeInTheDocument();
    });

    it("does not decrement credits locally while a query is in flight", async () => {
        backend = installFakeBackend({ user: { credits: 500 } });
        const app = renderApp("/");
        await app.ready();

        await app.ask("Tell me about Nvidia");
        const chat = await backend.awaitChat();
        await emit((c) => c.start("conv-1"), chat);
        await emit((c) => c.token("streaming…"), chat);

        // Mid-answer the charge has happened server-side, but the client has not been told the
        // new balance yet — so it must still show the last number the backend gave it.
        expect(screen.getByText("500")).toBeInTheDocument();

        // An odd balance the client could never have calculated proves it is simply displayed.
        await emit((c) => c.done({ conversationId: "conv-1", title: "T", creditsRemaining: 337 }), chat);
        await waitFor(() => expect(screen.getByText("337")).toBeInTheDocument());
    });
});

describe("existing chat flow", () => {
    const THREAD = {
        conversation: {
            id: "conv-1",
            title: "Nvidia GPU overview",
            createdAt: "2026-08-22T10:00:00.000Z",
            updatedAt: "2026-08-22T10:05:00.000Z",
        },
        messages: [
            { id: "m1", role: "user" as const, content: "Tell me about Nvidia", createdAt: "" },
            { id: "m2", role: "assistant" as const, content: "NVIDIA is a technology company.", createdAt: "" },
        ],
    };

    const openThread = () =>
        installFakeBackend({
            conversations: [THREAD.conversation],
            threads: { "conv-1": THREAD },
            sources: { m2: NVIDIA_SOURCES },
        });

    it("restores the conversation and its route on a refresh", async () => {
        backend = openThread();
        const app = renderApp("/chat/conv-1");
        await app.ready();

        // The URL is the source of truth, so a reload lands back in the same thread.
        expect(app.path()).toBe("/chat/conv-1");
        await waitFor(() => expect(screen.getByText("Tell me about Nvidia")).toBeInTheDocument());
        expect(screen.getByText("NVIDIA is a technology company.")).toBeInTheDocument();
        // Persisted citations are replayed too.
        expect(await screen.findByRole("region", { name: "Sources" })).toBeInTheDocument();
    });

    it("posts a follow-up to /chat/:conversationId and leaves the title alone", async () => {
        backend = openThread();
        const app = renderApp("/chat/conv-1");
        await app.ready();
        await waitFor(() => expect(screen.getByText("Tell me about Nvidia")).toBeInTheDocument());

        await app.ask("What about their AI GPUs?");
        const chat = await backend.awaitChat();

        expect(chat.path).toBe("/api/v1/chat/conv-1");
        // /chat/new must not be touched once a conversation exists.
        expect(backend.chatCalls().map((call) => call.path)).toEqual(["/api/v1/chat/conv-1"]);

        await emit((c) => c.start("conv-1"), chat);
        await emit((c) => c.token("The H100 and H200 are its AI GPUs."), chat);
        // A continuation reports no title.
        await emit((c) => c.done({ conversationId: "conv-1", creditsRemaining: 460 }), chat);
        await emit((c) => c.close(), chat);

        await waitFor(() => expect(screen.getByText("460")).toBeInTheDocument());
        // The sidebar entry keeps the name it was given when the thread began.
        expect(screen.getByRole("link", { name: "Nvidia GPU overview" })).toBeInTheDocument();
        expect(screen.queryByText("Untitled conversation")).not.toBeInTheDocument();
        // Two questions, two answers — the follow-up appended rather than replacing.
        expect(userTurns()).toHaveLength(2);
        expect(assistantTurns()).toHaveLength(2);
    });
});

describe("new chat button", () => {
    it("clears the screen without creating a conversation until a query is submitted", async () => {
        backend = installFakeBackend({
            conversations: [
                {
                    id: "conv-1",
                    title: "Nvidia GPU overview",
                    createdAt: "",
                    updatedAt: "",
                },
            ],
            threads: {
                "conv-1": {
                    conversation: { id: "conv-1", title: "Nvidia GPU overview", createdAt: "", updatedAt: "" },
                    messages: [{ id: "m1", role: "user", content: "Tell me about Nvidia", createdAt: "" }],
                },
            },
        });

        const app = renderApp("/chat/conv-1");
        await app.ready();
        await waitFor(() => expect(screen.getByText("Tell me about Nvidia")).toBeInTheDocument());

        const callsBefore = backend.calls.length;
        await app.user.click(screen.getByRole("button", { name: /new chat/i }));

        expect(app.path()).toBe("/");
        // The empty state, not a thread. (The query text also appears as a suggestion chip here,
        // so the absence that matters is the turn, not the string.)
        await waitFor(() =>
            expect(screen.getByRole("heading", { name: /explore anything/i })).toBeInTheDocument(),
        );
        expect(userTurns()).toHaveLength(0);
        expect(assistantTurns()).toHaveLength(0);

        // Nothing was written to the backend by the click itself.
        expect(backend.calls.slice(callsBefore).filter((call) => call.method === "POST")).toEqual([]);
        expect(backend.chatCalls()).toEqual([]);
    });
});

describe("switching between conversations", () => {
    // These guard the rule that lets a new chat keep streaming through its own navigation: the
    // hook ignores a route change to the conversation it already holds. It must still react to
    // every *other* route change, or the thread would freeze on whatever it opened first.

    it("starts a fresh conversation after New chat, rather than continuing the last one", async () => {
        backend = installFakeBackend();
        const app = renderApp("/");
        await app.ready();

        await app.ask("Tell me about Nvidia");
        const first = await backend.awaitChat();
        await emit((c) => c.start("conv-1"), first);
        await emit((c) => c.token("NVIDIA is a technology company."), first);
        await emit((c) => c.done({ conversationId: "conv-1", title: "Nvidia GPU overview", creditsRemaining: 480 }), first);
        await emit((c) => c.close(), first);
        await waitFor(() => expect(app.path()).toBe("/chat/conv-1"));

        await app.user.click(screen.getByRole("button", { name: /new chat/i }));
        expect(app.path()).toBe("/");

        await app.ask("Something unrelated");
        const second = await backend.awaitChat();

        // The second question must open a new conversation, not append to the first.
        expect(second.path).toBe("/api/v1/chat/new");
        expect(backend.chatCalls().map((call) => call.path)).toEqual([
            "/api/v1/chat/new",
            "/api/v1/chat/new",
        ]);
    });

    it("loads the other thread when a different conversation is picked in the sidebar", async () => {
        const conversationA = { id: "conv-a", title: "Nvidia GPU overview", createdAt: "", updatedAt: "" };
        const conversationB = { id: "conv-b", title: "Vector database picks", createdAt: "", updatedAt: "" };

        backend = installFakeBackend({
            conversations: [conversationA, conversationB],
            threads: {
                "conv-a": {
                    conversation: conversationA,
                    messages: [{ id: "a1", role: "user", content: "Tell me about Nvidia", createdAt: "" }],
                },
                "conv-b": {
                    conversation: conversationB,
                    messages: [{ id: "b1", role: "user", content: "Compare pgvector and Pinecone", createdAt: "" }],
                },
            },
        });

        const app = renderApp("/chat/conv-a");
        await app.ready();
        await waitFor(() => expect(screen.getByText("Tell me about Nvidia")).toBeInTheDocument());

        await app.user.click(screen.getByRole("link", { name: "Vector database picks" }));

        expect(app.path()).toBe("/chat/conv-b");
        await waitFor(() =>
            expect(screen.getByText("Compare pgvector and Pinecone")).toBeInTheDocument(),
        );
        expect(screen.queryByText("Tell me about Nvidia")).not.toBeInTheDocument();
    });
});

describe("composer", () => {
    it("does not submit an empty or whitespace-only query", async () => {
        backend = installFakeBackend();
        const app = renderApp("/");
        const composer = await app.ready();

        await app.user.click(composer);
        await app.user.keyboard("{Enter}");
        await app.user.keyboard("   {Enter}");

        expect(backend.chatCalls()).toEqual([]);
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    });

    it("sends on Enter and inserts a newline on Shift+Enter", async () => {
        backend = installFakeBackend();
        const app = renderApp("/");
        const composer = await app.ready();

        await app.user.click(composer);
        await app.user.keyboard("first{Shift>}{Enter}{/Shift}second");

        expect(composer.value).toBe("first\nsecond");
        expect(backend.chatCalls()).toEqual([]);

        await app.user.keyboard("{Enter}");
        expect(backend.chatCalls()).toHaveLength(1);
        expect(backend.chatCalls()[0]!.body).toEqual({ query: "first\nsecond" });
    });

    it("refuses a second submission while one is still streaming", async () => {
        backend = installFakeBackend();
        const app = renderApp("/");
        await app.ready();

        await app.ask("Tell me about Nvidia");
        const chat = await backend.awaitChat();
        await emit((c) => c.start("conv-1"), chat);
        await emit((c) => c.token("streaming…"), chat);

        // While streaming the send button is replaced by Stop, so there is nothing to press.
        expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Stop generating" })).toBeInTheDocument();

        await app.user.click(app.composer());
        await app.user.keyboard("second question{Enter}");

        expect(backend.chatCalls()).toHaveLength(1);
    });
});

describe("stopping", () => {
    it("keeps the partial answer and does not touch the credit balance", async () => {
        backend = installFakeBackend({ user: { credits: 500 } });
        const app = renderApp("/");
        await app.ready();

        await app.ask("Tell me about Nvidia");
        const chat = await backend.awaitChat();
        await emit((c) => c.start("conv-1"), chat);
        await emit((c) => c.token("NVIDIA is a "), chat);

        await act(async () => {
            (screen.getByRole("button", { name: "Stop generating" }) as HTMLButtonElement).click();
        });

        // Whatever streamed is kept — it really was generated, and it was really paid for.
        await waitFor(() => expect(screen.getByText("Stopped by you.")).toBeInTheDocument());
        // Rendered through Markdown, so the trailing space of the last token collapses. That the
        // state keeps it verbatim is pinned in chatReducer.test.ts.
        expect(answerText()).toBe("NVIDIA is a");
        // No done event arrived, so no refund and no local adjustment.
        expect(screen.getByText("500")).toBeInTheDocument();
        // The composer is usable again.
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument(),
        );
    });
});

describe("errors", () => {
    it("explains insufficient credits without exposing backend detail", async () => {
        backend = installFakeBackend({ user: { credits: 10 } });
        backend.failNextChat({
            status: 402,
            code: "INSUFFICIENT_CREDITS",
            message: "You do not have enough credits for this query.",
        });

        const app = renderApp("/");
        await app.ready();

        // Below the price of a query, the composer refuses up front and the meter explains why.
        expect(
            screen.getByText(/you need 20 credits to ask a question/i),
        ).toBeInTheDocument();
        // The meter says the same thing in its own terms, so the state is not colour-only.
        expect(screen.getByText("none left")).toBeInTheDocument();
        expect(app.composer()).toBeDisabled();
    });

    it("reports a 402 raised at submit time as a friendly failure and keeps the question", async () => {
        backend = installFakeBackend({ user: { credits: 500 } });
        backend.failNextChat({
            status: 402,
            code: "INSUFFICIENT_CREDITS",
            message: "You do not have enough credits for this query.",
        });

        const app = renderApp("/");
        await app.ready();
        await app.ask("Tell me about Nvidia");

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("You don't have enough credits to run this query.");
        // The user's message survives in the thread so the turn can be retried…
        expect(document.querySelector(".user-query")).toHaveTextContent("Tell me about Nvidia");
        expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
        // …and the composer hands the text back, so retrying never means retyping.
        expect(app.composer().value).toBe("Tell me about Nvidia");
    });

    it("reports an in-band SSE error event and keeps the partial turn retryable", async () => {
        backend = installFakeBackend();
        const app = renderApp("/");
        await app.ready();

        await app.ask("Tell me about Nvidia");
        const chat = await backend.awaitChat();
        await emit((c) => c.start("conv-1"), chat);
        await emit((c) => c.error({ code: "SEARCH_FAILED", message: "Tavily exploded" }), chat);
        await emit((c) => c.close(), chat);

        const alert = await screen.findByRole("alert");
        // The provider's own words are never shown.
        expect(alert).not.toHaveTextContent("Tavily");
        expect(alert).toHaveTextContent("The answer couldn't be generated. Please try again.");
        expect(screen.getByText("Tell me about Nvidia")).toBeInTheDocument();
    });

    it("shows a recoverable message when a conversation cannot be loaded", async () => {
        backend = installFakeBackend();
        backend.failNextConversationLoad({
            status: 404,
            code: "NOT_FOUND",
            message: "Conversation not found",
        });

        const app = renderApp("/chat/missing");

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("That conversation is no longer available.");
        await app.user.click(within(alert).getByRole("button", { name: /start a new chat/i }));
        expect(app.path()).toBe("/");
    });

    it("falls back to the sign-in screen when the session is gone", async () => {
        backend = installFakeBackend({ user: null });
        renderApp("/chat/conv-1");

        expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
        // No conversation is fetched for an anonymous visitor.
        expect(backend.calls.some((call) => call.path.startsWith("/api/v1/conversations"))).toBe(false);
    });
});

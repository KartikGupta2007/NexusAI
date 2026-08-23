import { vi } from "vitest";
import type { Conversation, CurrentUser, PersistedMessage, Source } from "../../types/api.ts";

/**
 * A stand-in for the NexusAI API, driven by the test.
 *
 * It speaks the real wire format — the `{ success, message, data }` envelope, the `{ success,
 * code, message, errors }` failure body, and byte-level SSE frames — so the code under test does
 * the same parsing it does in production. Nothing here is aware of the client's internals; a test
 * asserts against `calls`, and drives a stream through the handle returned by `awaitChat()`.
 */

export interface RecordedCall {
    method: string;
    path: string;
    body: unknown;
    credentials: RequestCredentials | undefined;
}

/** Drives one open chat stream, one frame at a time. */
export interface ChatHandle {
    /** The path the client actually posted to — how "new vs continue" is asserted. */
    path: string;
    start: (conversationId: string) => void;
    token: (text: string) => void;
    sources: (sources: Source[]) => void;
    done: (payload: { conversationId: string; title?: string | null; creditsRemaining: number }) => void;
    error: (payload: { code: string; message: string }) => void;
    /** Writes a raw chunk, for exercising the frame parser's buffering directly. */
    raw: (chunk: string) => void;
    close: () => void;
}

export interface HttpFailure {
    status: number;
    code: string;
    message: string;
    errors?: { field?: string; message?: string }[];
}

export interface FakeBackendOptions {
    user?: Partial<CurrentUser> | null;
    /**
     * The account /user/login and /user/register resolve to, for testing sign-in through the
     * UI. Use it with `user: null`: the visitor starts with no session, and signing in is what
     * makes /user/me begin to answer — exactly what setting a cookie does.
     */
    credentials?: Partial<CurrentUser>;
    conversations?: Conversation[];
    /** Keyed by conversation id. */
    threads?: Record<string, { conversation: Conversation; messages: PersistedMessage[] }>;
    /** Keyed by message id. */
    sources?: Record<string, Source[]>;
}

export const makeUser = (overrides: Partial<CurrentUser> = {}): CurrentUser => ({
    id: "user-1",
    email: "gupta@example.com",
    name: "Gupta Ji",
    avatarUrl: null,
    authProvider: "password",
    emailVerified: true,
    credits: 500,
    hasPassword: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
});

export const makeSource = (overrides: Partial<Source> = {}): Source => ({
    id: "src-1",
    position: 1,
    url: "https://www.nvidia.com/",
    title: "NVIDIA",
    content: "NVIDIA designs GPUs.",
    favicon: "https://www.nvidia.com/favicon.ico",
    createdAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
});

const encoder = new TextEncoder();

const json = (status: number, payload: unknown) =>
    ({
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        json: async () => payload,
        body: null,
    }) as unknown as Response;

const success = (message: string, data: unknown) => json(200, { success: true, message, data });

const failure = ({ status, code, message, errors = [] }: HttpFailure) =>
    json(status, { success: false, code, message, errors });

export interface FakeBackend {
    calls: RecordedCall[];
    /** Calls narrowed to the chat endpoints, in order. */
    chatCalls: () => RecordedCall[];
    /** Resolves with a handle to the next chat stream the client opens. */
    awaitChat: () => Promise<ChatHandle>;
    /** Makes the next chat POST fail at the HTTP layer, before any stream opens. */
    failNextChat: (failure: HttpFailure) => void;
    /** Calls to /user/refresh-token, so a test can assert one renewal, not several. */
    refreshCalls: () => RecordedCall[];
    /** Kills the refresh cookie, so renewal fails the way an ended session does. */
    expireRefreshToken: () => void;
    /** Makes the next GET of a conversation fail. */
    failNextConversationLoad: (failure: HttpFailure) => void;
    setConversations: (conversations: Conversation[]) => void;
    restore: () => void;
}

export const installFakeBackend = (options: FakeBackendOptions = {}): FakeBackend => {
    const calls: RecordedCall[] = [];
    let conversations = options.conversations ?? [];
    const threads = options.threads ?? {};
    const sourcesByMessage = options.sources ?? {};
    // Mutable: signing in is what makes /user/me start answering, exactly as a cookie would.
    let user = options.user === null ? null : makeUser(options.user ?? {});

    // A live session renews; an ended one cannot. Default is the realistic case.
    let refreshWorks = true;
    let chatFailure: HttpFailure | null = null;
    let conversationFailure: HttpFailure | null = null;
    const waiters: ((handle: ChatHandle) => void)[] = [];
    const ready: ChatHandle[] = [];

    const openChatStream = (path: string, signal: AbortSignal | null | undefined): Response => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let closed = false;

        const stream = new ReadableStream<Uint8Array>({
            start: (c) => {
                controller = c;
            },
        });

        const write = (chunk: string) => {
            if (closed) return;
            controller.enqueue(encoder.encode(chunk));
        };
        const frame = (event: string, data: unknown) =>
            write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        // A real aborted fetch errors the body stream; the client relies on that to unwind.
        signal?.addEventListener("abort", () => {
            if (closed) return;
            closed = true;
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });

        const handle: ChatHandle = {
            path,
            start: (conversationId) => frame("start", { conversationId }),
            token: (text) => frame("token", { text }),
            sources: (sources) => frame("sources", { sources }),
            done: ({ conversationId, title = null, creditsRemaining }) =>
                frame("done", { conversationId, title, creditsRemaining }),
            error: (payload) => frame("error", payload),
            raw: write,
            close: () => {
                if (closed) return;
                closed = true;
                controller.close();
            },
        };

        const waiter = waiters.shift();
        if (waiter) waiter(handle);
        else ready.push(handle);

        return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({}),
            body: stream,
        } as unknown as Response;
    };

    const handler = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
        const path = String(input);
        const method = (init.method ?? "GET").toUpperCase();
        const body: Record<string, unknown> | undefined =
            typeof init.body === "string" ? JSON.parse(init.body) : undefined;

        calls.push({ method, path, body, credentials: init.credentials });

        // ── Chat (SSE) ───────────────────────────────────────────────────────
        if (method === "POST" && path.startsWith("/api/v1/chat/")) {
            if (chatFailure) {
                const pending = chatFailure;
                chatFailure = null;
                return failure(pending);
            }
            return openChatStream(path, init.signal);
        }

        // ── User ─────────────────────────────────────────────────────────────
        if (path === "/api/v1/user/me") {
            return user
                ? success("Current user", { user })
                : failure({ status: 401, code: "MISSING_ACCESS_TOKEN", message: "Authentication required" });
        }
        // Rotation is invisible from here — the browser is handed new cookies and replays
        // its request. What matters to a test is only whether the session survived.
        if (path === "/api/v1/user/refresh-token") {
            return refreshWorks && user
                ? success("Session refreshed", { user })
                : failure({
                      status: 401,
                      code: "INVALID_REFRESH_TOKEN",
                      message: "Refresh token is invalid or has expired",
                  });
        }
        if (path === "/api/v1/user/logout") {
            user = null;
            return success("Signed out", undefined);
        }
        if (path === "/api/v1/user/login" || path === "/api/v1/user/register") {
            if (options.user === null && !options.credentials) {
                return failure({
                    status: 401,
                    code: "INVALID_CREDENTIALS",
                    message: "Invalid email or password",
                });
            }
            user ??= makeUser(options.credentials ?? options.user ?? {});
            return success("Signed in", { user });
        }
        // No /user/googleAuth route: the browser cannot reach it and never should. Google
        // sign-in leaves the page entirely — see stubNavigation in auth.test.tsx — and comes
        // back as a fresh load whose /user/me already has a session. Any request to it here
        // therefore falls through to the 404 below, which is the assertion we want.

        // ── Conversations ────────────────────────────────────────────────────
        if (path === "/api/v1/conversations") {
            return success("Conversations fetched successfully", { conversations });
        }
        if (path.startsWith("/api/v1/conversations/")) {
            if (conversationFailure) {
                const pending = conversationFailure;
                conversationFailure = null;
                return failure(pending);
            }
            const id = decodeURIComponent(path.slice("/api/v1/conversations/".length));
            const thread = threads[id];
            return thread
                ? success("Conversation fetched successfully", thread)
                : failure({ status: 404, code: "NOT_FOUND", message: "Conversation not found" });
        }

        // ── Message sources ──────────────────────────────────────────────────
        const sourceMatch = /^\/api\/v1\/messages\/(.+)\/sources$/.exec(path);
        if (sourceMatch) {
            const id = decodeURIComponent(sourceMatch[1]!);
            return success("Message sources fetched successfully", {
                sources: sourcesByMessage[id] ?? [],
            });
        }

        return failure({ status: 404, code: "NOT_FOUND", message: `No fake route for ${method} ${path}` });
    };

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(handler as typeof fetch);

    return {
        calls,
        chatCalls: () => calls.filter((call) => call.path.startsWith("/api/v1/chat/")),
        awaitChat: () => {
            const existing = ready.shift();
            if (existing) return Promise.resolve(existing);
            return new Promise<ChatHandle>((resolve) => waiters.push(resolve));
        },
        refreshCalls: () => calls.filter((call) => call.path === "/api/v1/user/refresh-token"),
        expireRefreshToken: () => {
            refreshWorks = false;
        },
        failNextChat: (next) => {
            chatFailure = next;
        },
        failNextConversationLoad: (next) => {
            conversationFailure = next;
        },
        setConversations: (next) => {
            conversations = next;
        },
        restore: () => spy.mockRestore(),
    };
};

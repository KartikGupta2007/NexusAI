import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeBackend } from "./helpers/fakeBackend.ts";
import type { FakeBackend } from "./helpers/fakeBackend.ts";
import { renderApp } from "./helpers/renderApp.tsx";

/**
 * Authentication, end to end through the real provider and pages.
 *
 * Nothing is mocked here except the navigation itself — there is no auth SDK left to mock. The
 * questions these tests answer are architectural: does Google sign-in go to the NexusAI backend,
 * does the app ever reach past it, and does a signed-out visitor stay out of the application.
 */

/**
 * Captures where the page would have navigated to.
 *
 * jsdom has no navigation, so `location.assign` has to be replaced whatever the test asserts.
 * Replacing it is also the assertion: the destination is the entire client-side contract for
 * Google sign-in now, so recording it records everything the browser does.
 */
const stubNavigation = () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
        ...window.location,
        origin: window.location.origin,
        assign,
    } as unknown as Location);
    return assign;
};

let backend: FakeBackend;

beforeEach(() => {
    sessionStorage.clear();
});

afterEach(() => {
    backend?.restore();
    vi.restoreAllMocks();
    sessionStorage.clear();
});

describe("bootstrap", () => {
    it("shows a NexusAI loading state while the session is being resolved", async () => {
        backend = installFakeBackend();
        renderApp("/");

        // Before /user/me settles there is neither login nor chat — only the boot screen.
        expect(screen.getByRole("status")).toHaveTextContent("Signing you in");
        expect(screen.queryByRole("button", { name: /continue with google/i })).not.toBeInTheDocument();

        await waitFor(() => expect(screen.getByLabelText("Your question")).toBeInTheDocument());
    });

    it("renders the application for a signed-in user off one /user/me call", async () => {
        backend = installFakeBackend({ user: { email: "gupta@example.com", credits: 500 } });
        const app = renderApp("/");
        await app.ready();

        expect(screen.getByRole("navigation", { name: "Conversations" })).toBeInTheDocument();
        // The session is established by exactly one question, asked of the NexusAI API.
        expect(backend.calls.filter((call) => call.path === "/api/v1/user/me")).toHaveLength(1);
    });

    it("shows the login page, and no chat UI, for a signed-out visitor", async () => {
        backend = installFakeBackend({ user: null });
        renderApp("/chat/conv-1");

        expect(await screen.findByRole("button", { name: /continue with google/i })).toBeInTheDocument();
        expect(screen.queryByLabelText("Your question")).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Conversations" })).not.toBeInTheDocument();
        // No conversation is fetched for someone who is not signed in.
        expect(backend.calls.some((call) => call.path.startsWith("/api/v1/conversations"))).toBe(false);
    });

    it("offers Google sign-in without asking any service whether it is available", async () => {
        backend = installFakeBackend({ user: null });
        renderApp("/");

        // The button is unconditional: availability is the backend's configuration, not a flag
        // the client reads. So a signed-out load asks only whether there is a session — the
        // check itself, then the one renewal attempt its 401 earns, and nothing else.
        expect(await screen.findByRole("button", { name: /continue with google/i })).toBeInTheDocument();
        expect(backend.calls.map((call) => call.path)).toEqual([
            "/api/v1/user/me",
            "/api/v1/user/refresh-token",
        ]);
    });

    it("reaches nothing but the NexusAI API on any load", async () => {
        backend = installFakeBackend({
            user: { email: "gupta@example.com" },
            conversations: [{ id: "c1", title: "One", createdAt: "", updatedAt: "" }],
        });
        const app = renderApp("/");
        await app.ready();

        // Every request, without exception, is a relative NexusAI API path. No absolute URL, and
        // in particular nothing on any auth-provider or database host.
        for (const call of backend.calls) {
            expect(call.path.startsWith("/api/v1/")).toBe(true);
        }
    });
});

describe("Google sign-in", () => {
    it("navigates to the NexusAI backend, and does no authentication itself", async () => {
        const assign = stubNavigation();
        backend = installFakeBackend({ user: null });
        const app = renderApp("/");

        await app.user.click(await screen.findByRole("button", { name: /continue with google/i }));

        // The whole of the client's part: hand the browser to our own API and stop.
        expect(assign).toHaveBeenCalledWith("/api/v1/user/googleAuth/start");
        // No OAuth, no token exchange, no request to a third party. The only traffic is the
        // session check the page load already made.
        expect(backend.calls.map((call) => call.path)).toEqual([
            "/api/v1/user/me",
            "/api/v1/user/refresh-token",
        ]);
    });

    it("shows the redirect in progress so the button cannot be double-fired", async () => {
        stubNavigation();
        backend = installFakeBackend({ user: null });
        const app = renderApp("/");

        await app.user.click(await screen.findByRole("button", { name: /continue with google/i }));

        expect(await screen.findByRole("button", { name: /redirecting/i })).toBeDisabled();
    });
});

describe("returning from Google", () => {
    it("is an ordinary load: the session is already established", async () => {
        // What the backend leaves behind before redirecting back — a NexusAI cookie, so
        // /user/me simply answers. There is no exchange left for the client to perform.
        backend = installFakeBackend({
            user: { email: "gupta@example.com", credits: 500 },
            conversations: [{ id: "c1", title: "One", createdAt: "", updatedAt: "" }],
        });

        renderApp("/");

        await waitFor(() => expect(screen.getByLabelText("Your question")).toBeInTheDocument());
        expect(screen.getByText("500")).toBeInTheDocument();
        expect(backend.calls.some((call) => call.path === "/api/v1/conversations")).toBe(true);
        // Nothing token-shaped was ever posted anywhere.
        expect(backend.calls.some((call) => call.path.includes("googleAuth"))).toBe(false);
    });

    it("explains a failed sign-in rather than silently returning to the login screen", async () => {
        backend = installFakeBackend({ user: null });
        // Where the backend sends the browser when the handshake did not complete.
        renderApp("/?googleAuth=incomplete");

        expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled or timed out/i);
        expect(screen.queryByLabelText("Your question")).not.toBeInTheDocument();
    });

    it("reports an account collision in terms the user can act on", async () => {
        backend = installFakeBackend({ user: null });
        renderApp("/?googleAuth=conflict");

        expect(await screen.findByRole("alert")).toHaveTextContent(/sign in with your password/i);
    });

    it("says something useful even for a reason it does not recognise", async () => {
        backend = installFakeBackend({ user: null });
        renderApp("/?googleAuth=something-new");

        expect(await screen.findByRole("alert")).toHaveTextContent(/could not be completed/i);
    });
});

describe("password sign-in", () => {
    it("still signs a password account in, unchanged", async () => {
        // No session to start with; /user/me only answers once the login below succeeds.
        backend = installFakeBackend({
            user: null,
            credentials: { email: "gupta@example.com", credits: 500 },
        });
        const app = renderApp("/");

        const submit = await screen.findByRole("button", { name: "Sign in" });
        await app.user.type(screen.getByLabelText("Email"), "gupta@example.com");
        await app.user.type(screen.getByLabelText("Password"), "Password1");
        await app.user.click(submit);

        await waitFor(() => expect(screen.getByLabelText("Your question")).toBeInTheDocument());
        expect(backend.calls.find((call) => call.path === "/api/v1/user/login")).toMatchObject({
            method: "POST",
            body: { email: "gupta@example.com", password: "Password1" },
            credentials: "include",
        });
    });

    it("surfaces a rejected password without leaving the login screen", async () => {
        backend = installFakeBackend({ user: null });
        const app = renderApp("/");

        await app.user.type(await screen.findByLabelText("Email"), "gupta@example.com");
        await app.user.type(screen.getByLabelText("Password"), "wrong-password");
        await app.user.click(screen.getByRole("button", { name: "Sign in" }));

        // describeError renders every 401 as the session-expired sentence — pre-existing, and
        // not this change's business. What matters here is that the rejection is shown at all
        // and the visitor is not let into the app.
        expect(await screen.findByRole("alert")).toHaveTextContent(/sign in again/i);
        expect(screen.queryByLabelText("Your question")).not.toBeInTheDocument();
    });
});

describe("sign out", () => {
    it("ends the one session there is, then returns to login", async () => {
        backend = installFakeBackend({ user: { email: "gupta@example.com" } });
        const app = renderApp("/");
        await app.ready();

        await app.user.click(screen.getByRole("button", { name: "Sign out" }));

        expect(await screen.findByRole("button", { name: /continue with google/i })).toBeInTheDocument();
        expect(backend.calls.some((call) => call.path === "/api/v1/user/logout")).toBe(true);
        // No second provider to sign out of: the backend ended the Neon Auth session when it
        // was done with it, so logout is one call to one API.
        for (const call of backend.calls) {
            expect(call.path.startsWith("/api/v1/")).toBe(true);
        }
    });

    it("still signs the user out locally when the backend logout call fails", async () => {
        backend = installFakeBackend({ user: { email: "gupta@example.com" } });
        const app = renderApp("/");
        await app.ready();

        const original = globalThis.fetch as typeof fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
            if (String(input).endsWith("/user/logout")) throw new TypeError("network down");
            return original(input as RequestInfo, init);
        }) as typeof fetch);

        await app.user.click(screen.getByRole("button", { name: "Sign out" }));

        // A failed request must not strand the user in an app they meant to leave.
        expect(await screen.findByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    });
});
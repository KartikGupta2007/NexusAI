import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeBackend, makeSource } from "./helpers/fakeBackend.ts";
import type { ChatHandle, FakeBackend } from "./helpers/fakeBackend.ts";
import { renderApp } from "./helpers/renderApp.tsx";

/**
 * Presentation behaviour: the drawer, the code-block affordances, inline citations, and the
 * promises the design makes about motion and code splitting.
 */

let backend: FakeBackend;

afterEach(() => backend?.restore());

const emit = (write: (chat: ChatHandle) => void, chat: ChatHandle) =>
    act(async () => {
        write(chat);
        await Promise.resolve();
    });

/** Runs one full answer and returns once its text is on screen. */
const answerWith = async (text: string, sources = [] as ReturnType<typeof makeSource>[]) => {
    const app = renderApp("/");
    await app.ready();
    await app.ask("Tell me about Nvidia");

    const chat = await backend.awaitChat();
    await emit((c) => c.start("conv-1"), chat);
    await emit((c) => c.token(text), chat);
    if (sources.length) await emit((c) => c.sources(sources), chat);
    await emit((c) => c.done({ conversationId: "conv-1", title: "T", creditsRemaining: 480 }), chat);
    await emit((c) => c.close(), chat);

    return app;
};

describe("lazy loading", () => {
    it("renders the chat route, which is a separate chunk from the shell", async () => {
        backend = installFakeBackend();
        const app = renderApp("/");

        // Suspense resolves the ChatPage chunk before the composer can exist.
        await app.ready();
        expect(screen.getByRole("heading", { name: /explore anything/i })).toBeInTheDocument();
    });

    it("renders the login route from its own chunk", async () => {
        backend = installFakeBackend({ user: null });
        renderApp("/");

        expect(await screen.findByRole("heading", { name: /welcome to nexusai/i })).toBeInTheDocument();
    });

    it("renders Markdown through the lazily-loaded renderer", async () => {
        backend = installFakeBackend();
        await answerWith("## Heading\n\nSome **bold** text.");

        // The formatted result proves the deferred chunk resolved and replaced the fallback.
        await waitFor(() =>
            expect(screen.getByRole("heading", { name: "Heading", level: 2 })).toBeInTheDocument(),
        );
        expect(document.querySelector(".markdown strong")).toHaveTextContent("bold");
    });
});

describe("answer rendering", () => {
    it("renders a fenced code block with its language and a working copy button", async () => {
        backend = installFakeBackend();
        const app = await answerWith('```ts\nconst x: number = 1;\n```');

        await waitFor(() => expect(document.querySelector(".code")).toBeInTheDocument());
        expect(screen.getByText("ts")).toBeInTheDocument();

        // user-event installs its own clipboard stub during setup, so spy on that one.
        const writeText = vi.spyOn(navigator.clipboard, "writeText");
        await app.user.click(screen.getByRole("button", { name: "Copy code" }));

        // Copies exactly what is on screen, not a reconstruction of it.
        expect(writeText).toHaveBeenCalledWith("const x: number = 1;\n");
        expect(await screen.findByRole("button", { name: "Code copied" })).toBeInTheDocument();
    });

    it("renders a table inside its own scroll container so the column never widens", async () => {
        backend = installFakeBackend();
        await answerWith("| A | B |\n| - | - |\n| 1 | 2 |");

        await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
        expect(document.querySelector(".table-scroll")).toContainElement(screen.getByRole("table"));
    });

    it("links a bracketed citation to the source at that position", async () => {
        backend = installFakeBackend();
        const sources = [
            makeSource({ id: "s1", position: 1, url: "https://www.nvidia.com/", title: "NVIDIA" }),
            makeSource({ id: "s2", position: 2, url: "https://en.wikipedia.org/wiki/Nvidia", title: "Wikipedia" }),
        ];
        await answerWith("Nvidia designs GPUs [2].", sources);

        await waitFor(() => expect(document.querySelector(".cite")).toBeInTheDocument());
        const chip = document.querySelector(".cite") as HTMLAnchorElement;
        // Position 2 → the second source's URL, not the first.
        expect(chip).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Nvidia");
        expect(chip).toHaveAttribute("target", "_blank");
        expect(chip).toHaveAttribute("rel", expect.stringContaining("noopener"));
    });

    it("leaves a bracketed number alone when no source sits at that position", async () => {
        backend = installFakeBackend();
        await answerWith("Only one source here [7].", [makeSource({ id: "s1", position: 1 })]);

        await waitFor(() => expect(document.querySelector(".markdown")).toBeInTheDocument());
        // Never invent a citation: an unresolvable marker stays literal text.
        expect(document.querySelector(".cite")).toBeNull();
        expect(document.querySelector(".markdown")).toHaveTextContent("Only one source here [7].");
    });
});

describe("mobile drawer", () => {
    it("opens from the menu button and closes on the scrim, Escape, and navigation", async () => {
        backend = installFakeBackend({
            conversations: [{ id: "conv-1", title: "Nvidia GPU overview", createdAt: "", updatedAt: "" }],
            threads: {
                "conv-1": {
                    conversation: { id: "conv-1", title: "Nvidia GPU overview", createdAt: "", updatedAt: "" },
                    messages: [{ id: "m1", role: "user", content: "Tell me about Nvidia", createdAt: "" }],
                },
            },
        });

        const app = renderApp("/");
        await app.ready();

        const shell = document.querySelector(".shell")!;
        const menu = screen.getByRole("button", { name: "Open conversations" });
        expect(menu).toHaveAttribute("aria-expanded", "false");
        expect(shell).not.toHaveClass("drawer-open");

        // Open.
        await app.user.click(menu);
        expect(shell).toHaveClass("drawer-open");
        expect(screen.getByRole("button", { name: "Open conversations" })).toHaveAttribute(
            "aria-expanded",
            "true",
        );

        // Close by tapping the backdrop, which is hidden from assistive tech by design.
        const scrim = document.querySelector(".scrim") as HTMLElement;
        expect(scrim).toHaveAttribute("aria-hidden", "true");
        await app.user.click(scrim);
        expect(shell).not.toHaveClass("drawer-open");

        // The drawer's own labelled close button is the accessible route out.
        await app.user.click(menu);
        await app.user.click(screen.getByRole("button", { name: "Close conversations" }));
        expect(shell).not.toHaveClass("drawer-open");

        // Escape closes it too.
        await app.user.click(menu);
        expect(shell).toHaveClass("drawer-open");
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(shell).not.toHaveClass("drawer-open");

        // Picking a conversation closes it and navigates.
        await app.user.click(menu);
        await app.user.click(screen.getByRole("link", { name: "Nvidia GPU overview" }));
        expect(app.path()).toBe("/chat/conv-1");
        await waitFor(() => expect(shell).not.toHaveClass("drawer-open"));
    });
});

describe("reduced motion", () => {
    it("renders the full interface when the user asks for no animation", async () => {
        // The reduction is entirely CSS, so the guarantee worth testing is that nothing in the
        // component tree depends on an animation having run.
        Object.defineProperty(window, "matchMedia", {
            configurable: true,
            value: (query: string) =>
                ({
                    matches: query.includes("prefers-reduced-motion"),
                    media: query,
                    onchange: null,
                    addListener: () => {},
                    removeListener: () => {},
                    addEventListener: () => {},
                    removeEventListener: () => {},
                    dispatchEvent: () => false,
                }) as MediaQueryList,
        });

        backend = installFakeBackend();
        const app = renderApp("/");
        await app.ready();

        await app.ask("Tell me about Nvidia");
        const chat = await backend.awaitChat();
        await emit((c) => c.start("conv-1"), chat);

        // The thinking state is reachable and announced without motion.
        expect(await screen.findByRole("status")).toHaveTextContent(/searching the web/i);

        await emit((c) => c.token("NVIDIA is a technology company."), chat);
        await emit((c) => c.done({ conversationId: "conv-1", title: "T", creditsRemaining: 480 }), chat);
        await emit((c) => c.close(), chat);

        await waitFor(() =>
            expect(document.querySelector(".turn-assistant")).toHaveTextContent(
                "NVIDIA is a technology company.",
            ),
        );
        expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    });
});

describe("credit presentation", () => {
    it("describes the balance in queries without ever computing the balance", async () => {
        backend = installFakeBackend({ user: { credits: 460 } });
        const app = renderApp("/");
        await app.ready();

        expect(screen.getByText("460")).toBeInTheDocument();
        // 460 / 20 = 23, derived from the authoritative number at the documented price.
        expect(screen.getByText("23 queries")).toBeInTheDocument();

        const bar = screen.getByRole("progressbar", { name: "Credits remaining" });
        expect(bar).toHaveAttribute("aria-valuenow", "460");
    });

    it("warns at a low balance while still allowing a query", async () => {
        backend = installFakeBackend({ user: { credits: 40 } });
        const app = renderApp("/");
        await app.ready();

        expect(document.querySelector(".credits-low")).toBeInTheDocument();
        expect(screen.getByText("2 queries")).toBeInTheDocument();
        expect(app.composer()).not.toBeDisabled();
    });

    it("blocks the composer and explains why at an unusable balance", async () => {
        backend = installFakeBackend({ user: { credits: 10 } });
        const app = renderApp("/");
        await app.ready();

        expect(document.querySelector(".credits-empty")).toBeInTheDocument();
        expect(screen.getByText("none left")).toBeInTheDocument();
        expect(app.composer()).toBeDisabled();
        expect(screen.getByText(/you need 20 credits to ask a question/i)).toBeInTheDocument();
        // The suggestion chips are blocked too, so there is no way to spend credits you lack.
        for (const chip of screen.getAllByRole("button", { name: /tell me about nvidia/i })) {
            expect(chip).toBeDisabled();
        }
    });
});

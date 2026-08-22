import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { BrandLockup } from "./components/BrandMark.tsx";
import { IconMenu } from "./components/Icon.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { useApp } from "./state/AppContext.tsx";
import "./styles/app.css";

/**
 * App shell.
 *
 * Routes are the source of truth for which conversation is open:
 *   /                       new chat, no conversation created yet
 *   /chat/:conversationId   an existing conversation
 *
 * The two pages are split apart because a visitor only ever needs one of them: a signed-out user
 * downloads the login screen without the chat UI behind it, and a signed-in user never downloads
 * the login screen at all.
 *
 * ChatPage is deliberately *not* keyed by conversation id. Remounting on id change would destroy
 * the streaming state of a brand-new chat at the exact moment `start` moves the route from `/` to
 * `/chat/:id` — see useChatStream for how that navigation is recognised instead.
 */

const ChatPage = lazy(() => import("./pages/ChatPage.tsx"));
const LoginPage = lazy(() => import("./pages/LoginPage.tsx"));

/** The one loading screen: shown for auth bootstrap and for a page chunk in flight. */
const Booting = ({ label }: { label: string }) => (
    <div className="boot" role="status" aria-live="polite">
        <BrandLockup large thinking />
        <span className="boot-bar" aria-hidden="true" />
        <span className="sr-only">{label}</span>
    </div>
);

export const App = () => {
    const { status } = useApp();
    const [drawerOpen, setDrawerOpen] = useState(false);

    // Every control inside the drawer that navigates calls this, so the drawer closes as part of
    // the interaction rather than as a reaction to the route changing afterwards.
    const closeDrawer = useCallback(() => setDrawerOpen(false), []);

    // Escape closes the drawer, as it would any overlay.
    useEffect(() => {
        if (!drawerOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setDrawerOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [drawerOpen]);

    if (status === "loading") return <Booting label="Signing you in" />;

    if (status === "anonymous") {
        return (
            <Suspense fallback={<Booting label="Loading" />}>
                <LoginPage />
            </Suspense>
        );
    }

    return (
        <div className={`shell${drawerOpen ? " drawer-open" : ""}`}>
            <header className="mobile-bar">
                <button
                    type="button"
                    className="btn btn-icon"
                    onClick={() => setDrawerOpen(true)}
                    aria-label="Open conversations"
                    aria-expanded={drawerOpen}
                    aria-controls="sidebar"
                >
                    <IconMenu />
                </button>
                <BrandLockup />
            </header>

            <aside className="shell-aside" id="sidebar">
                {/* `onNavigate` is what tells the sidebar it is inside the drawer. */}
                <Sidebar onNavigate={closeDrawer} />
            </aside>

            {/*
              * Tapping outside closes the drawer. Hidden from assistive tech on purpose: it is a
              * backdrop, and exposing it would put a second control with the same name as the
              * drawer's real close button in the tree. Keyboard users get that button, and Escape.
              */}
            {drawerOpen ? <div className="scrim" aria-hidden="true" onClick={closeDrawer} /> : null}

            <div className="shell-main">
                <Suspense fallback={<div className="chat" aria-busy="true" />}>
                    <Routes>
                        <Route path="/" element={<ChatPage />} />
                        <Route path="/chat/:conversationId" element={<ChatPage />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </Suspense>
            </div>
        </div>
    );
};

export default App;

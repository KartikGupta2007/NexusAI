import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentUser, logout as logoutRequest } from "../api/user.ts";
import { listConversations } from "../api/conversations.ts";
import { ApiError } from "../api/errors.ts";
import type { Conversation, CurrentUser } from "../types/api.ts";

/**
 * Session-wide state: who is signed in, their credit balance, and the sidebar list.
 *
 * Thread state deliberately lives outside this, in the chat reducer, so a token arriving does not
 * re-render the sidebar.
 *
 * The credit balance is *only* ever assigned from a backend value — /user/me on load, then the
 * `creditsRemaining` on each `done` event. Nothing here subtracts.
 */

export type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AppContextValue {
    status: AuthStatus;
    user: CurrentUser | null;
    credits: number | null;
    conversations: Conversation[];
    /** True until the first sidebar fetch settles, so the list can show a skeleton. */
    conversationsLoading: boolean;
    /** Records a balance reported by the backend. */
    setCredits: (credits: number) => void;
    /** Adds or updates a sidebar entry without a refetch. */
    upsertConversation: (conversation: Pick<Conversation, "id"> & Partial<Conversation>) => void;
    refreshConversations: () => Promise<void>;
    /** True for a conversation created during this session, so only those animate in. */
    isFresh: (conversationId: string) => boolean;
    onAuthenticated: (user: CurrentUser) => void;
    signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = ({ children }: { children: ReactNode }) => {
    const [status, setStatus] = useState<AuthStatus>("loading");
    const [user, setUser] = useState<CurrentUser | null>(null);
    const [credits, setCreditsState] = useState<number | null>(null);
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [conversationsLoading, setConversationsLoading] = useState(true);

    /** Ids added during this session, so the sidebar can animate only those in. */
    const freshIds = useRef(new Set<string>());

    const refreshConversations = useCallback(async () => {
        try {
            setConversations(await listConversations());
        } catch (error) {
            // A 401 here is handled by the auth bootstrap; anything else leaves the list as-is
            // rather than blanking a sidebar the user is looking at.
            if (!(error instanceof ApiError && error.isUnauthenticated)) {
                console.error("[sidebar] could not load conversations", error);
            }
        } finally {
            setConversationsLoading(false);
        }
    }, []);

    /**
     * Everything that becoming signed in means, in one place — including the sidebar.
     *
     * Loading the history here rather than leaving it to each caller is the point. Password
     * sign-in calls this and nothing else, so when the fetch lived at the call sites instead it
     * was simply missed: the user landed on an empty history that only filled in after a reload,
     * while Google sign-in looked fine because it returns through a full page load and therefore
     * through the bootstrap below.
     */
    const onAuthenticated = useCallback(
        (next: CurrentUser) => {
            setUser(next);
            setCreditsState(next.credits);
            setStatus("authenticated");
            // A skeleton while it arrives, so the sidebar never reads as "you have no
            // conversations" when the truth is "they have not been fetched yet".
            setConversationsLoading(true);
            void refreshConversations();
        },
        [refreshConversations],
    );

    /**
     * Bootstrap: one question, asked of one system.
     *
     * `GET /user/me` against the httpOnly cookie is the whole of it, and it is equally the
     * answer on a cold load and on the load that follows a Google sign-in — the backend
     * establishes the session before it redirects the browser back, so by the time this runs
     * there is nothing left to exchange. No second auth system to consult, no pending-redirect
     * flag, no SDK to download on the boot path.
     */
    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                const current = await getCurrentUser();
                if (cancelled) return;
                // Loads the sidebar too — see onAuthenticated.
                onAuthenticated(current);
                return;
            } catch (error) {
                // Anything other than "not signed in" is still not a session.
                if (!(error instanceof ApiError && error.isUnauthenticated)) {
                    console.error("[auth] session check failed", error);
                }
            }

            if (!cancelled) {
                setStatus("anonymous");
                setConversationsLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [onAuthenticated]);

    const setCredits = useCallback((next: number) => {
        setCreditsState(next);
        setUser((previous) => (previous ? { ...previous, credits: next } : previous));
    }, []);

    const upsertConversation = useCallback(
        (entry: Pick<Conversation, "id"> & Partial<Conversation>) => {
            setConversations((previous) => {
                const now = new Date().toISOString();
                const existing = previous.find((item) => item.id === entry.id);
                if (!existing) freshIds.current.add(entry.id);

                const merged: Conversation = {
                    id: entry.id,
                    title: entry.title ?? existing?.title ?? null,
                    createdAt: entry.createdAt ?? existing?.createdAt ?? now,
                    updatedAt: entry.updatedAt ?? now,
                };

                // Nothing changed — return the same array so the sidebar does not re-render.
                if (
                    existing &&
                    existing.title === merged.title &&
                    previous[0]?.id === entry.id
                ) {
                    return previous;
                }

                // Most recent first, matching the backend's own ordering.
                return [merged, ...previous.filter((item) => item.id !== entry.id)];
            });
        },
        [],
    );

    const isFresh = useCallback((id: string) => freshIds.current.has(id), []);

    const signOut = useCallback(async () => {
        try {
            // The NexusAI session is the only session there is: the backend ends the Neon Auth
            // one as soon as it has finished with it, so there is no second sign-out to make.
            await logoutRequest();
        } catch {
            // Clearing local state below still signs the user out of this tab.
        }

        freshIds.current.clear();
        setUser(null);
        setCreditsState(null);
        setConversations([]);
        setConversationsLoading(false);
        setStatus("anonymous");
    }, []);

    const value = useMemo<AppContextValue>(
        () => ({
            status,
            user,
            credits,
            conversations,
            conversationsLoading,
            setCredits,
            upsertConversation,
            refreshConversations,
            isFresh,
            onAuthenticated,
            signOut,
        }),
        [
            status,
            user,
            credits,
            conversations,
            conversationsLoading,
            setCredits,
            upsertConversation,
            refreshConversations,
            isFresh,
            onAuthenticated,
            signOut,
        ],
    );

    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = (): AppContextValue => {
    const context = useContext(AppContext);
    if (!context) throw new Error("useApp must be used inside AppProvider");
    return context;
};

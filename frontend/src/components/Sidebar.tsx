import { memo } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { BrandLockup } from "./BrandMark.tsx";
import { CreditMeter } from "./CreditMeter.tsx";
import { IconClose, IconPlus, IconSignOut } from "./Icon.tsx";
import { useApp } from "../state/AppContext.tsx";
import type { Conversation } from "../types/api.ts";

/**
 * Conversation history, credits and account.
 *
 * "New chat" navigates and nothing more — no conversation is created until the user actually
 * submits a query. Creating one on click would litter the sidebar with empty threads.
 *
 * The whole sidebar is memoised on the app state it reads. A streaming answer dispatches once per
 * token into the chat reducer, which lives outside this context, so none of those updates reach
 * here; the only things that re-render it are a new conversation, a title, and a credit change.
 */

const initialsOf = (name: string | null, email: string): string => {
    const source = name?.trim() || email;
    const parts = source.split(/[\s@._-]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
};

/** One history row. Split out so a title arriving re-renders only its own row. */
const HistoryRow = memo(
    ({
        conversation,
        isNew,
        onNavigate,
    }: {
        conversation: Conversation;
        isNew: boolean;
        onNavigate?: () => void;
    }) => {
        const label = conversation.title?.trim() || "New conversation";
        return (
            <li>
                <NavLink
                    to={`/chat/${conversation.id}`}
                    className={({ isActive }) =>
                        `history-item${isActive ? " is-active" : ""}${isNew ? " is-new" : ""}`
                    }
                    onClick={onNavigate}
                    title={label}
                >
                    {label}
                </NavLink>
            </li>
        );
    },
);

HistoryRow.displayName = "HistoryRow";

export const Sidebar = memo(({ onNavigate }: { onNavigate?: () => void }) => {
    const { conversations, conversationsLoading, credits, user, isFresh, signOut } = useApp();
    const navigate = useNavigate();

    return (
        <nav className="sidebar" aria-label="Conversations">
            <div className="sidebar-head">
                <BrandLockup />
                {/* Only reachable inside the mobile drawer; hidden from the desktop column. */}
                {onNavigate ? (
                    <button
                        type="button"
                        className="btn btn-icon drawer-close"
                        onClick={onNavigate}
                        aria-label="Close conversations"
                    >
                        <IconClose />
                    </button>
                ) : null}
            </div>

            <button
                type="button"
                className="new-chat"
                onClick={() => {
                    navigate("/");
                    onNavigate?.();
                }}
            >
                <IconPlus width={15} height={15} />
                New chat
            </button>

            <div className="history">
                <h2 className="history-label">History</h2>

                {conversationsLoading ? (
                    <div className="history-skeleton" aria-hidden="true">
                        <span className="skeleton skeleton-row" style={{ width: "82%" }} />
                        <span className="skeleton skeleton-row" style={{ width: "64%" }} />
                        <span className="skeleton skeleton-row" style={{ width: "73%" }} />
                    </div>
                ) : conversations.length === 0 ? (
                    <p className="history-empty">Your conversations will appear here.</p>
                ) : (
                    <ul className="history-list">
                        {conversations.map((conversation) => (
                            <HistoryRow
                                key={conversation.id}
                                conversation={conversation}
                                isNew={isFresh(conversation.id)}
                                onNavigate={onNavigate}
                            />
                        ))}
                    </ul>
                )}
            </div>

            <div className="sidebar-foot">
                <CreditMeter credits={credits} />

                {user ? (
                    <div className="account">
                        {user.avatarUrl ? (
                            <img
                                className="avatar"
                                src={user.avatarUrl}
                                alt=""
                                width={27}
                                height={27}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                                onError={(event) => {
                                    // A dead Google avatar must not leave a broken-image box.
                                    event.currentTarget.style.display = "none";
                                }}
                            />
                        ) : (
                            <span className="avatar" aria-hidden="true">
                                {initialsOf(user.name, user.email)}
                            </span>
                        )}

                        <span className="account-id">
                            {user.name?.trim() ? (
                                <>
                                    <span className="account-name">{user.name}</span>
                                    <span className="account-email" title={user.email}>
                                        {user.email}
                                    </span>
                                </>
                            ) : (
                                <span className="account-name" title={user.email}>
                                    {user.email}
                                </span>
                            )}
                        </span>

                        <button
                            type="button"
                            className="btn btn-icon"
                            onClick={() => void signOut()}
                            aria-label="Sign out"
                            title="Sign out"
                        >
                            <IconSignOut />
                        </button>
                    </div>
                ) : null}
            </div>
        </nav>
    );
});

Sidebar.displayName = "Sidebar";

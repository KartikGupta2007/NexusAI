/**
 * The backend's wire contract, mirrored.
 *
 * Kept in one file so a change to the API is a change in one place. Every field here is
 * something the backend actually sends — nothing is invented on this side, and nothing the
 * backend treats as authoritative (user id, ownership, credits) is ever sent up from here.
 */

// ── Envelope ─────────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
    success: true;
    message: string;
    data: T;
}

export interface ApiFailure {
    success: false;
    code: string;
    message: string;
    errors: { field?: string; message?: string }[];
}

// ── Resources ────────────────────────────────────────────────────────────────

export interface Source {
    id: string;
    position: number;
    url: string;
    title: string;
    content: string | null;
    favicon: string | null;
    createdAt: string;
}

export interface Conversation {
    id: string;
    title: string | null;
    createdAt: string;
    updatedAt: string;
}

export type MessageRole = "user" | "assistant" | "system";

/** A persisted message, as returned when a conversation is loaded. */
export interface PersistedMessage {
    id: string;
    role: MessageRole;
    content: string;
    createdAt: string;
}

export interface CurrentUser {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    authProvider: "password" | "google";
    emailVerified: boolean;
    credits: number;
    hasPassword: boolean;
    createdAt: string;
}

// ── Chat SSE protocol ────────────────────────────────────────────────────────

export interface ChatRequest {
    query: string;
}

export interface SSEStartEvent {
    type: "start";
    conversationId: string;
}

export interface SSETokenEvent {
    type: "token";
    text: string;
}

export interface SSESourcesEvent {
    type: "sources";
    sources: Source[];
}

export interface SSEDoneEvent {
    type: "done";
    conversationId: string;
    /** Non-null only when a new conversation was created; continuing never renames. */
    title: string | null;
    creditsRemaining: number;
}

export interface SSEErrorEvent {
    type: "error";
    code: string;
    message: string;
}

/** Discriminated on `type`, so a handler cannot read a field the event does not carry. */
export type ChatStreamEvent =
    | SSEStartEvent
    | SSETokenEvent
    | SSESourcesEvent
    | SSEDoneEvent
    | SSEErrorEvent;

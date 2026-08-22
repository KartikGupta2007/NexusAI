import { request } from "./client.ts";
import type { Conversation, PersistedMessage, Source } from "../types/api.ts";

/** Sidebar list, newest activity first (the backend orders by updated_at DESC). */
export const listConversations = () =>
    request<{ conversations: Conversation[] }>("/conversations").then((data) => data.conversations);

/** A conversation and its full message history, for opening or reloading a thread. */
export const getConversation = (conversationId: string) =>
    request<{ conversation: Conversation; messages: PersistedMessage[] }>(
        `/conversations/${encodeURIComponent(conversationId)}`,
    );

/** Sources cited by one assistant message. Used when replaying a thread from the database. */
export const getMessageSources = (messageId: string) =>
    request<{ sources: Source[] }>(`/messages/${encodeURIComponent(messageId)}/sources`).then(
        (data) => data.sources,
    );

import type { PoolClient, QueryResultRow } from "pg";
import { pool, query } from "../db/pool.ts";

/**
 * Only the columns the API actually returns. `user_id` is deliberately absent: the caller
 * already knows whose conversations these are (it supplied the id), and a field we never
 * select has no business being in the row type.
 */
export interface ConversationRow {
    id: string;
    title: string | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * `id` is a **string**, not a number.
 *
 * `messages.id` is a BIGINT, and node-postgres returns int8 as a string because the range
 * exceeds Number.MAX_SAFE_INTEGER — `Number("9007199254740993")` silently yields
 * ...992. The value is passed through as a string all the way to JSON rather than being
 * coerced. Where a bigint is known to be small the project casts in SQL instead
 * (`COUNT(*)::int` in refreshToken.repository.ts); an identity primary key is not such a
 * case, so it stays a string.
 */
export interface MessageRow {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    created_at: Date;
}

/** Shape returned to clients. */
export interface PublicConversation {
    id: string;
    title: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface PublicMessage {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: Date;
}

export const toPublicConversation = (row: ConversationRow): PublicConversation => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

export const toPublicMessage = (row: MessageRow): PublicMessage => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
});

type Executor = Pick<PoolClient, "query"> | typeof pool;

const run = <T extends QueryResultRow>(
    executor: Executor | undefined,
    text: string,
    params: unknown[],
) => (executor ? executor.query<T>(text, params) : query<T>(text, params));

/**
 * Sidebar listing. Newest activity first, and no message columns — the sidebar renders
 * titles and timestamps, so joining `messages` here would read a conversation's entire
 * history to display one line of it.
 */
export const findConversationsByUserId = async (userId: string, executor?: Executor) => {
    const { rows } = await run<ConversationRow>(
        executor,
        `SELECT id, title, created_at, updated_at
           FROM conversations
          WHERE user_id = $1
       ORDER BY updated_at DESC`,
        [userId],
    );
    return rows;
};

/**
 * Ownership gate. `user_id` is part of the WHERE clause rather than something the caller
 * checks afterwards: a conversation belonging to somebody else is indistinguishable from
 * one that does not exist, because in both cases the query simply returns no rows. That is
 * what makes the endpoint IDOR-proof, and it cannot be forgotten at a call site.
 */
export const findConversationForUser = async (
    conversationId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rows } = await run<ConversationRow>(
        executor,
        `SELECT c.id, c.title, c.created_at, c.updated_at
           FROM conversations c
          WHERE c.id = $1
            AND c.user_id = $2`,
        [conversationId, userId],
    );
    return rows[0] ?? null;
};

/**
 * ORDER BY m.id ASC, never m.created_at: `messages.id` is the deterministic sequence.
 * Two messages inserted in one transaction (the user turn and the assistant reply) share
 * NOW(), so ordering by the timestamp would leave same-turn rows in an arbitrary order.
 * `messages_conversation_id_id_idx (conversation_id, id)` serves exactly this shape.
 *
 * The join to `conversations` is not needed to find the rows — `m.conversation_id` alone
 * would do. It is there so this function is safe *on its own*: ownership is re-asserted in
 * SQL, so no future caller can reach another user's messages by calling it without having
 * run the gate above first.
 */
export const findMessagesForUserConversation = async (
    conversationId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rows } = await run<MessageRow>(
        executor,
        `SELECT m.id, m.role, m.content, m.created_at
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE m.conversation_id = $1
            AND c.user_id = $2
       ORDER BY m.id ASC`,
        [conversationId, userId],
    );
    return rows;
};

/**
 * Two queries rather than one LEFT JOIN.
 *
 * The JOIN would repeat the conversation's title and timestamps on every message row, and
 * an empty conversation comes back as one row of all-NULL message columns that the mapping
 * code has to special-case. Two statements each return exactly the shape the response
 * needs. Ownership is enforced in *both*, so the second is not trusting the first.
 *
 * Returns `null` when the conversation does not exist or is not this user's — the caller
 * decides what that means over HTTP.
 */
export const findConversationWithMessages = async (
    conversationId: string,
    userId: string,
    executor?: Executor,
) => {
    const conversation = await findConversationForUser(conversationId, userId, executor);
    if (!conversation) return null;

    const messages = await findMessagesForUserConversation(conversationId, userId, executor);
    return { conversation, messages };
};
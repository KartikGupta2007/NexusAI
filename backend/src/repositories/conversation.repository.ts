import type { PoolClient, QueryResultRow } from "pg";
import { CONVERSATION_MAX_RECENT_MESSAGES } from "../constants.ts";
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
 * The tail of a conversation: the newest `limit` messages, **newest first**.
 *
 * Distinct from findMessagesForUserConversation above, which returns the whole thread in
 * chronological order for replaying a conversation to the user. This one exists to build a
 * Claude prompt, where the entire history is neither affordable nor wanted — so the LIMIT is
 * pushed into Postgres rather than fetching every row and slicing in JavaScript. On a long
 * conversation that is the difference between reading four index entries and reading
 * thousands of rows to discard all but four.
 *
 * ORDER BY m.id DESC — descending on the sequence key, not created_at. Same reasoning as the
 * ascending query: same-turn messages share NOW(), so created_at is not a total order and
 * "the last 4" by timestamp is not well defined. `messages_conversation_id_id_idx
 * (conversation_id, id)` serves this shape as a backwards index scan, so the LIMIT stops
 * after four index entries.
 *
 * Returns newest-first because that is what the SQL produces; callers that need chronological
 * order reverse it. conversationContext.services.ts is the one place that does.
 *
 * The join to `conversations` re-asserts ownership in SQL so this function is safe called on
 * its own, matching the other message query.
 */
export const findRecentMessagesForUserConversation = async (
    conversationId: string,
    userId: string,
    limit: number,
    executor?: Executor,
) => {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`limit must be a positive integer, received ${limit}`);
    }

    const { rows } = await run<MessageRow>(
        executor,
        `SELECT m.id, m.role, m.content, m.created_at
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE m.conversation_id = $1
            AND c.user_id = $2
       ORDER BY m.id DESC
          LIMIT $3`,
        [conversationId, userId, Math.min(limit, CONVERSATION_MAX_RECENT_MESSAGES)],
    );
    return rows;
};

/** Creates a conversation for `userId`. The owner comes from the session, never the client. */
export const createConversation = async (
    userId: string,
    title: string | null,
    executor?: Executor,
) => {
    const { rows } = await run<ConversationRow>(
        executor,
        `INSERT INTO conversations (user_id, title)
              VALUES ($1, $2)
           RETURNING id, title, created_at, updated_at`,
        [userId, title],
    );
    return rows[0]!;
};

/**
 * Appends a message to a conversation the user owns.
 *
 * The INSERT selects from `conversations` filtered by owner, so a caller who does not own the
 * conversation writes nothing and gets null back — ownership is a property of the write rather
 * than a check that could be skipped, and there is no window between checking and writing.
 */
export const createMessageForUserConversation = async (
    input: {
        conversationId: string;
        userId: string;
        role: "user" | "assistant" | "system";
        content: string;
    },
    executor?: Executor,
) => {
    const { rows } = await run<MessageRow>(
        executor,
        `INSERT INTO messages (conversation_id, role, content)
              SELECT c.id, $3, $4
                FROM conversations c
               WHERE c.id = $1
                 AND c.user_id = $2
           RETURNING id, role, content, created_at`,
        [input.conversationId, input.userId, input.role, input.content],
    );
    return rows[0] ?? null;
};

/** Retitles a conversation the user owns. Returns null when it is not theirs. */
export const renameConversation = async (
    conversationId: string,
    userId: string,
    title: string,
    executor?: Executor,
) => {
    const { rows } = await run<ConversationRow>(
        executor,
        `UPDATE conversations
                SET title = $3
              WHERE id = $1
                AND user_id = $2
          RETURNING id, title, created_at, updated_at`,
        [conversationId, userId, title],
    );
    return rows[0] ?? null;
};

/**
 * Bumps `updated_at` so the sidebar orders by real activity.
 *
 * Inserting a message does not touch the conversation row — 002_chat.sql deliberately left that
 * out of the schema rather than firing a trigger twice per turn — so the pipeline does it once,
 * explicitly, here. The BEFORE UPDATE trigger sets the timestamp.
 */
export const touchConversation = async (
    conversationId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rowCount } = await run(
        executor,
        `UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND user_id = $2`,
        [conversationId, userId],
    );
    return (rowCount ?? 0) > 0;
};

/**
 * Resolves one message by id, scoped to its owner.
 *
 * `user_id` is in the WHERE clause via the conversation, so a message belonging to somebody
 * else returns no rows and is indistinguishable from one that does not exist. Callers that
 * need to act on a single message — attaching sources to it, for instance — use this as the
 * ownership gate rather than checking afterwards.
 *
 * Returns the role as well, because whether a message may carry web sources depends on it.
 */
export const findMessageForUser = async (
    messageId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rows } = await run<MessageRow & { conversation_id: string }>(
        executor,
        `SELECT m.id, m.role, m.content, m.created_at, m.conversation_id
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = $1::bigint
            AND c.user_id = $2`,
        [messageId, userId],
    );
    return rows[0] ?? null;
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
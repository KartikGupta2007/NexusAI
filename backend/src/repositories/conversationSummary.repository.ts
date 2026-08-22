import type { PoolClient, QueryResultRow } from "pg";
import { pool, query } from "../db/pool.ts";

/**
 * `last_message_id` is a string: it is a BIGINT (referencing messages.id) and node-postgres
 * returns int8 as a string because the range exceeds Number.MAX_SAFE_INTEGER. It is passed
 * through unconverted, exactly as MessageRow.id is in conversation.repository.ts.
 */
export interface ConversationSummaryRow {
    conversation_id: string;
    summary: string;
    last_message_id: string | null;
    message_count: number;
    created_at: Date;
    updated_at: Date;
}

/** Shape returned to clients. */
export interface PublicConversationSummary {
    conversationId: string;
    summary: string;
    lastMessageId: string | null;
    messageCount: number;
    createdAt: Date;
    updatedAt: Date;
}

export const toPublicConversationSummary = (
    row: ConversationSummaryRow,
): PublicConversationSummary => ({
    conversationId: row.conversation_id,
    summary: row.summary,
    lastMessageId: row.last_message_id,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

type Executor = Pick<PoolClient, "query"> | typeof pool;

const run = <T extends QueryResultRow>(
    executor: Executor | undefined,
    text: string,
    params: unknown[],
) => (executor ? executor.query<T>(text, params) : query<T>(text, params));

const SUMMARY_COLUMNS = `
    conversation_id, summary, last_message_id, message_count, created_at, updated_at
`;

/**
 * Reads a conversation's summary, scoped to its owner.
 *
 * `conversation_summaries` has no user_id of its own, so ownership is reached by joining
 * `conversations`. The join is the authorisation check: a conversation belonging to another
 * user yields no rows, indistinguishably from one that has no summary yet. Callers that need
 * to tell those apart must check the conversation separately — see the service.
 *
 * Returns null when there is no summary, which is the normal state for a new conversation.
 */
export const findSummaryByConversationId = async (
    conversationId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rows } = await run<ConversationSummaryRow>(
        executor,
        `SELECT s.conversation_id, s.summary, s.last_message_id,
                s.message_count, s.created_at, s.updated_at
           FROM conversation_summaries s
           JOIN conversations c ON c.id = s.conversation_id
          WHERE s.conversation_id = $1
            AND c.user_id = $2`,
        [conversationId, userId],
    );
    return rows[0] ?? null;
};

/**
 * Creates or rewrites the summary in one statement.
 *
 * The INSERT takes its row from a SELECT over `conversations` filtered by owner, so a caller
 * who does not own the conversation inserts nothing and gets null back — ownership is
 * enforced by the write itself rather than by a check that a future caller could skip. A
 * separate "does this user own it" round-trip would also leave a race between check and write.
 *
 * ON CONFLICT makes this an upsert on the natural key, so the summariser does not need to
 * know whether a summary already exists. The BEFORE UPDATE trigger refreshes updated_at on
 * the conflict path; created_at is left at its original value.
 */
export const upsertConversationSummary = async (
    input: {
        conversationId: string;
        userId: string;
        summary: string;
        lastMessageId: string | number | null;
        messageCount: number;
    },
    executor?: Executor,
) => {
    const { rows } = await run<ConversationSummaryRow>(
        executor,
        `INSERT INTO conversation_summaries
                     (conversation_id, summary, last_message_id, message_count)
              SELECT c.id, $3, $4, $5
                FROM conversations c
               WHERE c.id = $1
                 AND c.user_id = $2
         ON CONFLICT (conversation_id) DO UPDATE
                 SET summary         = EXCLUDED.summary,
                     last_message_id = EXCLUDED.last_message_id,
                     message_count   = EXCLUDED.message_count
           RETURNING ${SUMMARY_COLUMNS}`,
        [
            input.conversationId,
            input.userId,
            input.summary,
            input.lastMessageId,
            input.messageCount,
        ],
    );
    return rows[0] ?? null;
};

/** Drops a conversation's summary, e.g. to force a full re-summarisation. */
export const deleteConversationSummary = async (
    conversationId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rowCount } = await run(
        executor,
        `DELETE FROM conversation_summaries s
               USING conversations c
               WHERE s.conversation_id = $1
                 AND c.id = s.conversation_id
                 AND c.user_id = $2`,
        [conversationId, userId],
    );
    return (rowCount ?? 0) > 0;
};

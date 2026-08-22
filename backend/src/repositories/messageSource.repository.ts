import type { PoolClient, QueryResultRow } from "pg";
import { pool, query, withTransaction } from "../db/pool.ts";

/**
 * Only the columns the API returns. `message_id` is deliberately absent: every query here is
 * already scoped to one message that the caller named, so echoing it back on each row adds
 * nothing — the same reasoning that keeps `user_id` out of ConversationRow.
 *
 * `position` is a plain number: it is int4, which node-postgres returns as a JS number. Only
 * `messages.id` is a BIGINT, and that stays a string everywhere in this project.
 */
export interface MessageSourceRow {
    id: string;
    position: number;
    url: string;
    title: string;
    content: string | null;
    favicon: string | null;
    created_at: Date;
}

/** Shape returned to clients. */
export interface PublicMessageSource {
    id: string;
    position: number;
    url: string;
    title: string;
    content: string | null;
    favicon: string | null;
    createdAt: Date;
}

/**
 * One source to persist, in provider-neutral terms.
 *
 * Deliberately not shaped after any search SDK. Tavily — or whatever replaces it — is mapped
 * into this at the boundary, so a provider change never reaches the database layer.
 */
export interface MessageSourceInput {
    position: number;
    url: string;
    title: string;
    content?: string | null;
    favicon?: string | null;
}

export const toPublicMessageSource = (row: MessageSourceRow): PublicMessageSource => ({
    id: row.id,
    position: row.position,
    url: row.url,
    title: row.title,
    content: row.content,
    favicon: row.favicon,
    createdAt: row.created_at,
});

type Executor = Pick<PoolClient, "query"> | typeof pool;

const run = <T extends QueryResultRow>(
    executor: Executor | undefined,
    text: string,
    params: unknown[],
) => (executor ? executor.query<T>(text, params) : query<T>(text, params));

const SOURCE_COLUMNS = `id, position, url, title, content, favicon, created_at`;

const byPosition = (a: MessageSourceRow, b: MessageSourceRow) => a.position - b.position;

/**
 * Every source attached to one message, in citation order.
 *
 * The two joins are the authorisation check, not navigation: `message_sources` has no owner
 * column of its own, so ownership is established by walking up to `conversations.user_id`. A
 * message belonging to another user matches nothing and is indistinguishable from a message
 * that does not exist — which is what keeps this from being an oracle for other users' ids.
 *
 * ORDER BY position ASC, never created_at: a batch is inserted in a single statement and so
 * shares NOW(), leaving the timestamp useless as a tie-breaker.
 */
export const findMessageSourcesForUserMessage = async (
    messageId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rows } = await run<MessageSourceRow>(
        executor,
        `SELECT ms.id, ms.position, ms.url, ms.title, ms.content, ms.favicon, ms.created_at
           FROM message_sources ms
           JOIN messages m ON m.id = ms.message_id
           JOIN conversations c ON c.id = m.conversation_id
          WHERE ms.message_id = $1::bigint
            AND c.user_id = $2
       ORDER BY ms.position ASC`,
        [messageId, userId],
    );
    return rows;
};

/**
 * Writes a batch of sources in one round trip.
 *
 * The rows come from UNNEST over five parallel arrays rather than a generated VALUES list, so
 * the statement text is fixed no matter how many sources arrive and every URL, title and
 * snippet travels as a bound parameter. Nothing is interpolated into SQL.
 *
 * The INSERT selects from `messages` joined to `conversations` filtered by owner, so a caller
 * who does not own the message inserts nothing and gets an empty array back — ownership is a
 * property of the write itself rather than a check a future caller could skip. It also closes
 * the gap a separate "does this user own it" round trip would leave between check and write.
 *
 * Returns the inserted rows in citation order.
 */
export const insertMessageSources = async (
    input: { messageId: string; userId: string; sources: MessageSourceInput[] },
    executor?: Executor,
) => {
    if (input.sources.length === 0) return [];

    const { rows } = await run<MessageSourceRow>(
        executor,
        `INSERT INTO message_sources (message_id, position, url, title, content, favicon)
              SELECT m.id, v.position, v.url, v.title, v.content, v.favicon
                FROM messages m
                JOIN conversations c ON c.id = m.conversation_id
          CROSS JOIN UNNEST($3::int[], $4::text[], $5::text[], $6::text[], $7::text[])
                     AS v(position, url, title, content, favicon)
               WHERE m.id = $1::bigint
                 AND c.user_id = $2
           RETURNING ${SOURCE_COLUMNS}`,
        [
            input.messageId,
            input.userId,
            input.sources.map((s) => s.position),
            input.sources.map((s) => s.url),
            input.sources.map((s) => s.title),
            input.sources.map((s) => s.content ?? null),
            input.sources.map((s) => s.favicon ?? null),
        ],
    );
    // RETURNING has no ORDER BY, so citation order is restored here.
    return rows.sort(byPosition);
};

/** Drops every source on a message, scoped to its owner. Returns how many rows went. */
export const deleteMessageSourcesForUserMessage = async (
    messageId: string,
    userId: string,
    executor?: Executor,
) => {
    const { rowCount } = await run(
        executor,
        `DELETE FROM message_sources ms
               USING messages m, conversations c
               WHERE ms.message_id = $1::bigint
                 AND m.id = ms.message_id
                 AND c.id = m.conversation_id
                 AND c.user_id = $2`,
        [messageId, userId],
    );
    return rowCount ?? 0;
};

/**
 * Swaps a message's sources for a new set, atomically.
 *
 * Delete-then-insert rather than an upsert on (message_id, position): a second search can
 * return fewer sources than the first, and an upsert would silently strand the extra rows from
 * the previous run at the tail of the citation list. Replacing the whole set is the only
 * version that leaves exactly what was passed in.
 *
 * The transaction matters because the two statements are individually valid but jointly
 * destructive: a failure between them would leave the message with no sources at all rather
 * than with its previous ones.
 */
export const replaceMessageSources = async (input: {
    messageId: string;
    userId: string;
    sources: MessageSourceInput[];
}) =>
    withTransaction(async (client) => {
        await deleteMessageSourcesForUserMessage(input.messageId, input.userId, client);
        return insertMessageSources(input, client);
    });

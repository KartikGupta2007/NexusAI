import type { PoolClient, QueryResultRow } from "pg";
import { pool, query } from "../db/pool.ts";

export interface RefreshTokenRow {
    token_hash: string;
    user_id: string;
    family_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    replaced_by: string | null;
}

type Executor = Pick<PoolClient, "query"> | typeof pool;

const run = <T extends QueryResultRow = RefreshTokenRow>(
    executor: Executor | undefined,
    text: string,
    params: unknown[],
) => (executor ? executor.query<T>(text, params) : query<T>(text, params));

export const storeRefreshToken = async (
    input: {
        tokenHash: string;
        userId: string;
        familyId: string;
        expiresAt: Date;
        userAgent: string | null;
        ipAddress: string | null;
    },
    executor?: Executor,
) => {
    await run(
        executor,
        `INSERT INTO refresh_tokens (token_hash, user_id, family_id, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            input.tokenHash,
            input.userId,
            input.familyId,
            input.expiresAt,
            input.userAgent,
            input.ipAddress,
        ],
    );
};

export const findRefreshToken = async (tokenHash: string, executor?: Executor) => {
    const { rows } = await run<RefreshTokenRow>(
        executor,
        `SELECT token_hash, user_id, family_id, expires_at, revoked_at, replaced_by
           FROM refresh_tokens
          WHERE token_hash = $1
          FOR UPDATE`,
        [tokenHash],
    );
    return rows[0] ?? null;
};

/** Marks a token consumed by its successor. Returns false if it was already revoked. */
export const rotateRefreshToken = async (
    oldTokenHash: string,
    newTokenHash: string,
    executor?: Executor,
) => {
    const { rowCount } = await run(
        executor,
        `UPDATE refresh_tokens
            SET revoked_at = NOW(), replaced_by = $2
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [oldTokenHash, newTokenHash],
    );
    return (rowCount ?? 0) > 0;
};

/** Called on refresh-token reuse: the whole rotation chain is assumed compromised. */
export const revokeFamily = async (familyId: string, executor?: Executor) => {
    const { rowCount } = await run(
        executor,
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL`,
        [familyId],
    );
    return rowCount ?? 0;
};

export const revokeAllForUser = async (userId: string, executor?: Executor) => {
    const { rowCount } = await run(
        executor,
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
    );
    return rowCount ?? 0;
};

export interface SessionRow {
    family_id: string;
    signed_in_at: Date;
    last_used_at: Date;
    expires_at: Date;
    refresh_count: number;
    user_agent: string | null;
    ip_address: string | null;
}

/**
 * One row per *device*, not per token.
 *
 * A login starts a rotation family and every refresh appends a token to it, so the family
 * is the durable identity of a signed-in device. Aggregating by `family_id` turns the
 * token log into the session list a user expects to see:
 *   - signed_in_at  — the first token in the chain, i.e. when this device logged in
 *   - last_used_at  — the newest token, i.e. when it last refreshed
 *   - user_agent / ip_address — taken from the newest token, so a device that moved
 *     networks shows where it is now rather than where it started
 *
 * HAVING keeps only families with a live token: a revoked or fully expired chain is a
 * session that has ended and must not appear as active.
 */
export const listActiveSessions = async (userId: string, executor?: Executor) => {
    const { rows } = await run<SessionRow>(
        executor,
        `SELECT
                 family_id,
                 MIN(created_at)                                     AS signed_in_at,
                 MAX(created_at)                                     AS last_used_at,
                 MAX(expires_at)                                     AS expires_at,
                 COUNT(*)::int                                       AS refresh_count,
                 (ARRAY_AGG(user_agent ORDER BY created_at DESC))[1] AS user_agent,
                 (ARRAY_AGG(ip_address ORDER BY created_at DESC))[1] AS ip_address
               FROM refresh_tokens
              WHERE user_id = $1
           GROUP BY family_id
             HAVING BOOL_OR(revoked_at IS NULL AND expires_at > NOW())
           ORDER BY MAX(created_at) DESC`,
        [userId],
    );
    return rows;
};

/**
 * Revokes one device's session.
 *
 * `user_id` is in the WHERE clause, not just checked beforehand: without it, any
 * authenticated user who learned another user's family id could sign them out. Scoping
 * the write itself makes that impossible rather than merely unlikely.
 */
export const revokeFamilyForUser = async (
    userId: string,
    familyId: string,
    executor?: Executor,
) => {
    const { rowCount } = await run(
        executor,
        `UPDATE refresh_tokens
            SET revoked_at = NOW()
          WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL`,
        [userId, familyId],
    );
    return rowCount ?? 0;
};

/** Housekeeping: expired rows are dead weight once they can no longer be presented. */
export const deleteExpiredTokens = async (executor?: Executor) => {
    const { rowCount } = await run(
        executor,
        `DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL '7 days'`,
        [],
    );
    return rowCount ?? 0;
};
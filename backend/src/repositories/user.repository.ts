import type { PoolClient, QueryResultRow } from "pg";
import { pool, query } from "../db/pool.ts";

export interface UserRow {
    id: string;
    email: string;
    password_hash: string | null;
    name: string | null;
    avatar_url: string | null;
    auth_provider: "password" | "google";
    neon_auth_user_id: string | null;
    email_verified: boolean;
    credits: number;
    created_at: Date;
    updated_at: Date;
}

/** Shape returned to clients — never leaks password_hash. */
export interface PublicUser {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    authProvider: "password" | "google";
    emailVerified: boolean;
    credits: number;
    hasPassword: boolean;
    createdAt: Date;
}

export const toPublicUser = (user: UserRow): PublicUser => ({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    authProvider: user.auth_provider,
    emailVerified: user.email_verified,
    credits: user.credits,
    hasPassword: user.password_hash !== null,
    createdAt: user.created_at,
});

const USER_COLUMNS = `
    id, email, password_hash, name, avatar_url, auth_provider,
    neon_auth_user_id, email_verified, credits, created_at, updated_at
`;

type Executor = Pick<PoolClient, "query"> | typeof pool;

const run = <T extends QueryResultRow = UserRow>(
    executor: Executor | undefined,
    text: string,
    params: unknown[],
) => (executor ? executor.query<T>(text, params) : query<T>(text, params));

export const findUserByEmail = async (email: string, executor?: Executor) => {
    const { rows } = await run<UserRow>(
        executor,
        `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
        [email],
    );
    return rows[0] ?? null;
};

export const findUserById = async (id: string, executor?: Executor) => {
    const { rows } = await run<UserRow>(
        executor,
        `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
        [id],
    );
    return rows[0] ?? null;
};

export const findUserByNeonAuthId = async (neonAuthUserId: string, executor?: Executor) => {
    const { rows } = await run<UserRow>(
        executor,
        `SELECT ${USER_COLUMNS} FROM users WHERE neon_auth_user_id = $1`,
        [neonAuthUserId],
    );
    return rows[0] ?? null;
};

export const createPasswordUser = async (
    input: { email: string; passwordHash: string; name: string | null; credits: number },
    executor?: Executor,
) => {
    const { rows } = await run<UserRow>(
        executor,
        `INSERT INTO users (email, password_hash, name, auth_provider, credits)
         VALUES ($1, $2, $3, 'password', $4)
         RETURNING ${USER_COLUMNS}`,
        [input.email, input.passwordHash, input.name, input.credits],
    );
    return rows[0]!;
};

export const createGoogleUser = async (
    input: {
        email: string;
        neonAuthUserId: string;
        name: string | null;
        avatarUrl: string | null;
        emailVerified: boolean;
        credits: number;
    },
    executor?: Executor,
) => {
    const { rows } = await run<UserRow>(
        executor,
        `INSERT INTO users (email, neon_auth_user_id, name, avatar_url, email_verified, auth_provider, credits)
         VALUES ($1, $2, $3, $4, $5, 'google', $6)
         RETURNING ${USER_COLUMNS}`,
        [
            input.email,
            input.neonAuthUserId,
            input.name,
            input.avatarUrl,
            input.emailVerified,
            input.credits,
        ],
    );
    return rows[0]!;
};

/**
 * Attaches a Neon Auth identity to an existing local account and backfills any profile
 * fields we do not already have. COALESCE keeps user-set values from being overwritten.
 */
export const linkNeonAuthIdentity = async (
    input: {
        userId: string;
        neonAuthUserId: string;
        name: string | null;
        avatarUrl: string | null;
        emailVerified: boolean;
    },
    executor?: Executor,
) => {
    const { rows } = await run<UserRow>(
        executor,
        `UPDATE users
            SET neon_auth_user_id = $2,
                name              = COALESCE(name, $3),
                avatar_url        = COALESCE(avatar_url, $4),
                email_verified    = email_verified OR $5
          WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
        [input.userId, input.neonAuthUserId, input.name, input.avatarUrl, input.emailVerified],
    );
    return rows[0]!;
};

export const updatePasswordHash = async (
    userId: string,
    passwordHash: string,
    executor?: Executor,
) => {
    const { rows } = await run<UserRow>(
        executor,
        `UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [userId, passwordHash],
    );
    return rows[0] ?? null;
};

/**
 * Outcome of an attempted deduction. A discriminated union so the caller cannot read `remaining`
 * without having checked that the charge actually happened.
 */
export type CreditDeduction =
    | { ok: true; remaining: number }
    | { ok: false; reason: "insufficient"; credits: number }
    | { ok: false; reason: "not_found" };

/**
 * Charges `amount` credits, atomically.
 *
 * `AND credits >= $2` is inside the UPDATE on purpose. A read-then-check-then-write would let two
 * concurrent requests both observe a sufficient balance and both charge it. Here the guard is a
 * qual on the row being updated, so when two transactions race, the second blocks on the row lock
 * and Postgres re-evaluates that qual against the *updated* row before proceeding — the loser
 * matches nothing and reports insufficient. No advisory lock or SELECT ... FOR UPDATE needed.
 *
 * `CHECK (credits >= 0)` on the column is the backstop: even a bug in this predicate could not
 * persist a negative balance.
 *
 * A zero-row result is ambiguous, so it is classified with a second read. That query is only ever
 * reached on the failure path, and being non-atomic there is harmless: it decides an error message,
 * not whether money moved.
 */
export const deductUserCredits = async (
    userId: string,
    amount: number,
    executor?: Executor,
): Promise<CreditDeduction> => {
    if (!Number.isInteger(amount) || amount <= 0) {
        // A negative amount would turn `credits - $2` into a top-up.
        throw new Error(`credit amount must be a positive integer, received ${amount}`);
    }

    const { rows } = await run<{ credits: number }>(
        executor,
        `UPDATE users
                SET credits = credits - $2
              WHERE id = $1
                AND credits >= $2
          RETURNING credits`,
        [userId, amount],
    );

    if (rows[0]) return { ok: true, remaining: rows[0].credits };

    const { rows: existing } = await run<{ credits: number }>(
        executor,
        `SELECT credits FROM users WHERE id = $1`,
        [userId],
    );

    return existing[0]
        ? { ok: false, reason: "insufficient", credits: existing[0].credits }
        : { ok: false, reason: "not_found" };
};

/** Current balance, for display. Reads only — never use this to gate a charge. */
export const findUserCredits = async (userId: string, executor?: Executor) => {
    const { rows } = await run<{ credits: number }>(
        executor,
        `SELECT credits FROM users WHERE id = $1`,
        [userId],
    );
    return rows[0]?.credits ?? null;
};

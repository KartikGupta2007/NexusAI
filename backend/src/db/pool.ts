import pg from "pg";
import { env } from "../config/env.ts";
import { normalizeSslMode } from "./connectionString.ts";

const { Pool } = pg;

/**
 * Neon terminates idle connections when a compute scales to zero, so `idleTimeoutMillis`
 * is kept well below that and pool errors are swallowed rather than crashing the process.
 * `DATABASE_URL` is the -pooler (PgBouncer) endpoint; migrations use the direct URL.
 */
export const pool = new Pool({
    connectionString: normalizeSslMode(env.DATABASE_URL),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
});

pool.on("error", (error) => {
    console.error("[db] idle client error:", error.message);
});

export type Queryable = Pick<pg.PoolClient, "query">;

export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
) => pool.query<T>(text, params as unknown[]);

/** Runs `fn` inside a transaction, rolling back on any throw. */
export const withTransaction = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch (rollbackError) {
            console.error("[db] rollback failed:", (rollbackError as Error).message);
        }
        throw error;
    } finally {
        client.release();
    }
};

export const closePool = () => pool.end();

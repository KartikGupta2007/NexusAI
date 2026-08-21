import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { env } from "../config/env.ts";
import { normalizeSslMode } from "./connectionString.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Applies every unapplied .sql file in migrations/ in filename order, each in its own
 * transaction, over the direct (non-pooled) connection — PgBouncer's transaction mode
 * cannot run the session-level statements that DDL scripts rely on.
 */
export const runMigrations = async (): Promise<string[]> => {
    const client = new pg.Client({ connectionString: normalizeSslMode(env.migrationDatabaseUrl) });
    await client.connect();

    const applied: string[] = [];

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name       TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
        const done = new Set(rows.map((row) => row.name));

        const files = (await readdir(MIGRATIONS_DIR))
            .filter((file) => file.endsWith(".sql"))
            .sort();

        for (const file of files) {
            if (done.has(file)) continue;

            const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
                await client.query("COMMIT");
                applied.push(file);
                console.log(`[migrate] applied ${file}`);
            } catch (error) {
                await client.query("ROLLBACK");
                throw new Error(`Migration ${file} failed: ${(error as Error).message}`, {
                    cause: error,
                });
            }
        }

        if (applied.length === 0) console.log("[migrate] database already up to date");
        return applied;
    } finally {
        await client.end();
    }
};

// `npm run migrate` runs this file directly; the server imports runMigrations() instead.
// pathToFileURL (not a `file://` template) so paths containing spaces still match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runMigrations()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
            console.error("[migrate] failed:", error);
            process.exit(1);
        });
}

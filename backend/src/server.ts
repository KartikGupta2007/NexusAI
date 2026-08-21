import app from "./app.ts";
import { env } from "./config/env.ts";
import { runMigrations } from "./db/migrate.ts";
import { closePool, pool } from "./db/pool.ts";
import { deleteExpiredTokens } from "./repositories/refreshToken.repository.ts";

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const start = async () => {
    await runMigrations();
    await pool.query("SELECT 1");
    console.log(`[db] connected (branch ${env.NEON_BRANCH ?? "unknown"})`);

    const server = app.listen(env.PORT, env.HOST, () => {
        console.log(`Server is running at http://${env.HOST}:${env.PORT} [${env.NODE_ENV}]`);
    });

    const cleanup = setInterval(() => {
        deleteExpiredTokens()
            .then((count) => {
                if (count > 0) console.log(`[auth] pruned ${count} expired refresh token(s)`);
            })
            .catch((error: unknown) => console.error("[auth] token cleanup failed:", error));
    }, CLEANUP_INTERVAL_MS);
    cleanup.unref();

    const shutdown = (signal: string) => {
        console.log(`\n[server] ${signal} received, shutting down`);
        clearInterval(cleanup);
        server.close(() => {
            closePool()
                .catch((error: unknown) => console.error("[db] pool shutdown failed:", error))
                .finally(() => process.exit(0));
        });
        // Do not let an in-flight stream hold the process open forever.
        setTimeout(() => process.exit(1), 10_000).unref();
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
};

start().catch((error: unknown) => {
    console.error("[server] failed to start:", error);
    process.exit(1);
});

import app from "./app.ts";
import { env } from "./config/env.ts";
import { runMigrations } from "./db/migrate.ts";
import { closePool, pool } from "./db/pool.ts";
import { deleteExpiredTokens } from "./repositories/refreshToken.repository.ts";
import { warmUpEmbeddingModel } from "./services/embedding.services.ts";

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const start = async () => {
    await runMigrations();
    await pool.query("SELECT 1");
    console.log(`[db] connected (branch ${env.NEON_BRANCH ?? "unknown"})`);

    const server = app.listen(env.PORT, env.HOST, () => {
        console.log(`Server is running at http://${env.HOST}:${env.PORT} [${env.NODE_ENV}]`);
    });

    /**
     * Pay the embedding model's one-off load at boot rather than inside the first search.
     *
     * Started after listen() rather than awaited before it: the weights are ~570 MB on a cold
     * disk, and a platform health check waiting on that would fail a deploy that is perfectly
     * fine. Serving first means /health answers straight away while this proceeds behind it.
     *
     * Production only. `tsx watch` restarts on every save, and loading the model each time would
     * make development unusable; run with NODE_ENV=production to exercise this path locally.
     *
     * A failure is logged, not fatal: auth, chat and history need no embeddings, and
     * loadExtractor() drops its cached promise on failure so the next search retries the
     * download. What this does surface is an instance too small to hold the model — that OOM
     * kills the process here, during deploy, where it is loud, instead of inside a user's
     * search a day later.
     */
    if (env.isProduction) {
        const startedAt = Date.now();
        console.log("[embeddings] warming up the model");
        void warmUpEmbeddingModel().then(
            () => console.log(`[embeddings] model ready in ${Date.now() - startedAt}ms`),
            (error: unknown) =>
                console.error("[embeddings] warm-up failed; search will retry per request:", error),
        );
    }

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

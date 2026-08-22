import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { z } from "zod";
import { DEFAULT_USER_CREDITS } from "../constants.ts";

/**
 * Durations are accepted as `30s`, `15m`, `1d`, ... or as a bare number of seconds.
 * Everything downstream (cookie maxAge, refresh_tokens.expires_at) needs milliseconds,
 * so we normalise once here instead of re-parsing at every call site.
 */
const DURATION_RE = /^(\d+)\s*(ms|s|m|h|d)?$/i;

const UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

export const durationToMs = (value: string): number => {
    const match = DURATION_RE.exec(value.trim());
    if (!match) {
        throw new Error(`Invalid duration "${value}". Use formats like "15m", "1d" or "3600".`);
    }
    const amount = Number(match[1]);
    const unit = (match[2] ?? "s").toLowerCase();
    return amount * (UNIT_MS[unit] ?? 1_000);
};

const duration = z.string().min(1).refine(
    (value) => DURATION_RE.test(value.trim()),
    { message: 'Must be a duration like "15m", "1d" or a number of seconds' },
);

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3003),
    HOST: z.string().min(1).default("127.0.0.1"),

    // Pooled URL for request traffic, unpooled for migrations (PgBouncer in transaction
    // mode cannot run session-level statements). Falls back to the pooled one if unset.
    DATABASE_URL: z.string().min(1),
    DATABASE_URL_UNPOOLED: z.string().min(1).optional(),
    NEON_BRANCH: z.string().min(1).optional(),

    ACCESS_TOKEN_SECRET: z.string().min(32, "ACCESS_TOKEN_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_EXPIRY: duration.default("15m"),
    REFRESH_TOKEN_SECRET: z.string().min(32, "REFRESH_TOKEN_SECRET must be at least 32 characters"),
    REFRESH_TOKEN_EXPIRY: duration.default("10d"),

    // Neon Auth (Managed Better Auth) — powers Google sign-in.
    NEON_AUTH_BASE_URL: z.string().min(1),
    NEON_AUTH_JWKS_URL: z.string().min(1).optional(),

    BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
    SIGNUP_CREDITS: z.coerce.number().int().min(0).default(DEFAULT_USER_CREDITS),

    // Comma-separated allowlist. Credentialed CORS cannot use "*", so this must be explicit.
    CORS_ORIGINS: z.string().default("http://localhost:5173"),
    COOKIE_DOMAIN: z.string().min(1).optional(),

    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    TAVILY_API_KEY: z.string().min(1).optional(),

    // Where the local embedding model's weights are cached. No API key: BGE-M3 runs
    // in-process. Optional because a sane default is derived below; set it to move the
    // ~570 MB download onto another volume, or to a warm path baked into a container image.
    EMBEDDING_CACHE_DIR: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    const issues = parsed.error.issues
        .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
    ...raw,
    isProduction: raw.NODE_ENV === "production",
    migrationDatabaseUrl: raw.DATABASE_URL_UNPOOLED ?? raw.DATABASE_URL,
    accessTokenTtlMs: durationToMs(raw.ACCESS_TOKEN_EXPIRY),
    refreshTokenTtlMs: durationToMs(raw.REFRESH_TOKEN_EXPIRY),
    neonAuthBaseUrl: raw.NEON_AUTH_BASE_URL.replace(/\/+$/, ""),
    neonAuthJwksUrl:
        raw.NEON_AUTH_JWKS_URL ??
        `${raw.NEON_AUTH_BASE_URL.replace(/\/+$/, "")}/.well-known/jwks.json`,
    corsOrigins: raw.CORS_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    /**
     * Defaults to <backend>/.model-cache rather than transformers.js's own default, which
     * is inside node_modules/@huggingface/transformers/.cache — a directory that any
     * `npm ci` or `rm -rf node_modules` deletes, taking the 570 MB download with it.
     * Resolved from this file's location so the path does not depend on the cwd.
     */
    embeddingCacheDir:
        raw.EMBEDDING_CACHE_DIR ??
        join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".model-cache"),
} as const;

export type Env = typeof env;

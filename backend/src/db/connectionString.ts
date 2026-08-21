/**
 * Neon hands out URLs with `sslmode=require`. `pg` currently treats that as `verify-full`
 * but warns that it will fall back to weaker libpq semantics in pg v9, so we pin the
 * strict mode explicitly. Same behaviour as today, minus the startup warning, and no
 * silent downgrade on the next major.
 */
export const normalizeSslMode = (connectionString: string): string => {
    try {
        const url = new URL(connectionString);
        const sslmode = url.searchParams.get("sslmode");
        if (sslmode && ["require", "prefer", "verify-ca"].includes(sslmode)) {
            url.searchParams.set("sslmode", "verify-full");
        }
        return url.toString();
    } catch {
        // Not a parseable URL (e.g. a libpq key=value DSN); hand it back untouched.
        return connectionString;
    }
};

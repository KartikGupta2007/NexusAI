import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The architecture boundary, asserted against the source itself.
 *
 * NexusAI is layered browser → NexusAI backend → (Neon Auth, Postgres, Tavily, Claude). Every
 * other test in this suite exercises behaviour; this one exercises the *shape*, because the way
 * that boundary breaks is not a failing feature — it is a plausible-looking import that quietly
 * gives the browser a second way to reach a backend service.
 *
 * So these read files rather than run code. A test that called the API could not notice a Neon
 * SDK sitting unused in package.json, or an env var read on a path it did not happen to take.
 */

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = join(frontendRoot, "src");

/** Every source file under src/, excluding this suite's own files. */
const sourceFiles = (): string[] => {
    const found: string[] = [];
    const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                found.push(path);
            }
        }
    };
    walk(srcRoot);
    return found.filter((path) => !path.startsWith(join(srcRoot, "test")));
};

const files = sourceFiles();
const read = (path: string) => readFileSync(path, "utf8");
const named = (path: string) => relative(frontendRoot, path);

/** Files whose text matches, reported by path so a failure names the offender. */
const matching = (pattern: RegExp): string[] =>
    files.filter((path) => pattern.test(read(path))).map(named);

const packageJson = JSON.parse(read(join(frontendRoot, "package.json"))) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};
const declaredPackages = Object.keys({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
});

/**
 * `.env.example` is committed and must exist. `.env` is gitignored, so on a fresh clone — or on a
 * machine where nobody created one, which is correct here since the frontend needs no variables —
 * it is simply absent. Absent is a pass, not a failure; the assertions below are about what these
 * files must *not* contain.
 */
const envFiles = [".env", ".env.example"]
    .map((name) => {
        const path = join(frontendRoot, name);
        return { name, contents: existsSync(path) ? read(path) : null };
    })
    .filter((file): file is { name: string; contents: string } => file.contents !== null);

describe("the frontend has no auth-provider dependency", () => {
    it("finds sources to check at all", () => {
        // Guards the guard: a broken walk would make every assertion below vacuously true.
        expect(files.length).toBeGreaterThan(10);
    });

    it("never reads VITE_NEON_AUTH_URL", () => {
        expect(matching(/VITE_NEON_AUTH_URL/)).toEqual([]);
    });

    it("declares no Neon package", () => {
        // Including transitively-useful ones: @neondatabase/auth, /neon-js, /serverless.
        expect(declaredPackages.filter((name) => name.startsWith("@neondatabase/"))).toEqual([]);
    });

    it("imports no Neon SDK", () => {
        expect(matching(/@neondatabase\/|\bneon-js\b|createAuthClient/)).toEqual([]);
    });

    it("names no Neon Auth host or endpoint", () => {
        expect(matching(/neonauth|NEON_AUTH|\/sign-in\/social|well-known\/jwks/i)).toEqual([]);
    });

    it("ships no second authentication provider", () => {
        // A different SDK in place of Neon's would satisfy every test above and still put the
        // OAuth handshake back in the browser.
        expect(matching(/firebase|supabase|@clerk|auth0|@react-oauth|accounts\.google\.com|gsi\/client/i))
            .toEqual([]);
        expect(
            declaredPackages.filter((name) =>
                /firebase|supabase|clerk|auth0|oauth|better-auth/i.test(name),
            ),
        ).toEqual([]);
    });
});

describe("the frontend has no database dependency", () => {
    it("declares no database client", () => {
        expect(
            declaredPackages.filter((name) =>
                /^(pg|mysql2?|sqlite3?)$|postgres|drizzle|prisma|kysely|sequelize|typeorm/i.test(name),
            ),
        ).toEqual([]);
    });

    it("imports no database client and holds no connection string", () => {
        expect(matching(/from\s+["'](pg|postgres|drizzle-orm|@prisma\/client)["']/)).toEqual([]);
        expect(matching(/DATABASE_URL|postgres(ql)?:\/\//)).toEqual([]);
    });
});

describe("Google sign-in goes through the NexusAI backend", () => {
    it("is a navigation to the backend's own redirect endpoint", () => {
        // Both halves live in constants.ts now; api/auth.ts performs the navigation.
        const constants = read(join(srcRoot, "constants.ts"));
        expect(constants).toContain('GOOGLE_SIGN_IN_PATH = "/api/v1/user/googleAuth/start"');
        expect(read(join(srcRoot, "api", "auth.ts"))).toContain("GOOGLE_SIGN_IN_PATH");
    });

    it("addresses the API by relative path only, never an absolute host", () => {
        // constants.ts is where every path now lives, so this is the file that would carry a host.
        const constants = read(join(srcRoot, "constants.ts"));
        expect(constants).toContain('API_BASE = "/api/v1"');
        expect(constants).not.toMatch(/https?:\/\//);
        // And no source file anywhere may hard-code one.
        expect(matching(/["'`]https?:\/\/[a-z]/i)).toEqual([]);
    });

    it("holds no token, and never posts one", () => {
        // The client cannot obtain a provider token any more, so nothing may look like it does.
        expect(matching(/user\/googleAuth["'`]/)).toEqual([]);
        expect(matching(/idToken|id_token|access_token|authClient|\.signIn\.social/)).toEqual([]);
    });
});

describe("frontend environment", () => {
    it("keeps the committed template, whatever a developer's local .env does or does not exist", () => {
        // .env.example is tracked and documents that nothing is needed; .env is optional.
        expect(existsSync(join(frontendRoot, ".env.example"))).toBe(true);
        expect(envFiles.some((file) => file.name === ".env.example")).toBe(true);
    });

    it("declares no VITE_ variable, because the browser needs none", () => {
        for (const { name, contents } of envFiles) {
            const declarations = contents
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.startsWith("VITE_"));
            expect(declarations, `${name} declares browser-side variables`).toEqual([]);
        }
    });

    it("carries no secret in either env file", () => {
        for (const { name, contents } of envFiles) {
            expect(contents, name).not.toMatch(/postgres(ql)?:\/\//);
            expect(contents, name).not.toMatch(/\b(sk-ant|tvly-|npg_)/);
        }
    });

    it("reads no environment value anywhere in src", () => {
        // Nothing is configured browser-side, so nothing should be read browser-side. This is
        // what keeps a future "just one more VITE_ var" from passing review unnoticed.
        expect(matching(/import\.meta\.env\.[A-Z]/)).toEqual([]);
        // `node` is in this project's `types` for the sake of this very file (see
        // tsconfig.app.json); application code must not take advantage of it.
        expect(matching(/\bprocess\.env\b|from\s+["']node:/)).toEqual([]);
    });
});
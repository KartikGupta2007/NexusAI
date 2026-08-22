/**
 * Google sign-in over real HTTP, with Neon Auth stood in for at the network boundary.
 *
 * The boundary is the point: NexusAI reaches Neon Auth with `fetch`, so replacing `globalThis
 * .fetch` replaces Neon Auth entirely and nothing else changes — the routes, middleware,
 * validators, JWKS verification, transaction and session issuance are all the real ones, and
 * the JWT is genuinely signed and genuinely verified against a genuine remote JWKS fetch.
 *
 * What cannot be exercised here is the browser's own leg: Google's consent screen, and Neon's
 * redirect back to our callback. Those are user-agent navigations. What *is* exercised is
 * everything on either side of them, using the wire protocol confirmed against the live Neon
 * Auth service (`POST /sign-in/social` → challenge cookie + redirect URL; `GET /get-session`
 * with challenge + verifier → session cookie; `GET /token` → JWT).
 *
 * Requests are made with node:http rather than fetch because they need a `Host` header of
 * localhost:5173 — the app's own origin, which is what the redirect endpoints validate against
 * the CORS allowlist — and fetch forbids setting Host.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import app from "../../app.ts";
import { GOOGLE_FLOW_COOKIE } from "../../constants.ts";
import { closePool, query } from "../../db/pool.ts";
import { env } from "../../config/env.ts";
import { cleanupProbes, createProbeUser } from "../helpers/probe.ts";

type Json = Record<string, any>;

interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    cookies: string[];
    body: string;
    json: () => Json;
}

/** The origin the app is served from, and therefore the only one the redirects will accept. */
const APP_ORIGIN = env.corsOrigins[0]!;
const APP_HOST = new URL(APP_ORIGIN).host;

const NEON_BASE = env.neonAuthBaseUrl;
const NEON_ISSUER = new URL(NEON_BASE).origin;

const CHALLENGE = "test-challenge-value";
const VERIFIER = "test-verifier-value";
const NEON_SESSION = "test-neon-session-token";

let port = 0;
let server: ReturnType<typeof app.listen>;

/** Emails created through the controller, so they can be removed again. */
const createdEmails = new Set<string>();
const googleEmail = () => {
    const email = `google-probe-${randomUUID()}@example.com`;
    createdEmails.add(email);
    return email;
};

// ── Requests ──────────────────────────────────────────────────────────────────

const request = (
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> =>
    new Promise((resolve, reject) => {
        const payload = options.body === undefined ? null : JSON.stringify(options.body);
        const clientRequest = http.request(
            {
                host: "127.0.0.1",
                port,
                path,
                method: options.method ?? "GET",
                headers: {
                    host: APP_HOST,
                    ...(payload ? { "content-type": "application/json" } : {}),
                    ...options.headers,
                },
            },
            (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => (body += chunk));
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        cookies: response.headers["set-cookie"] ?? [],
                        body,
                        json: () => JSON.parse(body) as Json,
                    }),
                );
            },
        );
        clientRequest.on("error", reject);
        if (payload) clientRequest.write(payload);
        clientRequest.end();
    });

/** Reads one cookie's value out of a response's Set-Cookie headers. */
const cookieValue = (reply: Reply, name: string): string | null => {
    for (const header of reply.cookies) {
        const [pair] = header.split(";");
        if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
    }
    return null;
};

const cookieAttributes = (reply: Reply, name: string): string | null =>
    reply.cookies.find((header) => header.startsWith(`${name}=`)) ?? null;

// ── The Neon Auth stand-in ────────────────────────────────────────────────────

let privateKey: CryptoKey;
let jwksBody = "";
/** Every Neon Auth path the app reached, in order. */
let neonCalls: string[] = [];

interface TokenClaims {
    sub?: string;
    email?: string;
    emailVerified?: boolean;
    name?: string | null;
    image?: string | null;
    issuer?: string;
    expired?: boolean;
    key?: CryptoKey;
    banned?: boolean;
}

/** Signs a Neon Auth JWT the way Neon does: EdDSA over Ed25519, with a `kid`. */
const signNeonToken = async (claims: TokenClaims = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
        email: claims.email ?? googleEmail(),
        emailVerified: claims.emailVerified ?? true,
    };
    if (claims.name !== undefined) payload.name = claims.name;
    if (claims.image !== undefined) payload.image = claims.image;
    if (claims.banned !== undefined) payload.banned = claims.banned;

    return new SignJWT(payload)
        .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
        .setSubject(claims.sub ?? `neon-user-${randomUUID()}`)
        .setIssuer(claims.issuer ?? NEON_ISSUER)
        .setIssuedAt(claims.expired ? now - 3600 : now)
        .setExpirationTime(claims.expired ? now - 1800 : now + 900)
        .sign(claims.key ?? privateKey);
};

/** The token `GET /token` will hand back next. */
let nextNeonToken: () => Promise<string> = () => signNeonToken();

const jsonResponse = (status: number, body: unknown, setCookies: string[] = []): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: [
            ["content-type", "application/json"],
            ...setCookies.map((cookie) => ["set-cookie", cookie] as [string, string]),
        ],
    });

/**
 * Answers as Neon Auth for anything under NEON_BASE, and passes everything else — the tests'
 * own calls to the app — through to the real fetch.
 */
const installNeonAuthStub = () => {
    const realFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(NEON_BASE)) return realFetch(input, init);

        const { pathname, searchParams } = new URL(url);
        const path = pathname.slice(new URL(NEON_BASE).pathname.length).replace(/^\//, "");
        const cookie = new Headers(init?.headers ?? {}).get("cookie") ?? "";
        neonCalls.push(path);

        if (path === ".well-known/jwks.json") {
            return new Response(jwksBody, { headers: { "content-type": "application/json" } });
        }

        if (path === "sign-in/social") {
            // Both spellings, as the real service emits.
            return jsonResponse(
                200,
                { url: `${NEON_BASE}/sign-in/social/init?token=${randomUUID()}`, redirect: true },
                [
                    `__Secure-neon-auth.session_challenge=${CHALLENGE}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None`,
                    `__Secure-neon-auth.session_challange=${CHALLENGE}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=None`,
                ],
            );
        }

        if (path === "get-session") {
            const verifierMatches = searchParams.get("neon_auth_session_verifier") === VERIFIER;
            const challengeMatches = cookie.includes(`session_challenge=${CHALLENGE}`);
            // Neon answers 200 with a null body when it will not honour the exchange — the
            // absence of a session cookie is the failure signal, not the status code.
            if (!verifierMatches || !challengeMatches) return jsonResponse(200, null);
            return jsonResponse(200, { session: { id: "s1" } }, [
                `__Secure-neon-auth.session_token=${NEON_SESSION}; Path=/; HttpOnly; Secure; SameSite=None`,
            ]);
        }

        if (path === "token") {
            if (!cookie.includes(`session_token=${NEON_SESSION}`)) {
                return jsonResponse(401, { error: "unauthorized" });
            }
            return jsonResponse(200, { token: await nextNeonToken() });
        }

        if (path === "sign-out") return jsonResponse(200, { success: true });

        return jsonResponse(404, { error: `unstubbed Neon Auth path: ${path}` });
    }) as typeof fetch;
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

before(async () => {
    const { privateKey: signing, publicKey } = await generateKeyPair("EdDSA", {
        crv: "Ed25519",
        extractable: true,
    });
    privateKey = signing;
    jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), alg: "EdDSA", kid: "test-key" }] });

    installNeonAuthStub();
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
});

after(async () => {
    server.close();
    if (createdEmails.size > 0) {
        await query(`DELETE FROM users WHERE email = ANY($1::text[])`, [[...createdEmails]]);
    }
    await cleanupProbes();
    await closePool();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/v1/user/googleAuth — the token exchange, preserved", () => {
    it("exchanges a verified Neon Auth JWT for a NexusAI session", async () => {
        const email = googleEmail();
        const token = await signNeonToken({ email, name: "Gupta Ji" });

        const reply = await request("/api/v1/user/googleAuth", { method: "POST", body: { token } });

        assert.equal(reply.status, 200);
        const { data } = reply.json();
        assert.equal(data.user.email, email);
        assert.equal(data.user.authProvider, "google");
        assert.equal(data.user.credits, env.SIGNUP_CREDITS);
        assert.ok(data.accessToken, "an access token is returned for non-cookie clients");
        // …and as httpOnly cookies, which is what a browser uses.
        assert.match(cookieAttributes(reply, "accessToken") ?? "", /HttpOnly/);
        assert.match(cookieAttributes(reply, "refreshToken") ?? "", /HttpOnly/);
    });

    it("returns the same account on a second sign-in rather than a duplicate", async () => {
        const sub = `neon-user-${randomUUID()}`;
        const email = googleEmail();

        const first = await request("/api/v1/user/googleAuth", {
            method: "POST",
            body: { token: await signNeonToken({ sub, email }) },
        });
        const second = await request("/api/v1/user/googleAuth", {
            method: "POST",
            body: { token: await signNeonToken({ sub, email }) },
        });

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(second.json().data.user.id, first.json().data.user.id);
    });

    it("rejects a token that is not a JWT at all", async () => {
        const reply = await request("/api/v1/user/googleAuth", {
            method: "POST",
            body: { token: "not-a-jwt" },
        });
        assert.equal(reply.status, 401);
        assert.equal(reply.json().code, "INVALID_NEON_AUTH_TOKEN");
    });

    it("rejects a token signed by a key Neon does not publish", async () => {
        // The whole point of JWKS verification: a well-formed, unexpired, correctly-issued
        // token is still worthless if the signature is not Neon's.
        const { privateKey: attackerKey } = await generateKeyPair("EdDSA", {
            crv: "Ed25519",
            extractable: true,
        });
        const reply = await request("/api/v1/user/googleAuth", {
            method: "POST",
            body: { token: await signNeonToken({ key: attackerKey }) },
        });
        assert.equal(reply.status, 401);
        assert.equal(reply.json().code, "INVALID_NEON_AUTH_TOKEN");
    });

    it("rejects a token issued by someone other than this Neon Auth project", async () => {
        const reply = await request("/api/v1/user/googleAuth", {
            method: "POST",
            body: { token: await signNeonToken({ issuer: "https://evil.example.com" }) },
        });
        assert.equal(reply.status, 401);
        assert.equal(reply.json().code, "INVALID_NEON_AUTH_TOKEN");
    });

    it("rejects an expired token", async () => {
        const reply = await request("/api/v1/user/googleAuth", {
            method: "POST",
            body: { token: await signNeonToken({ expired: true }) },
        });
        assert.equal(reply.status, 401);
        assert.equal(reply.json().code, "INVALID_NEON_AUTH_TOKEN");
    });

    it("rejects an empty token before it reaches verification", async () => {
        const reply = await request("/api/v1/user/googleAuth", { method: "POST", body: { token: "" } });
        assert.equal(reply.status, 400);
    });
});

describe("identity comes from the token, never from the request", () => {
    it("ignores a userId, credits, role and email smuggled through the body", async () => {
        const victim = await createProbeUser();
        const victimEmail = (
            await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [victim])
        ).rows[0]!.email;

        const email = googleEmail();
        const token = await signNeonToken({ email });

        const reply = await request("/api/v1/user/googleAuth", {
            method: "POST",
            body: {
                token,
                // Everything an attacker would try to assert alongside a token of their own.
                userId: victim,
                id: victim,
                email: victimEmail,
                credits: 999_999,
                role: "admin",
                authProvider: "password",
                emailVerified: true,
            },
        });

        assert.equal(reply.status, 200);
        const { user } = reply.json().data;
        // The session belongs to the token's subject, with the standard grant.
        assert.notEqual(user.id, victim);
        assert.equal(user.email, email);
        assert.equal(user.credits, env.SIGNUP_CREDITS);
        // And the victim is untouched.
        const after = await query<{ credits: number }>(`SELECT credits FROM users WHERE id = $1`, [
            victim,
        ]);
        assert.notEqual(after.rows[0]!.credits, 999_999);
    });

    it("refuses to link a Google identity onto an existing account Google has not verified", async () => {
        // Otherwise anyone who can mint an unverified identity for a known address takes it over.
        const email = googleEmail();
        await request("/api/v1/user/register", {
            method: "POST",
            body: { email, password: "Password1", name: "Owner" },
        });

        const reply = await request("/api/v1/user/googleAuth", {
            method: "POST",
            body: { token: await signNeonToken({ email, emailVerified: false }) },
        });

        assert.equal(reply.status, 409);
        assert.equal(reply.json().code, "EMAIL_NOT_VERIFIED_FOR_LINKING");
    });
});

describe("GET /api/v1/user/googleAuth/start — the redirect out", () => {
    it("sends the browser to Neon Auth and keeps the challenge server-side", async () => {
        neonCalls = [];
        const reply = await request("/api/v1/user/googleAuth/start");

        assert.equal(reply.status, 302);
        // The browser is handed a URL; it never had to know one.
        assert.ok(
            reply.headers.location?.startsWith(NEON_BASE),
            `expected a Neon Auth URL, got ${reply.headers.location ?? "no Location header"}`,
        );
        assert.deepEqual(neonCalls, ["sign-in/social"]);

        const flow = cookieAttributes(reply, GOOGLE_FLOW_COOKIE);
        assert.ok(flow, "the flow cookie is set");
        assert.equal(cookieValue(reply, GOOGLE_FLOW_COOKIE), CHALLENGE);
        // httpOnly, and scoped to the two endpoints that use it — no script, and no other
        // route, ever sees it.
        assert.match(flow, /HttpOnly/);
        assert.match(flow, /Path=\/api\/v1\/user\/googleAuth/);
    });

    it("refuses to start from an origin that is not allowlisted", async () => {
        // Which is what stops a forged Host header turning this into an open redirect.
        const reply = await request("/api/v1/user/googleAuth/start", {
            headers: { host: "attacker.example.com" },
        });
        assert.equal(reply.status, 400);
    });
});

describe("GET /api/v1/user/googleAuth/callback — the redirect back", () => {
    const callback = (verifier: string | null, challenge: string | null) =>
        request(
            `/api/v1/user/googleAuth/callback${verifier === null ? "" : `?neon_auth_session_verifier=${verifier}`}`,
            challenge === null ? {} : { headers: { cookie: `${GOOGLE_FLOW_COOKIE}=${challenge}` } },
        );

    it("completes the handshake server-side and returns the browser signed in", async () => {
        neonCalls = [];
        const email = googleEmail();
        nextNeonToken = () => signNeonToken({ email, name: "Gupta Ji" });

        const reply = await callback(VERIFIER, CHALLENGE);

        assert.equal(reply.status, 302);
        assert.equal(reply.headers.location, `${APP_ORIGIN}/`);
        // Both exchange legs happened here, in this process, in order — plus the sign-out that
        // stops a second live session existing on the Neon side. The JWKS fetch is not asserted
        // on: createRemoteJWKSet caches keys for ten minutes, so whether it appears depends on
        // which test ran first.
        assert.deepEqual(neonCalls.slice(0, 2), ["get-session", "token"]);
        assert.ok(neonCalls.includes("sign-out"), "the Neon session is ended once it is spent");

        // The browser leaves holding a NexusAI session and nothing else.
        assert.match(cookieAttributes(reply, "accessToken") ?? "", /HttpOnly/);
        assert.match(cookieAttributes(reply, "refreshToken") ?? "", /HttpOnly/);
        // The spent challenge is cleared either way.
        assert.match(cookieAttributes(reply, GOOGLE_FLOW_COOKIE) ?? "", /Expires=Thu, 01 Jan 1970/);
        // No Neon cookie is ever handed to the browser.
        assert.equal(
            reply.cookies.some((cookie) => cookie.includes("neon-auth")),
            false,
        );

        const account = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
        assert.equal(account.rowCount, 1, "the account was created");
    });

    it("authenticates subsequent requests as that user, through requireAuth", async () => {
        const email = googleEmail();
        nextNeonToken = () => signNeonToken({ email });

        const signIn = await callback(VERIFIER, CHALLENGE);
        const accessToken = cookieValue(signIn, "accessToken");
        assert.ok(accessToken);

        // The cookie the redirect set is the credential — nothing else was needed.
        const me = await request("/api/v1/user/me", {
            headers: { cookie: `accessToken=${accessToken}` },
        });
        assert.equal(me.status, 200);
        assert.equal(me.json().data.user.email, email);

        // And the same identity reaches an authenticated non-user route.
        const conversations = await request("/api/v1/conversations", {
            headers: { cookie: `accessToken=${accessToken}` },
        });
        assert.equal(conversations.status, 200);
        assert.deepEqual(conversations.json().data.conversations, []);
    });

    it("returns to the app with a reason when there is no flow cookie", async () => {
        // A bookmarked callback, or a flow that expired. No session, and no crash.
        const reply = await callback(VERIFIER, null);

        assert.equal(reply.status, 302);
        assert.equal(reply.headers.location, `${APP_ORIGIN}/?googleAuth=incomplete`);
        assert.equal(cookieValue(reply, "accessToken"), null);
    });

    it("returns to the app with a reason when the verifier is missing", async () => {
        const reply = await callback(null, CHALLENGE);

        assert.equal(reply.status, 302);
        assert.equal(reply.headers.location, `${APP_ORIGIN}/?googleAuth=incomplete`);
        assert.equal(cookieValue(reply, "accessToken"), null);
    });

    it("issues no session when Neon Auth will not honour the exchange", async () => {
        // A verifier that does not match the challenge — a replayed or forged return.
        const reply = await callback("wrong-verifier", CHALLENGE);

        assert.equal(reply.status, 302);
        assert.equal(reply.headers.location, `${APP_ORIGIN}/?googleAuth=failed`);
        assert.equal(cookieValue(reply, "accessToken"), null);
    });

    it("does not sign anyone in when the exchange yields an unverifiable token", async () => {
        const { privateKey: attackerKey } = await generateKeyPair("EdDSA", {
            crv: "Ed25519",
            extractable: true,
        });
        nextNeonToken = () => signNeonToken({ key: attackerKey });

        const reply = await callback(VERIFIER, CHALLENGE);

        assert.equal(reply.status, 302);
        assert.equal(reply.headers.location, `${APP_ORIGIN}/?googleAuth=failed`);
        assert.equal(cookieValue(reply, "accessToken"), null);

        nextNeonToken = () => signNeonToken();
    });
});

describe("password authentication is unaffected", () => {
    it("registers, signs in, and identifies the account", async () => {
        const email = googleEmail();

        const registered = await request("/api/v1/user/register", {
            method: "POST",
            body: { email, password: "Password1", name: "Gupta Ji" },
        });
        assert.equal(registered.status, 201);
        assert.equal(registered.json().data.user.authProvider, "password");
        assert.equal(registered.json().data.user.hasPassword, true);

        const signedIn = await request("/api/v1/user/login", {
            method: "POST",
            body: { email, password: "Password1" },
        });
        assert.equal(signedIn.status, 200);

        const me = await request("/api/v1/user/me", {
            headers: { cookie: `accessToken=${cookieValue(signedIn, "accessToken")}` },
        });
        assert.equal(me.status, 200);
        assert.equal(me.json().data.user.email, email);
        assert.equal(me.json().data.user.credits, env.SIGNUP_CREDITS);
    });

    it("still rejects a wrong password", async () => {
        const email = googleEmail();
        await request("/api/v1/user/register", {
            method: "POST",
            body: { email, password: "Password1" },
        });

        const reply = await request("/api/v1/user/login", {
            method: "POST",
            body: { email, password: "WrongPassword1" },
        });
        assert.equal(reply.status, 401);
        assert.equal(reply.json().code, "INVALID_CREDENTIALS");
    });

    it("refreshes and revokes a session as before", async () => {
        const email = googleEmail();
        const signedIn = await request("/api/v1/user/register", {
            method: "POST",
            body: { email, password: "Password1" },
        });
        const refreshToken = cookieValue(signedIn, "refreshToken");

        const refreshed = await request("/api/v1/user/refresh-token", {
            method: "POST",
            body: {},
            headers: { cookie: `refreshToken=${refreshToken}` },
        });
        assert.equal(refreshed.status, 200);
        assert.notEqual(cookieValue(refreshed, "refreshToken"), refreshToken);

        // Reuse of the old token still revokes the family.
        const replayed = await request("/api/v1/user/refresh-token", {
            method: "POST",
            body: {},
            headers: { cookie: `refreshToken=${refreshToken}` },
        });
        assert.equal(replayed.status, 401);
        assert.equal(replayed.json().code, "REFRESH_TOKEN_REUSED");
    });
});

describe("requireAuth is unchanged", () => {
    it("rejects an unauthenticated request to a protected route", async () => {
        const reply = await request("/api/v1/user/me");
        assert.equal(reply.status, 401);
        assert.equal(reply.json().code, "MISSING_ACCESS_TOKEN");
    });

    it("rejects a forged access token", async () => {
        const reply = await request("/api/v1/user/me", {
            headers: { authorization: "Bearer not.a.real.token" },
        });
        assert.equal(reply.status, 401);
    });

    it("does not accept a Neon Auth token as a NexusAI access token", async () => {
        // The two token formats are deliberately separate: a Neon JWT is only ever an input to
        // /googleAuth, never a credential for the API.
        const reply = await request("/api/v1/user/me", {
            headers: { authorization: `Bearer ${await signNeonToken()}` },
        });
        assert.equal(reply.status, 401);
    });
});
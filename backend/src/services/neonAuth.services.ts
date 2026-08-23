import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Google sign-in, delegated to Neon Auth (Managed Better Auth) — from the server.
 *
 * Every call to Neon Auth is made from this process. The browser never learns
 * NEON_AUTH_BASE_URL, never loads a Neon SDK, and never holds a Neon cookie; it only
 * follows redirects it is handed and talks to the NexusAI API. Neon Auth is a backend
 * dependency of this service, exactly like Postgres, Tavily and Claude.
 *
 * The three legs of the handshake, all driven by the two /googleAuth redirect endpoints:
 *
 *   1. `POST /sign-in/social` — we ask Neon Auth to begin a Google flow and hand it the
 *      callback to return to. Neon answers with the URL to send the browser to and a
 *      *session challenge* (the PKCE-shaped half of the flow it expects back).
 *   2. `GET /get-session?neon_auth_session_verifier=…` with that challenge — run when the
 *      browser lands back on our callback. Neon matches verifier to challenge and answers
 *      with a Neon session.
 *   3. `GET /token` with that session — a short-lived Neon Auth JWT.
 *
 * The JWT is then verified against Neon's JWKS and exchanged for a NexusAI session, which
 * is the same last step `POST /googleAuth` performs for non-browser clients. Leg 2 and 3
 * mirror what @neondatabase/auth's own server proxy does (`exchangeOAuthToken` →
 * `get-session`, cookies filtered to the `__Secure-neon-auth` prefix); the wire protocol is
 * the SDK's, not one invented here.
 */

const NEON_AUTH_ORIGIN = new URL(env.neonAuthBaseUrl).origin;

/**
 * The query parameter Neon Auth appends to our callback URL, and the cookies it uses to
 * carry the flow. Names come from @neondatabase/auth: the challenge cookie is issued under
 * both the correct and a legacy misspelled name, and the server accepts either, so both are
 * replayed to keep working whichever one a given deployment keys on.
 */
export const NEON_AUTH_VERIFIER_PARAM = "neon_auth_session_verifier";
const NEON_AUTH_CHALLENGE_COOKIES = [
    "__Secure-neon-auth.session_challenge",
    "__Secure-neon-auth.session_challange",
] as const;
const NEON_AUTH_SESSION_COOKIE = "__Secure-neon-auth.session_token";

/** Reads one cookie value out of a response's Set-Cookie headers. */
const readSetCookie = (response: Response, names: readonly string[]): string | null => {
    for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        const separator = pair?.indexOf("=") ?? -1;
        if (!pair || separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (names.includes(name) && value.length > 0) return value;
    }
    return null;
};

/**
 * Calls Neon Auth. `origin` is forwarded because Neon validates the calling origin against
 * the project's trusted domains before it will start a redirect flow.
 */
const callNeonAuth = async (
    path: string,
    init: { method: "GET" | "POST"; origin: string; cookie?: string; body?: unknown },
): Promise<Response> => {
    try {
        return await fetch(`${env.neonAuthBaseUrl}/${path}`, {
            method: init.method,
            headers: {
                origin: init.origin,
                ...(init.cookie ? { cookie: init.cookie } : {}),
                ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            // Redirects are the browser's to follow, not ours: `url` in the sign-in response
            // is what we hand onward, and a 302 anywhere else is a failure to report.
            redirect: "manual",
        });
    } catch (error) {
        throw new ApiError(502, "Google sign-in is temporarily unavailable", {
            code: "NEON_AUTH_UNREACHABLE",
            cause: error,
        });
    }
};

/** What the browser needs to be sent to Google, plus the challenge to hold until it returns. */
export interface NeonGoogleHandoff {
    /** Absolute URL on the Neon Auth origin. */
    redirectUrl: string;
    /** Opaque; stored in an httpOnly cookie on our own domain for the length of the flow. */
    challenge: string;
}

/**
 * Begins a Google flow and returns where to send the browser.
 *
 * `callbackUrl` must be a NexusAI URL — it is where Neon returns the browser once Google is
 * done, and it is registered against the project's trusted domains.
 */
export const startNeonGoogleSignIn = async (input: {
    callbackUrl: string;
    origin: string;
}): Promise<NeonGoogleHandoff> => {
    const response = await callNeonAuth("sign-in/social", {
        method: "POST",
        origin: input.origin,
        body: { provider: "google", callbackURL: input.callbackUrl },
    });

    if (!response.ok) {
        /**
         * Logged, never returned. The client gets one opaque sentence — but without the
         * upstream reason in the server log, a project misconfiguration (a callback URL or
         * origin Neon does not trust, which answers 403 INVALID_CALLBACKURL) is
         * indistinguishable from Neon being down, and both read as NEON_AUTH_START_FAILED.
         */
        const detail = await response.text().catch(() => "");
        console.error(
            `[neon-auth] sign-in/social rejected: ${response.status} ${detail.slice(0, 300)}`,
            { callbackUrl: input.callbackUrl, origin: input.origin },
        );

        throw new ApiError(502, "Google sign-in could not be started", {
            code: "NEON_AUTH_START_FAILED",
        });
    }

    const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
    const redirectUrl = typeof body?.url === "string" ? body.url : null;
    const challenge = readSetCookie(response, NEON_AUTH_CHALLENGE_COOKIES);

    if (!redirectUrl || !challenge) {
        throw new ApiError(502, "Google sign-in could not be started", {
            code: "NEON_AUTH_START_INCOMPLETE",
        });
    }

    // Never redirect anywhere but Neon Auth's own origin, whatever the response claimed.
    if (new URL(redirectUrl).origin !== NEON_AUTH_ORIGIN) {
        throw new ApiError(502, "Google sign-in could not be started", {
            code: "NEON_AUTH_UNTRUSTED_REDIRECT",
        });
    }

    return { redirectUrl, challenge };
};

/**
 * Completes the handshake and returns a Neon Auth JWT.
 *
 * The Neon session created along the way is signed out again before returning: the NexusAI
 * cookie is the app's session, and leaving a second live session on the Neon origin would
 * mean two systems answering "who is signed in".
 */
export const completeNeonGoogleSignIn = async (input: {
    verifier: string;
    challenge: string;
    origin: string;
}): Promise<string> => {
    const challengeCookie = NEON_AUTH_CHALLENGE_COOKIES.map(
        (name) => `${name}=${input.challenge}`,
    ).join("; ");

    const sessionResponse = await callNeonAuth(
        `get-session?${NEON_AUTH_VERIFIER_PARAM}=${encodeURIComponent(input.verifier)}`,
        { method: "GET", origin: input.origin, cookie: challengeCookie },
    );

    const sessionCookie = sessionResponse.ok
        ? readSetCookie(sessionResponse, [NEON_AUTH_SESSION_COOKIE])
        : null;

    if (!sessionCookie) {
        throw ApiError.unauthorized(
            "Google sign-in could not be completed. Please try again.",
            "NEON_AUTH_EXCHANGE_FAILED",
        );
    }

    const cookie = `${NEON_AUTH_SESSION_COOKIE}=${sessionCookie}`;
    const tokenResponse = await callNeonAuth("token", {
        method: "GET",
        origin: input.origin,
        cookie,
    });

    const tokenBody = tokenResponse.ok
        ? ((await tokenResponse.json().catch(() => null)) as { token?: unknown } | null)
        : null;
    const token = typeof tokenBody?.token === "string" ? tokenBody.token : null;

    // Best-effort, and deliberately not awaited into the failure path: the exchange has
    // already happened, and a Neon sign-out that fails must not fail the user's sign-in.
    void callNeonAuth("sign-out", { method: "POST", origin: input.origin, cookie }).catch(
        () => undefined,
    );

    if (!token) {
        throw ApiError.unauthorized(
            "Google sign-in could not be completed. Please try again.",
            "NEON_AUTH_TOKEN_FAILED",
        );
    }

    return token;
};

// createRemoteJWKSet caches keys in-process and refetches only on an unknown `kid`.
const jwks = createRemoteJWKSet(new URL(env.neonAuthJwksUrl), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
});

export interface NeonAuthIdentity {
    neonAuthUserId: string;
    email: string;
    emailVerified: boolean;
    name: string | null;
    avatarUrl: string | null;
}

const asString = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export const verifyNeonAuthToken = async (token: string): Promise<NeonAuthIdentity> => {
    let payload: JWTPayload;

    try {
        ({ payload } = await jwtVerify(token, jwks, { issuer: NEON_AUTH_ORIGIN }));
    } catch (error) {
        throw ApiError.unauthorized(
            "Google sign-in token is invalid or has expired",
            "INVALID_NEON_AUTH_TOKEN",
        );
    }

    const neonAuthUserId = asString(payload.sub);
    const email = asString(payload.email)?.toLowerCase() ?? null;

    if (!neonAuthUserId || !email) {
        throw ApiError.unauthorized(
            "Google sign-in token is missing a user id or email",
            "INCOMPLETE_NEON_AUTH_TOKEN",
        );
    }

    if (payload.banned === true) {
        throw ApiError.forbidden("This account has been banned");
    }

    return {
        neonAuthUserId,
        email,
        emailVerified: payload.emailVerified === true,
        name: asString(payload.name),
        avatarUrl: asString(payload.image),
    };
};

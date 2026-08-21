import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Google sign-in is delegated entirely to Neon Auth (Managed Better Auth). The browser
 * runs `authClient.signIn.social({ provider: "google" })`, Neon handles the OAuth
 * handshake, and the client then posts the resulting Neon Auth JWT to /googleAuth.
 *
 * We verify that JWT here against Neon's JWKS (EdDSA / Ed25519, 15-minute lifetime) and
 * exchange it for our own NexusAI session tokens, so the rest of the API only ever deals
 * with one token format.
 */

const NEON_AUTH_ORIGIN = new URL(env.neonAuthBaseUrl).origin;

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

import type { Request, Response } from "express";
import { env } from "../config/env.ts";
import { withTransaction } from "../db/pool.ts";
import {
    findRefreshToken,
    revokeFamily,
    rotateRefreshToken,
    storeRefreshToken,
} from "../repositories/refreshToken.repository.ts";
import { findUserById, toPublicUser, type PublicUser, type UserRow } from "../repositories/user.repository.ts";
import { ApiError } from "../utils/ApiError.ts";
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from "./token.services.ts";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../constants.ts";


export interface IssuedSession {
    user: PublicUser;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresIn: number;
    refreshTokenExpiresIn: number;
}

const requestContext = (req: Request) => ({
    userAgent: req.get("user-agent")?.slice(0, 512) ?? null,
    ipAddress: req.ip ?? null,
});

/**
 * Issues a fresh access/refresh pair. `familyId` continues an existing rotation chain
 * (a refresh) or starts a new one (a login).
 */
export const issueSession = async (
    user: UserRow,
    req: Request,
    familyId?: string,
): Promise<IssuedSession> => {
    // Refresh first: it owns the family id, which is then stamped into the access token
    // so /sessions can identify the calling device from a bearer token alone.
    const refresh = signRefreshToken(user.id, familyId);
    const accessToken = signAccessToken(user, refresh.familyId);
    const { userAgent, ipAddress } = requestContext(req);

    await storeRefreshToken({
        tokenHash: hashToken(refresh.token),
        userId: user.id,
        familyId: refresh.familyId,
        expiresAt: refresh.expiresAt,
        userAgent,
        ipAddress,
    });

    return {
        user: toPublicUser(user),
        accessToken,
        refreshToken: refresh.token,
        accessTokenExpiresIn: Math.floor(env.accessTokenTtlMs / 1000),
        refreshTokenExpiresIn: Math.floor(env.refreshTokenTtlMs / 1000),
    };
};

/**
 * Validates a presented refresh token and rotates it.
 *
 * Rotation means a refresh token is single-use. If one is presented twice, the second
 * presentation is either an attacker replaying a stolen token or a client replaying its
 * own — either way we cannot tell them apart, so the entire family is revoked and every
 * device on that chain has to sign in again.
 */
export const rotateSession = async (
    presentedToken: string,
    req: Request,
): Promise<IssuedSession> => {
    verifyRefreshToken(presentedToken);
    const presentedHash = hashToken(presentedToken);

    /**
     * Reuse is reported back as a value rather than thrown: throwing here would roll the
     * transaction back and undo the very revocation we just performed, leaving the stolen
     * family alive. The error is raised after the commit instead.
     */
    const outcome = await withTransaction<
        { reused: true; userId: string } | { reused: false; session: IssuedSession }
    >(async (client) => {
        const stored = await findRefreshToken(presentedHash, client);

        if (!stored) {
            // Signature was valid but we have no record: revoked-and-pruned, or a token
            // minted by a secret we no longer trust.
            throw ApiError.unauthorized("Refresh token is no longer valid", "REFRESH_TOKEN_REVOKED");
        }

        if (stored.revoked_at !== null) {
            const revoked = await revokeFamily(stored.family_id, client);
            console.warn(
                `[auth] refresh token reuse detected for user ${stored.user_id}; revoked ${revoked} sibling token(s)`,
            );
            return { reused: true, userId: stored.user_id };
        }

        if (stored.expires_at.getTime() <= Date.now()) {
            throw ApiError.unauthorized("Refresh token expired", "REFRESH_TOKEN_EXPIRED");
        }

        const found = await findUserById(stored.user_id, client);
        if (!found) throw ApiError.unauthorized("User no longer exists", "USER_NOT_FOUND");

        const next = signRefreshToken(found.id, stored.family_id);
        const consumed = await rotateRefreshToken(presentedHash, hashToken(next.token), client);
        if (!consumed) {
            // Lost a race with a concurrent refresh of the same token.
            throw ApiError.unauthorized("Refresh token has already been used", "REFRESH_TOKEN_REUSED");
        }

        const { userAgent, ipAddress } = requestContext(req);
        await storeRefreshToken(
            {
                tokenHash: hashToken(next.token),
                userId: found.id,
                familyId: stored.family_id,
                expiresAt: next.expiresAt,
                userAgent,
                ipAddress,
            },
            client,
        );

        return {
            reused: false,
            session: {
                user: toPublicUser(found),
                accessToken: signAccessToken(found, stored.family_id),
                refreshToken: next.token,
                accessTokenExpiresIn: Math.floor(env.accessTokenTtlMs / 1000),
                refreshTokenExpiresIn: Math.floor(env.refreshTokenTtlMs / 1000),
            },
        };
    });

    if (outcome.reused) {
        throw ApiError.unauthorized(
            "Refresh token has already been used. All sessions on this device were revoked.",
            "REFRESH_TOKEN_REUSED",
        );
    }

    return outcome.session;
};

const baseCookieOptions = () =>
    ({
        httpOnly: true,
        secure: env.isProduction,
        sameSite: env.isProduction ? ("none" as const) : ("lax" as const),
        path: "/",
        ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    });

export const setSessionCookies = (res: Response, session: IssuedSession) => {
    res.cookie(ACCESS_COOKIE, session.accessToken, {
        ...baseCookieOptions(),
        maxAge: env.accessTokenTtlMs,
    });
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
        ...baseCookieOptions(),
        maxAge: env.refreshTokenTtlMs,
    });
};

export const clearSessionCookies = (res: Response) => {
    res.clearCookie(ACCESS_COOKIE, baseCookieOptions());
    res.clearCookie(REFRESH_COOKIE, baseCookieOptions());
};

/** Refresh token may arrive as a cookie (browser) or in the body (mobile / CLI clients). */
export const readRefreshToken = (req: Request): string | null => {
    const fromCookie = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    if (typeof fromCookie === "string" && fromCookie.length > 0) return fromCookie;

    const fromBody = (req.body as Record<string, unknown> | undefined)?.refreshToken;
    if (typeof fromBody === "string" && fromBody.length > 0) return fromBody;

    return null;
};

import bcrypt from "bcrypt";
import type { Request, Response } from "express";
import { env } from "../config/env.ts";
import { withTransaction } from "../db/pool.ts";
import {
    revokeAllForUser,
    revokeFamily,
    revokeFamilyForUser,
    findRefreshToken,
    listActiveSessions,
} from "../repositories/refreshToken.repository.ts";
import {
    createGoogleUser,
    createPasswordUser,
    findUserByEmail,
    findUserByNeonAuthId,
    linkNeonAuthIdentity,
    toPublicUser,
    updatePasswordHash,
    type UserRow,
} from "../repositories/user.repository.ts";
import { verifyNeonAuthToken } from "../services/neonAuth.services.ts";
import {
    clearSessionCookies,
    issueSession,
    readRefreshToken,
    rotateSession,
    setSessionCookies,
    type IssuedSession,
} from "../services/session.services.ts";
import { hashToken, verifyRefreshToken } from "../services/token.services.ts";
import { ApiError } from "../utils/ApiError.ts";
import { sendSuccess } from "../utils/ApiResponse.ts";
import { asyncHandler } from "../utils/asyncHandler.ts";
import { parseUserAgent } from "../utils/userAgent.ts";
import type {
    ChangePasswordInput,
    GoogleAuthInput,
    LoginInput,
    RegisterInput,
} from "../validators/user.validators.ts";
import { UNIQUE_VIOLATION, DUMMY_HASH } from "../constants.ts";


const isUniqueViolation = (error: unknown, constraint?: string): boolean => {
    const candidate = error as { code?: string; constraint?: string } | null;
    if (candidate?.code !== UNIQUE_VIOLATION) return false;
    return constraint ? candidate.constraint === constraint : true;
};

const respondWithSession = (
    res: Response,
    statusCode: number,
    message: string,
    session: IssuedSession,
) => {
    setSessionCookies(res, session);
    return sendSuccess(res, statusCode, message, {
        user: session.user,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        accessTokenExpiresIn: session.accessTokenExpiresIn,
        refreshTokenExpiresIn: session.refreshTokenExpiresIn,
    });
};

/**
 * POST /api/v1/user/register
 */
export const register = asyncHandler(async (req: Request, res: Response) => {
    const { email, password, name } = req.body as RegisterInput;

    const passwordHash = await bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);

    let user: UserRow;
    try {
        user = await createPasswordUser({
            email,
            passwordHash,
            name: name ?? null,
            credits: env.SIGNUP_CREDITS,
        });
    } catch (error) {
        // Relying on the unique index rather than a pre-check keeps two concurrent
        // registrations for the same address from both succeeding.
        if (isUniqueViolation(error)) {
            throw ApiError.conflict("An account with this email already exists", "EMAIL_TAKEN");
        }
        throw error;
    }

    const session = await issueSession(user, req);
    return respondWithSession(res, 201, "Account created", session);
});

/**
 * POST /api/v1/user/login
 */
export const login = asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body as LoginInput;

    const user = await findUserByEmail(email);

    // Hash against a dummy value when the user is missing (or has no password) so the
    // response time does not reveal which emails are registered.
    const storedHash = user?.password_hash ?? DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, storedHash);

    if (!user || !user.password_hash || !passwordMatches) {
        if (user && !user.password_hash) {
            throw ApiError.unauthorized(
                "This account uses Google sign-in. Continue with Google instead.",
                "PASSWORD_LOGIN_UNAVAILABLE",
            );
        }
        throw ApiError.unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
    }

    const session = await issueSession(user, req);
    return respondWithSession(res, 200, "Signed in", session);
});

// bcrypt hash of a value no user can produce; only used to equalise login timing.


/**
 * POST /api/v1/user/googleAuth
 *
 * Neon Auth (Managed Better Auth) owns the Google OAuth handshake. The client runs
 * `authClient.signIn.social({ provider: "google" })`, then posts the resulting Neon Auth
 * JWT here; we verify it against Neon's JWKS and exchange it for a NexusAI session.
 */
export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body as GoogleAuthInput;
    const identity = await verifyNeonAuthToken(token);

    const user = await withTransaction(async (client) => {
        const linked = await findUserByNeonAuthId(identity.neonAuthUserId, client);
        if (linked) return linked;

        const byEmail = await findUserByEmail(identity.email, client);
        if (byEmail) {
            // Linking an OAuth identity onto an existing password account is an account
            // takeover if the provider has not verified the address. Refuse instead.
            if (!identity.emailVerified) {
                throw ApiError.conflict(
                    "An account with this email already exists. Sign in with your password, or verify the email with Google first.",
                    "EMAIL_NOT_VERIFIED_FOR_LINKING",
                );
            }
            return linkNeonAuthIdentity(
                {
                    userId: byEmail.id,
                    neonAuthUserId: identity.neonAuthUserId,
                    name: identity.name,
                    avatarUrl: identity.avatarUrl,
                    emailVerified: identity.emailVerified,
                },
                client,
            );
        }

        try {
            return await createGoogleUser(
                {
                    email: identity.email,
                    neonAuthUserId: identity.neonAuthUserId,
                    name: identity.name,
                    avatarUrl: identity.avatarUrl,
                    emailVerified: identity.emailVerified,
                    credits: env.SIGNUP_CREDITS,
                },
                client,
            );
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw ApiError.conflict(
                    "An account with this email already exists",
                    "EMAIL_TAKEN",
                );
            }
            throw error;
        }
    });

    const session = await issueSession(user, req);
    return respondWithSession(res, 200, "Signed in with Google", session);
});

/**
 * POST /api/v1/user/refresh-token
 */
export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
    const presented = readRefreshToken(req);
    if (!presented) {
        throw ApiError.unauthorized("Refresh token is required", "MISSING_REFRESH_TOKEN");
    }

    try {
        const session = await rotateSession(presented, req);
        return respondWithSession(res, 200, "Session refreshed", session);
    } catch (error) {
        // A dead refresh token means the browser's cookies are stale; drop them so the
        // client is not stuck retrying with a token that can never work again.
        clearSessionCookies(res);
        throw error;
    }
});

/**
 * POST /api/v1/user/logout
 *
 * Revokes the whole rotation family behind the presented token, i.e. this device's
 * session chain. Other devices stay signed in.
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
    const presented = readRefreshToken(req);

    if (presented) {
        try {
            const payload = verifyRefreshToken(presented);
            await withTransaction(async (client) => {
                const stored = await findRefreshToken(hashToken(presented), client);
                await revokeFamily(stored?.family_id ?? payload.fid, client);
            });
        } catch {
            // An unparseable or already-dead token still results in a clean logout.
        }
    }

    clearSessionCookies(res);
    return sendSuccess(res, 200, "Signed out");
});

/**
 * POST /api/v1/user/logout-all — revokes every session for the authenticated user.
 */
export const logoutAll = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const revoked = await revokeAllForUser(user.id);
    clearSessionCookies(res);
    return sendSuccess(res, 200, "Signed out of all devices", { revokedSessions: revoked });
});

/**
 * GET /api/v1/user/me
 */
export const getCurrentUser = asyncHandler(async (req: Request, res: Response) =>
    sendSuccess(res, 200, "Current user", { user: toPublicUser(req.user!) }),
);

/**
 * Resolves which session belongs to the caller so the list can flag "this device".
 *
 * Preference order: the `fid` claim on the access token (works for every client), then
 * the refresh cookie (covers browsers holding a token issued before `fid` existed).
 */
const currentFamilyId = (req: Request): string | null => {
    if (req.authFamilyId) return req.authFamilyId;

    const presented = readRefreshToken(req);
    if (!presented) return null;
    try {
        return verifyRefreshToken(presented).fid;
    } catch {
        return null;
    }
};

/**
 * GET /api/v1/user/sessions — every device currently signed in to this account.
 *
 * A "session" is a refresh-token rotation family: one login on one device, however many
 * times it has refreshed since.
 */
export const listSessions = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const current = currentFamilyId(req);
    const rows = await listActiveSessions(user.id);

    const sessions = rows.map((row) => {
        const device = parseUserAgent(row.user_agent);
        return {
            id: row.family_id,
            current: row.family_id === current,
            device: {
                label: device.label,
                browser: device.browser,
                os: device.os,
                type: device.deviceType,
            },
            ipAddress: row.ip_address,
            signedInAt: row.signed_in_at,
            lastActiveAt: row.last_used_at,
            expiresAt: row.expires_at,
            refreshCount: row.refresh_count,
            // The raw header, so a user can inspect a device the parser did not recognise.
            userAgent: row.user_agent,
        };
    });

    return sendSuccess(res, 200, "Active sessions", {
        sessions,
        total: sessions.length,
    });
});

/**
 * DELETE /api/v1/user/sessions/:sessionId — sign one device out.
 *
 * Revoking the session you are currently using is allowed and behaves like /logout:
 * cookies are cleared so the browser is not left holding tokens that no longer work.
 */
export const revokeSession = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { sessionId } = req.params as { sessionId: string };

    const revoked = await revokeFamilyForUser(user.id, sessionId);
    if (revoked === 0) {
        // Either not this user's session or already ended. Both are reported the same way
        // so the endpoint cannot be used to probe for other users' session ids.
        throw ApiError.notFound("Session not found or already signed out");
    }

    const isCurrent = currentFamilyId(req) === sessionId;
    if (isCurrent) clearSessionCookies(res);

    return sendSuccess(res, 200, "Session signed out", {
        sessionId,
        revokedTokens: revoked,
        wasCurrentSession: isCurrent,
    });
});

/**
 * POST /api/v1/user/changePassword
 *
 * Google-only accounts (no password_hash) may set a first password without supplying a
 * current one — they are already proving identity with a valid access token.
 */
export const changePassword = asyncHandler(async (req: Request, res: Response) => {
    const user = req.user!;
    const { currentPassword, newPassword } = req.body as ChangePasswordInput;

    if (user.password_hash) {
        if (!currentPassword) {
            throw ApiError.badRequest("Current password is required", [
                { field: "currentPassword", message: "Current password is required" },
            ]);
        }
        const matches = await bcrypt.compare(currentPassword, user.password_hash);
        if (!matches) {
            throw ApiError.unauthorized("Current password is incorrect", "INVALID_CREDENTIALS");
        }
        if (await bcrypt.compare(newPassword, user.password_hash)) {
            throw ApiError.badRequest("New password must differ from the current password");
        }
    }

    const newHash = await bcrypt.hash(newPassword, env.BCRYPT_SALT_ROUNDS);

    const session = await withTransaction(async (client) => {
        const updated = await updatePasswordHash(user.id, newHash, client);
        if (!updated) throw ApiError.notFound("User not found");

        // A password change must invalidate anything an attacker may already hold.
        await revokeAllForUser(user.id, client);
        return updated;
    }).then((updated) => issueSession(updated, req));

    return respondWithSession(res, 200, "Password updated", session);
});

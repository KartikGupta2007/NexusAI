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
import {
    completeNeonGoogleSignIn,
    startNeonGoogleSignIn,
    verifyNeonAuthToken,
    NEON_AUTH_VERIFIER_PARAM,
    type NeonAuthIdentity,
} from "../services/neonAuth.services.ts";
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
import {
    UNIQUE_VIOLATION,
    DUMMY_HASH,
    GOOGLE_AUTH_ERROR_PARAM,
    GOOGLE_AUTH_PATH,
    GOOGLE_FLOW_COOKIE,
    GOOGLE_FLOW_TTL_MS,
} from "../constants.ts";


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
 * Finds — or creates, or links — the NexusAI account behind a verified Google identity.
 *
 * The single implementation of that decision, shared by both ways into Google sign-in: the
 * browser redirect flow and the `POST /googleAuth` token exchange. Identity always arrives
 * from `verifyNeonAuthToken`, never from a request body, so nothing a client sends can steer
 * which account is returned.
 */
const resolveGoogleUser = (identity: NeonAuthIdentity): Promise<UserRow> =>
    withTransaction(async (client) => {
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

/**
 * POST /api/v1/user/googleAuth
 *
 * Exchanges a Neon Auth JWT for a NexusAI session. The token is verified against Neon's
 * JWKS; a request body cannot assert an identity, only present one to be checked.
 *
 * The browser does not use this route — it has no way to obtain a Neon Auth JWT, by design
 * (see the redirect pair below). It stays because it is the contract for clients that
 * legitimately hold one: native apps and CLIs, which do their own Neon Auth handshake and
 * cannot follow a cookie-setting redirect.
 */
export const googleAuth = asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body as GoogleAuthInput;
    const identity = await verifyNeonAuthToken(token);
    const user = await resolveGoogleUser(identity);

    const session = await issueSession(user, req);
    return respondWithSession(res, 200, "Signed in with Google", session);
});

/**
 * Where the browser is returned to once sign-in resolves, one way or the other.
 *
 * Derived from the request rather than configured, then checked against the CORS allowlist —
 * so the app is always returned to the origin it left from, and a forged Host header cannot
 * turn either endpoint into an open redirect. A `?next=` parameter would be the obvious
 * alternative and is exactly the hole this avoids.
 */
/**
 * This API's own public origin — the half of the flow Neon Auth has to be able to reach, and
 * the origin it validates the call from.
 *
 * API_ORIGIN when configured, which is the answer for a split deployment: the browser arrives
 * here directly, so the callback URL must name this host, and a configured value cannot be
 * moved by a forged Host header. Unset, it is derived from the request and checked against the
 * allowlist — which is what keeps the derived form from becoming an open redirect, and what
 * keeps development working through Vite's proxy, where the host stays the frontend's.
 */
const apiOriginFor = (req: Request): string => {
    if (env.apiOrigin) return env.apiOrigin;

    const origin = `${req.protocol}://${req.get("host") ?? ""}`;
    if (!env.corsOrigins.includes(origin) && origin !== env.appOrigin) {
        throw ApiError.badRequest(
            "Google sign-in is not available from this origin",
            [{ field: "origin", message: `${origin} is not an allowed origin` }],
        );
    }
    return origin;
};

const flowCookieOptions = () =>
    ({
        httpOnly: true,
        secure: env.isProduction,
        // The callback is a top-level navigation from Neon's origin, i.e. cross-site. Lax is
        // sent on exactly that (a GET navigation) and nothing else; production needs None
        // because Secure cookies there are already SameSite=None for the same reason.
        sameSite: env.isProduction ? ("none" as const) : ("lax" as const),
        path: GOOGLE_AUTH_PATH,
        ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    });

/**
 * GET /api/v1/user/googleAuth/start
 *
 * Begins Google sign-in. A redirect endpoint rather than a JSON one because OAuth is a
 * user-agent flow: the browser has to be handed to Google, and only a navigation can do
 * that. Everything it needs to know is a NexusAI URL — the Neon Auth address, the callback
 * registration and the challenge all stay on this side.
 */
export const googleAuthStart = asyncHandler(async (req: Request, res: Response) => {
    const apiOrigin = apiOriginFor(req);
    const { redirectUrl, challenge } = await startNeonGoogleSignIn({
        callbackUrl: `${apiOrigin}${GOOGLE_AUTH_PATH}/callback`,
        origin: apiOrigin,
    });

    res.cookie(GOOGLE_FLOW_COOKIE, challenge, {
        ...flowCookieOptions(),
        maxAge: GOOGLE_FLOW_TTL_MS,
    });
    return res.redirect(302, redirectUrl);
});

/**
 * GET /api/v1/user/googleAuth/callback
 *
 * Where Neon Auth returns the browser after Google. Finishes the handshake server-side,
 * establishes the NexusAI session, and sends the user back to the app.
 *
 * Failures redirect rather than render: the caller here is a navigating browser, so a JSON
 * error body would replace the application with a page of it. The app is returned to with
 * `?googleAuth=<code>` and shows the message itself.
 */
export const googleAuthCallback = asyncHandler(async (req: Request, res: Response) => {
    const apiOrigin = apiOriginFor(req);
    // The app's origin is configuration, not something read off this request: on a split
    // deployment the browser is standing on the API's host right now, and the app it has to be
    // returned to is somewhere else entirely.
    const back = (error?: string) =>
        res.redirect(
            302,
            error
                ? `${env.appOrigin}/?${GOOGLE_AUTH_ERROR_PARAM}=${error}`
                : `${env.appOrigin}/`,
        );

    const verifier = req.query[NEON_AUTH_VERIFIER_PARAM];
    const challenge = (req.cookies as Record<string, unknown> | undefined)?.[GOOGLE_FLOW_COOKIE];

    // The challenge is spent either way: a verifier only works once, and a stale cookie
    // would otherwise sit on the browser until it expired.
    res.clearCookie(GOOGLE_FLOW_COOKIE, flowCookieOptions());

    if (typeof verifier !== "string" || !verifier || typeof challenge !== "string" || !challenge) {
        // A bookmarked callback, an expired flow, or the user declining at Google's screen.
        return back("incomplete");
    }

    try {
        const token = await completeNeonGoogleSignIn({ verifier, challenge, origin: apiOrigin });
        const identity = await verifyNeonAuthToken(token);
        const user = await resolveGoogleUser(identity);

        setSessionCookies(res, await issueSession(user, req));
        return back();
    } catch (error) {
        // 409 is the one failure with a cause the user can act on: this email already has a
        // password account that Google has not verified them for.
        if (error instanceof ApiError && error.statusCode === 409) return back("conflict");
        if (error instanceof ApiError && error.statusCode < 500) return back("failed");
        throw error;
    }
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

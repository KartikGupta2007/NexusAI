import type { NextFunction, Request, Response } from "express";
import { findUserById, type UserRow } from "../repositories/user.repository.ts";
import { ACCESS_COOKIE } from "../constants.ts";
import { verifyAccessToken } from "../services/token.services.ts";
import { ApiError } from "../utils/ApiError.ts";
import { asyncHandler } from "../utils/asyncHandler.ts";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: UserRow;
            /** Rotation family of the token that authenticated this request, when known. */
            authFamilyId?: string;
        }
    }
}

const extractAccessToken = (req: Request): string | null => {
    const header = req.get("authorization");
    if (header?.toLowerCase().startsWith("bearer ")) {
        const token = header.slice(7).trim();
        if (token) return token;
    }

    const fromCookie = (req.cookies as Record<string, unknown> | undefined)?.[ACCESS_COOKIE];
    return typeof fromCookie === "string" && fromCookie.length > 0 ? fromCookie : null;
};

/**
 * Verifies the access token and loads the user. The DB round-trip is deliberate: it means
 * a deleted account stops working immediately rather than at token expiry, and gives
 * downstream handlers a live `credits` value.
 */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractAccessToken(req);
    if (!token) {
        throw ApiError.unauthorized("Authentication required", "MISSING_ACCESS_TOKEN");
    }

    const payload = verifyAccessToken(token);
    const user = await findUserById(payload.sub);
    if (!user) {
        throw ApiError.unauthorized("User no longer exists", "USER_NOT_FOUND");
    }

    req.user = user;
    req.authFamilyId = payload.fid;
    next();
});

/** Attaches `req.user` when a valid token is present, but never rejects the request. */
export const optionalAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractAccessToken(req);
    if (token) {
        try {
            const payload = verifyAccessToken(token);
            req.user = (await findUserById(payload.sub)) ?? undefined;
            req.authFamilyId = payload.fid;
        } catch {
            // Anonymous request; leave req.user unset.
        }
    }
    next();
});

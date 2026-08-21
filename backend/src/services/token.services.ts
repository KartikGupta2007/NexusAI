import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.ts";
import { ApiError } from "../utils/ApiError.ts";

export const TOKEN_ISSUER = "nexusai";

export interface AccessTokenPayload {
    sub: string;
    email: string;
    /**
     * Rotation family this token was issued under — the id of the device session.
     * Optional because tokens minted before this claim existed are still valid until
     * they expire; consumers must treat a missing `fid` as "unknown device".
     */
    fid?: string;
    typ: "access";
}

export interface RefreshTokenPayload {
    sub: string;
    /** Rotation family — every token descended from one login shares it. */
    fid: string;
    /** Unique per token, so rotated siblings never collide on the same hash. */
    jti: string;
    typ: "refresh";
}

export const signAccessToken = (user: { id: string; email: string }, familyId?: string): string =>
    jwt.sign(
        {
            email: user.email,
            typ: "access",
            ...(familyId ? { fid: familyId } : {}),
        } satisfies Omit<AccessTokenPayload, "sub">,
        env.ACCESS_TOKEN_SECRET,
        {
            subject: user.id,
            issuer: TOKEN_ISSUER,
            expiresIn: env.ACCESS_TOKEN_EXPIRY as jwt.SignOptions["expiresIn"],
        },
    );

export const signRefreshToken = (userId: string, familyId: string = randomUUID()): {
    token: string;
    familyId: string;
    expiresAt: Date;
} => {
    const token = jwt.sign(
        { fid: familyId, jti: randomUUID(), typ: "refresh" } satisfies Omit<RefreshTokenPayload, "sub">,
        env.REFRESH_TOKEN_SECRET,
        {
            subject: userId,
            issuer: TOKEN_ISSUER,
            expiresIn: env.REFRESH_TOKEN_EXPIRY as jwt.SignOptions["expiresIn"],
        },
    );

    return { token, familyId, expiresAt: new Date(Date.now() + env.refreshTokenTtlMs) };
};

export const verifyAccessToken = (token: string): AccessTokenPayload => {
    try {
        const payload = jwt.verify(token, env.ACCESS_TOKEN_SECRET, {
            issuer: TOKEN_ISSUER,
        }) as jwt.JwtPayload;

        if (payload.typ !== "access" || typeof payload.sub !== "string" || typeof payload.email !== "string") {
            throw ApiError.unauthorized("Invalid access token", "INVALID_ACCESS_TOKEN");
        }
        return {
            sub: payload.sub,
            email: payload.email,
            typ: "access",
            ...(typeof payload.fid === "string" ? { fid: payload.fid } : {}),
        };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof jwt.TokenExpiredError) {
            throw ApiError.unauthorized("Access token expired", "ACCESS_TOKEN_EXPIRED");
        }
        throw ApiError.unauthorized("Invalid access token", "INVALID_ACCESS_TOKEN");
    }
};

export const verifyRefreshToken = (token: string): RefreshTokenPayload => {
    try {
        const payload = jwt.verify(token, env.REFRESH_TOKEN_SECRET, {
            issuer: TOKEN_ISSUER,
        }) as jwt.JwtPayload;

        if (
            payload.typ !== "refresh" ||
            typeof payload.sub !== "string" ||
            typeof payload.fid !== "string" ||
            typeof payload.jti !== "string"
        ) {
            throw ApiError.unauthorized("Invalid refresh token", "INVALID_REFRESH_TOKEN");
        }
        return { sub: payload.sub, fid: payload.fid, jti: payload.jti, typ: "refresh" };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof jwt.TokenExpiredError) {
            throw ApiError.unauthorized("Refresh token expired", "REFRESH_TOKEN_EXPIRED");
        }
        throw ApiError.unauthorized("Invalid refresh token", "INVALID_REFRESH_TOKEN");
    }
};

/** Refresh tokens are persisted as a digest so a database dump cannot be replayed. */
export const hashToken = (token: string): string =>
    createHash("sha256").update(token).digest("hex");

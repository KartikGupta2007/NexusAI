import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import { ApiError } from "../utils/ApiError.ts";

const handler: Options["handler"] = (_req, _res, next) => {
    next(new ApiError(429, "Too many requests. Please try again later.", { code: "TOO_MANY_REQUESTS" }));
};

const base = {
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler,
} as const;

/** Broad ceiling for every /api/v1/user route. */
export const authRouteLimiter = rateLimit({
    ...base,
    windowMs: 15 * 60 * 1000,
    limit: 100,
});

/**
 * Credential endpoints are keyed on email *and* IP, so one attacker cannot lock a victim
 * out by burning the limit on their address alone, and a botnet cannot spread a
 * password-spray attack across IPs against a single account for free.
 */
export const credentialLimiter = rateLimit({
    ...base,
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
        const email = (req.body as Record<string, unknown> | undefined)?.email;
        const ip = ipKeyGenerator(req.ip ?? "");
        return typeof email === "string" ? `${ip}:${email.toLowerCase()}` : ip;
    },
});


export const registrationLimiter = rateLimit({
    ...base,
    windowMs: 60 * 60 * 1000,
    limit: 10,
});

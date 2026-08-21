import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Parses and *replaces* req.body with the validated result, so handlers work with
 * normalised values (trimmed, lowercased email) rather than raw input.
 */
export const validateBody =
    <T>(schema: ZodType<T>): RequestHandler =>
    (req: Request, _res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body ?? {});

        if (!result.success) {
            return next(
                ApiError.badRequest(
                    "Validation failed",
                    result.error.issues.map((issue) => ({
                        field: issue.path.join(".") || "(body)",
                        message: issue.message,
                    })),
                ),
            );
        }

        req.body = result.data;
        next();
    };

/**
 * Validates route params. Unlike the body, `req.params` is a getter on Express 5 and
 * cannot be reassigned, so the parsed value is only checked, not written back.
 */
export const validateParams =
    <T>(schema: ZodType<T>): RequestHandler =>
    (req: Request, _res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.params ?? {});

        if (!result.success) {
            return next(
                ApiError.badRequest(
                    "Validation failed",
                    result.error.issues.map((issue) => ({
                        field: issue.path.join(".") || "(params)",
                        message: issue.message,
                    })),
                ),
            );
        }

        next();
    };

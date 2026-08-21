import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.ts";
import { ApiError } from "../utils/ApiError.ts";

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction) => {
    next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};

export const errorHandler = (
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
) => {
    if (res.headersSent) return next(err);

    const isApiError = err instanceof ApiError;
    const statusCode = isApiError ? err.statusCode : 500;
    const code = isApiError ? err.code : "INTERNAL_ERROR";

    // Never surface an unexpected error's message: it can carry SQL, paths, or secrets.
    const message = isApiError
        ? err.message
        : "Internal Server Error";

    if (!isApiError || statusCode >= 500) {
        console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    }

    res.status(statusCode).json({
        success: false,
        code,
        message,
        errors: isApiError ? err.errors : [],
        ...(env.isProduction || isApiError
            ? {}
            : { stack: err instanceof Error ? err.stack : undefined }),
    });
};

import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 5 forwards rejected promises to the error middleware on its own, but wrapping
 * keeps the behaviour explicit and keeps handlers typed as `RequestHandler`.
 */
export const asyncHandler =
    (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
export class ApiError extends Error {
    public readonly statusCode: number;
    public readonly errors: unknown[];
    public readonly code: string;
    public readonly isOperational = true;

    constructor(
        statusCode: number,
        message = "Something went wrong",
        options: { code?: string; errors?: unknown[]; cause?: unknown } = {},
    ) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = "ApiError";
        this.statusCode = statusCode;
        this.code = options.code ?? defaultCodeFor(statusCode);
        this.errors = options.errors ?? [];
        Error.captureStackTrace?.(this, ApiError);
    }

    static badRequest(message: string, errors?: unknown[]) {
        return new ApiError(400, message, { code: "BAD_REQUEST", errors });
    }

    static unauthorized(message = "Unauthorized", code = "UNAUTHORIZED") {
        return new ApiError(401, message, { code });
    }

    static forbidden(message = "Forbidden") {
        return new ApiError(403, message, { code: "FORBIDDEN" });
    }

    static notFound(message = "Not found") {
        return new ApiError(404, message, { code: "NOT_FOUND" });
    }

    static conflict(message: string, code = "CONFLICT") {
        return new ApiError(409, message, { code });
    }
}

function defaultCodeFor(statusCode: number): string {
    switch (statusCode) {
        case 400:
            return "BAD_REQUEST";
        case 401:
            return "UNAUTHORIZED";
        case 403:
            return "FORBIDDEN";
        case 404:
            return "NOT_FOUND";
        case 409:
            return "CONFLICT";
        case 429:
            return "TOO_MANY_REQUESTS";
        default:
            return statusCode >= 500 ? "INTERNAL_ERROR" : "ERROR";
    }
}
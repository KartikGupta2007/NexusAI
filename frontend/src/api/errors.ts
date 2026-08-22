/**
 * One error type for every failure the API layer can produce, so UI code branches on a code
 * rather than sniffing status numbers or matching on message text.
 */
export class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly fieldErrors: { field?: string; message?: string }[];

    constructor(status: number, code: string, message: string, fieldErrors: { field?: string; message?: string }[] = []) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
        this.fieldErrors = fieldErrors;
    }

    get isUnauthenticated(): boolean {
        return this.status === 401;
    }

    get isInsufficientCredits(): boolean {
        return this.status === 402 || this.code === "INSUFFICIENT_CREDITS";
    }

    get isNotFound(): boolean {
        return this.status === 404;
    }
}

/**
 * A user-facing sentence for any failure.
 *
 * The backend's own messages are safe to show — it never puts SQL or provider text in them —
 * but the ones below read better for the cases a user actually hits, and guarantee that an
 * unexpected 500 never surfaces internals.
 */
export const describeError = (error: unknown): string => {
    if (!(error instanceof ApiError)) {
        return error instanceof DOMException && error.name === "AbortError"
            ? "Stopped."
            : "Something went wrong. Please try again.";
    }

    switch (error.code) {
        case "INSUFFICIENT_CREDITS":
            return "You don't have enough credits to run this query.";
        case "SEARCH_RATE_LIMITED":
        case "ANSWER_RATE_LIMITED":
        case "TOO_MANY_REQUESTS":
            return "Too many requests right now. Please try again in a moment.";
        case "SEARCH_NOT_CONFIGURED":
        case "ANSWER_NOT_CONFIGURED":
            return "Search is unavailable right now. Please try again later.";
        case "SEARCH_FAILED":
        case "ANSWER_FAILED":
        case "ANSWER_EMPTY":
            return "The answer couldn't be generated. Please try again.";
        default:
            break;
    }

    if (error.isUnauthenticated) return "Your session expired. Please sign in again.";
    if (error.isNotFound) return "That conversation is no longer available.";
    if (error.status === 400) {
        return error.fieldErrors[0]?.message ?? "That request wasn't valid.";
    }
    if (error.status >= 500) return "The server had a problem. Please try again.";
    return error.message;
};

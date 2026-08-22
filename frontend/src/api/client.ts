import { ApiError } from "./errors.ts";
import { API_BASE } from "../constants.ts";
import type { ApiFailure, ApiSuccess } from "../types/api.ts";

/**
 * The single place a request is made.
 *
 * `credentials: "include"` on every call: the backend authenticates with httpOnly
 * accessToken/refreshToken cookies, so the browser must be told to send them cross-origin.
 * No token is ever read into JavaScript — httpOnly means it cannot be, which is the point.
 */

const parseFailure = async (response: Response): Promise<ApiError> => {
    let code = `HTTP_${response.status}`;
    let message = response.statusText || "Request failed";
    let fieldErrors: ApiFailure["errors"] = [];

    try {
        const body = (await response.json()) as Partial<ApiFailure>;
        if (typeof body.code === "string") code = body.code;
        if (typeof body.message === "string") message = body.message;
        if (Array.isArray(body.errors)) fieldErrors = body.errors;
    } catch {
        // A non-JSON error body (a proxy error page, say) leaves the defaults above.
    }

    return new ApiError(response.status, code, message, fieldErrors);
};

/** Issues a request and unwraps the `{ success, data }` envelope, or throws ApiError. */
export const request = async <T>(
    path: string,
    init: RequestInit = {},
): Promise<T> => {
    const response = await fetch(`${API_BASE}${path}`, {
        credentials: "include",
        ...init,
        headers: {
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...init.headers,
        },
    });

    if (!response.ok) throw await parseFailure(response);

    const body = (await response.json()) as ApiSuccess<T>;
    return body.data;
};

/**
 * Issues a POST that is expected to answer with an event stream.
 *
 * Returns the raw body so the caller can read frames. Failures that happen *before* the stream
 * opens — 400, 401, 402, 404 — arrive as ordinary JSON with a real status code, and are thrown
 * as ApiError here. That is exactly why the backend charges credits before opening the stream:
 * once the first byte ships the status is fixed at 200 and a failure can only be an in-band
 * `error` event.
 */
export const postStream = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> => {
    const response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) throw await parseFailure(response);
    if (!response.body) {
        throw new ApiError(502, "STREAM_UNAVAILABLE", "The server did not return a stream.");
    }

    return response.body;
};

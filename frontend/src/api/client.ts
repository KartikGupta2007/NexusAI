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

const REFRESH_PATH = "/user/refresh-token";

/**
 * Paths where a 401 is the answer rather than a stale access token.
 *
 * Wrong credentials, a dead refresh cookie, or a logout with nothing to revoke are all
 * legitimately unauthorised. Renewing on those would turn one failed sign-in into two requests
 * and, on the refresh endpoint itself, into a loop.
 */
const NEVER_RENEWED = new Set(["/user/login", "/user/register", "/user/logout", REFRESH_PATH]);

/**
 * The renewal in flight, so a burst of 401s costs exactly one rotation.
 *
 * Refresh tokens rotate: the backend revokes the presented one as it issues its replacement.
 * Two renewals racing would mean the loser presenting a token that was just revoked, which the
 * backend correctly reads as replay and answers by killing the whole family — signing the user
 * out for real. Sharing one promise is what stops a page that fires several requests at once
 * from logging itself out.
 */
let inFlightRenewal: Promise<boolean> | null = null;

/** Exchanges the refresh cookie for a fresh session. Resolves to whether it worked. */
const renewSession = (): Promise<boolean> => {
    inFlightRenewal ??= fetch(`${API_BASE}${REFRESH_PATH}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        // The token travels as an httpOnly cookie. The body is sent because the endpoint also
        // serves clients that must present it explicitly, and its validator expects an object.
        body: "{}",
    })
        .then((response) => response.ok)
        // A network failure is not an expired session; the caller still gets its original 401.
        .catch(() => false)
        .finally(() => {
            inFlightRenewal = null;
        });

    return inFlightRenewal;
};

/**
 * One request, with a single replay behind a session renewal.
 *
 * The access token is deliberately short-lived, so a 401 part-way through a session is the
 * expected case rather than a failure: renew once, replay the request, and let the second
 * answer stand whatever it is. Without this the session simply ended when the access token
 * expired — the refresh cookie sat in the browser, valid for days, and nothing ever spent it.
 *
 * Never more than one replay. A renewal that fails means the session is genuinely over, and
 * the original 401 is then the honest answer to hand back.
 */
const fetchWithSession = async (path: string, init: RequestInit): Promise<Response> => {
    const response = await fetch(`${API_BASE}${path}`, init);

    if (response.status !== 401 || NEVER_RENEWED.has(path)) return response;
    if (!(await renewSession())) return response;

    return fetch(`${API_BASE}${path}`, init);
};

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
    const response = await fetchWithSession(path, {
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
 *
 * A 401 here is renewed and replayed like any other request: an expired access token must cost
 * the user a moment, not the question they just typed.
 */
export const postStream = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> => {
    const response = await fetchWithSession(path, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        // Replaying reuses this signal, so a stop during the renewal still aborts the retry.
        ...(signal ? { signal } : {}),
    });

    if (!response.ok) throw await parseFailure(response);
    if (!response.body) {
        throw new ApiError(502, "STREAM_UNAVAILABLE", "The server did not return a stream.");
    }

    return response.body;
};

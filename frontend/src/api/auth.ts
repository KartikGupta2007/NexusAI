/**
 * Google sign-in, as far as the browser is concerned.
 *
 * Which is: navigate to a NexusAI endpoint and let the backend do it. The backend owns the
 * Neon Auth handshake end to end — this file has no auth provider URL, no SDK, no token and no
 * callback logic, because none of that belongs on the client. What comes back is the same
 * httpOnly NexusAI session cookie that password sign-in produces, so from here on there is
 * only one kind of session.
 *
 * A navigation rather than a fetch: OAuth hands the browser to Google, and only a top-level
 * navigation can do that. Kept next to the API layer rather than in the page because it *is*
 * the client's half of the auth contract, small as it is.
 */
import { GOOGLE_SIGN_IN_URL } from "../constants.ts";

/** Leaves this page. Nothing after it runs. */
export const startGoogleSignIn = (): void => {
    window.location.assign(GOOGLE_SIGN_IN_URL);
};

/**
 * A sentence for the reason the backend reported, or null when there is nothing to say.
 *
 * The codes are a closed set the backend defines; an unrecognised one still gets a message,
 * because silently returning a user to the login screen tells them nothing.
 */
export const describeGoogleAuthError = (code: string | null): string | null => {
    if (!code) return null;
    switch (code) {
        case "incomplete":
            return "Google sign-in was cancelled or timed out. Please try again.";
        case "conflict":
            return "An account with this email already exists. Sign in with your password instead.";
        default:
            return "Google sign-in could not be completed. Please try again.";
    }
};

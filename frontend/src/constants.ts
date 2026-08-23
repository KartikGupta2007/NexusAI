/**
 * Every tunable value in the frontend, in one place.
 *
 * One value here is configuration in the deployment sense — where the API lives (see
 * .env.example). Everything else is a constant the code would otherwise spell inline: endpoint
 * paths, presentation thresholds, animation durations, and the two patterns that parse wire and
 * model output.
 *
 * On the credit values in particular: they mirror backend policy for *presentation only*. The
 * backend remains the authority — it charges the credits and reports the balance, and nothing here
 * is ever used to compute or predict one.
 */

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Origin of the NexusAI API, when it is not the origin serving this app.
 *
 * The single environment value the browser bundle reads, and it exists because the frontend and
 * backend can be deployed to separate hosts: a static site cannot proxy, so the browser has to be
 * told the API's address. Set it to an origin with no path — `https://api.example.com` — and the
 * `/api/v1` below is appended here rather than repeated in the variable.
 *
 * Empty (or unset) keeps the same-origin behaviour: relative requests, which is what one host in
 * front of both, or `npm run dev`'s proxy, already provides. Trailing slashes are stripped so
 * `https://api.example.com/` and `https://api.example.com` mean the same thing.
 *
 * Vite inlines this at build time, so changing it means rebuilding the bundle, not restarting a
 * process. It is also the *only* host the client can reach — there is no hard-coded URL anywhere
 * in the source, and the architecture suite asserts that.
 */
const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");

/** Base URL for every request the browser makes. Relative when no API origin is configured. */
export const API_BASE = `${API_ORIGIN}/api/v1`;

/**
 * The backend redirect endpoint that begins Google sign-in.
 *
 * The whole of the client's part in OAuth: navigate here and stop. The backend owns the handshake
 * with Neon Auth, so no provider URL, SDK or token exists on this side. Absolute when the API is
 * on another host, because a navigation cannot be proxied by a static frontend either.
 */
export const GOOGLE_SIGN_IN_URL = `${API_BASE}/user/googleAuth/start`;

/** Query parameter the backend returns the app with when Google sign-in did not complete. */
export const GOOGLE_AUTH_ERROR_PARAM = "googleAuth";

// ── SSE framing ──────────────────────────────────────────────────────────────

/**
 * The blank-line terminator between Server-Sent Events frames.
 *
 * All three line-ending forms, because the spec permits each and a proxy may rewrite them. No `g`
 * flag: the reader calls `.exec()` on a shrinking buffer and relies on matching from the start
 * each time, so there is no `lastIndex` to carry between calls.
 */
export const SSE_FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

// ── Credits ──────────────────────────────────────────────────────────────────

/** Mirrors CREDITS_PER_QUERY in the backend. Used only to describe a balance to the user. */
export const CREDITS_PER_QUERY = 20;

/** Below this, the balance is shown as a warning. Roughly three queries left. */
export const LOW_CREDIT_THRESHOLD = 60;

/**
 * Mirrors DEFAULT_USER_CREDITS in the backend. Used only as the denominator of the capacity bar,
 * so a balance has a visible scale — never to compute or predict a balance.
 */
export const STARTING_CREDITS = 500;

/**
 * How long the credit meter flashes after the balance changes, in milliseconds.
 *
 * Long enough to notice the deduction, short enough not to still be animating when the reader
 * starts the next question.
 */
export const CREDIT_FLASH_MS = 340;

// ── Composer ─────────────────────────────────────────────────────────────────

/**
 * Tallest the input grows before it scrolls internally, in pixels.
 *
 * Roughly eight lines. Past that the composer would start pushing the answer off screen, which
 * matters more than seeing the whole of a long question at once.
 */
export const MAX_TEXTAREA_PX = 208;

// ── Answer rendering ─────────────────────────────────────────────────────────

/**
 * Matches a bracketed citation such as `[1]` or `[2, 3]`.
 *
 * Only bracketed *positions* are recognised, and only when the position exists in the sources the
 * backend sent. Prompt-side ids (`source_1`, `source_2`) are deliberately NOT resolved: the
 * backend renumbers cited sources from 1 when it persists them, so the third source offered to
 * the model is not necessarily the third source in the `sources` event. Guessing that mapping
 * would attach the wrong link to a claim, which is worse than no link at all.
 *
 * Carries the `g` flag, so `lastIndex` is shared mutable state. The one caller resets it before
 * use; keep that reset if a second caller ever appears.
 */
export const CITATION_PATTERN = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** How long a code block shows "Copied" before reverting, in milliseconds. */
export const COPY_FEEDBACK_MS = 1600;

/**
 * How many citation cards show before the rest collapse behind a toggle.
 *
 * A long source list would otherwise dominate the answer it belongs to. The hidden cards are
 * mounted only once expanded, so their favicons are not fetched until asked for.
 */
export const SOURCES_VISIBLE_BY_DEFAULT = 4;

// ── Scrolling ────────────────────────────────────────────────────────────────

/** Within this many pixels of the bottom counts as "following the answer". */
export const NEAR_BOTTOM_PX = 120;

// ── Empty state ──────────────────────────────────────────────────────────────

/** Starter questions offered on an empty new chat. */
export const SUGGESTIONS = [
    "Tell me about Nvidia",
    "What's new in React?",
    "Compare PostgreSQL and MongoDB",
    "Explain how transformers work",
] as const;

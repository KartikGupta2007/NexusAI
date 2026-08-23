/// <reference types="vite/client" />

/**
 * The environment the browser bundle may read, declared rather than inferred.
 *
 * Vite's own `ImportMetaEnv` is an index signature, so every misspelling types as `any` and
 * fails at runtime instead of at build. Declaring the one variable this app has makes
 * `VITE_API_BASE_UR` a type error, and makes the list of what is configurable browser-side
 * readable in one place.
 */
interface ImportMetaEnv {
    /**
     * Origin of the NexusAI API — scheme and host, no path, no trailing slash. Optional: unset
     * or empty means the API is same-origin (one host in front of both, or the dev proxy).
     */
    readonly VITE_API_BASE_URL?: string;
}
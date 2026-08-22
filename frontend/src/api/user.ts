import { request } from "./client.ts";
import type { CurrentUser } from "../types/api.ts";

/**
 * The signed-in user, including the authoritative credit balance.
 *
 * This is where the balance comes from on a fresh page load; after that the `done` event of
 * each answer supplies it. The frontend never computes it.
 */
export const getCurrentUser = () =>
    request<{ user: CurrentUser }>("/user/me").then((data) => data.user);

export const login = (email: string, password: string) =>
    request<{ user: CurrentUser }>("/user/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
    }).then((data) => data.user);

export const register = (email: string, password: string, name?: string) =>
    request<{ user: CurrentUser }>("/user/register", {
        method: "POST",
        body: JSON.stringify({ email, password, ...(name ? { name } : {}) }),
    }).then((data) => data.user);

/**
 * Google sign-in has no entry here on purpose.
 *
 * It is a navigation, not a request: see api/auth.ts. The token exchange it used to perform
 * against POST /user/googleAuth now happens inside the backend, which is the only place that
 * can obtain a Neon Auth token at all.
 */

export const logout = () => request<unknown>("/user/logout", { method: "POST" });

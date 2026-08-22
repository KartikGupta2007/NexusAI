import { useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { BrandLockup } from "../components/BrandMark.tsx";
import { IconGoogle } from "../components/Icon.tsx";
import { describeError } from "../api/errors.ts";
import { describeGoogleAuthError, startGoogleSignIn } from "../api/auth.ts";
import { GOOGLE_AUTH_ERROR_PARAM, STARTING_CREDITS } from "../constants.ts";
import { login, register } from "../api/user.ts";
import { useApp } from "../state/AppContext.tsx";

/**
 * Sign in / sign up.
 *
 * Two routes into the same session, both of them NexusAI API calls. Google is a navigation to
 * a backend redirect endpoint — the backend runs the whole handshake with Neon Auth and returns
 * the browser holding a NexusAI cookie. Email/password posts to the API directly. Either way
 * the session is an httpOnly cookie, so nothing token-shaped is ever held in JavaScript here,
 * and this page knows nothing about any authentication provider.
 *
 * Password auth is kept rather than hidden behind the Google button: the backend supports it,
 * and existing password accounts must still be able to sign in.
 */
export const LoginPage = () => {
    const { onAuthenticated } = useApp();
    const [searchParams, setSearchParams] = useSearchParams();
    const [mode, setMode] = useState<"login" | "register">("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    // A failed Google round trip returns here with a reason; it survives until the next action.
    const [error, setError] = useState<string | null>(() =>
        describeGoogleAuthError(searchParams.get(GOOGLE_AUTH_ERROR_PARAM)),
    );
    const [busy, setBusy] = useState<"google" | "password" | null>(null);

    /** Drops the error parameter so a reload does not resurrect a message already read. */
    const clearGoogleAuthError = () => {
        if (!searchParams.has(GOOGLE_AUTH_ERROR_PARAM)) return;
        const next = new URLSearchParams(searchParams);
        next.delete(GOOGLE_AUTH_ERROR_PARAM);
        setSearchParams(next, { replace: true });
    };

    const continueWithGoogle = () => {
        setError(null);
        clearGoogleAuthError();
        setBusy("google");
        // Leaves the page. The backend takes it from here.
        startGoogleSignIn();
    };

    const submitPassword = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);
        clearGoogleAuthError();
        setBusy("password");
        try {
            const user =
                mode === "login"
                    ? await login(email.trim(), password)
                    : await register(email.trim(), password, name.trim() || undefined);
            onAuthenticated(user);
        } catch (caught) {
            setError(describeError(caught));
        } finally {
            setBusy(null);
        }
    };

    return (
        <main className="auth">
            <div className="auth-card">
                <div className="auth-brand">
                    <BrandLockup large />
                </div>

                <h1 className="auth-title">Welcome to NexusAI</h1>
                <p className="auth-sub">Search, reason, and explore with AI.</p>

                {/*
                  * Always offered. Whether Google sign-in is available is the backend's
                  * business — it holds the configuration — so there is nothing for the client
                  * to feature-detect, and no environment variable for it to read.
                  */}
                <button
                    type="button"
                    className="btn btn-outline google-btn"
                    onClick={continueWithGoogle}
                    disabled={busy !== null}
                >
                    <IconGoogle />
                    {busy === "google" ? "Redirecting…" : "Continue with Google"}
                </button>

                <div className="auth-divider">or</div>

                <form className="auth-form" onSubmit={submitPassword}>
                    {mode === "register" ? (
                        <label className="field">
                            <span>Name</span>
                            <input
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                autoComplete="name"
                            />
                        </label>
                    ) : null}

                    <label className="field">
                        <span>Email</span>
                        <input
                            type="email"
                            required
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            autoComplete="email"
                        />
                    </label>

                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            required
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete={mode === "login" ? "current-password" : "new-password"}
                        />
                    </label>

                    {error ? (
                        <p className="notice notice-error" role="alert">
                            {error}
                        </p>
                    ) : null}

                    <button type="submit" className="btn btn-primary" disabled={busy !== null}>
                        {busy === "password"
                            ? "Please wait…"
                            : mode === "login"
                              ? "Sign in"
                              : "Create account"}
                    </button>
                </form>

                <div className="auth-switch">
                    <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                            setMode(mode === "login" ? "register" : "login");
                            setError(null);
                        }}
                    >
                        {mode === "login"
                            ? "Need an account? Sign up"
                            : "Already have an account? Sign in"}
                    </button>
                </div>

                <p className="auth-legal">New accounts start with {STARTING_CREDITS} credits.</p>
            </div>
        </main>
    );
};

export default LoginPage;

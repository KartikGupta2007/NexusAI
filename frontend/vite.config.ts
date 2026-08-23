/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * In development the API is proxied rather than called cross-origin.
 *
 * Same-origin requests mean the httpOnly auth cookies are first-party, so no CORS preflight and
 * no SameSite friction while developing. It also keeps the client's base URL a plain `/api/v1`,
 * which is exactly what it is when one host serves both halves in production.
 *
 * `changeOrigin: false` on purpose: the backend's CORS allowlist contains http://localhost:5173,
 * and rewriting Origin would defeat the check we want exercised.
 *
 * The proxy target is `DEV_API_PROXY_TARGET` — deliberately without the VITE_ prefix, so it is
 * never inlined into the bundle. It is only ever a development detail; a deployed frontend on a
 * separate host reaches the API through VITE_API_BASE_URL instead (see .env.example), which the
 * client resolves at build time and this proxy plays no part in.
 */
export default defineConfig(({ mode }) => {
    // "" as the prefix loads every variable, not just VITE_ ones. That affects this config
    // object only; what reaches the browser is still governed by Vite's envPrefix.
    const environment = loadEnv(mode, process.cwd(), "");
    const proxyTarget = environment.DEV_API_PROXY_TARGET?.trim() || "http://127.0.0.1:3003";

    return {
        plugins: [react()],
        server: {
            port: 5173,
            proxy: {
                "/api": {
                    target: proxyTarget,
                    changeOrigin: false,
                    // SSE must not be buffered by the proxy, or tokens arrive in one lump.
                    configure: (proxy) => {
                        proxy.on("proxyRes", (proxyRes) => {
                            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
                                delete proxyRes.headers["content-length"];
                            }
                        });
                    },
                },
            },
        },
        test: {
            environment: "jsdom",
            globals: true,
            setupFiles: ["./src/test/setup.ts"],
            include: ["src/test/**/*.test.{ts,tsx}"],
            restoreMocks: true,
        },
    };
});
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The API is proxied rather than called cross-origin.
 *
 * Same-origin requests mean the httpOnly auth cookies are first-party, so no CORS preflight and
 * no SameSite friction in development. It also keeps the client's base URL as a plain `/api/v1`,
 * identical to how it will be served in production behind one host.
 *
 * `changeOrigin: false` on purpose: the backend's CORS allowlist contains http://localhost:5173,
 * and rewriting Origin would defeat the check we want exercised.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: "http://127.0.0.1:3003",
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
});

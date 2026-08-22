# NexusAI — Auth API

Email/password auth is handled in this service. Google sign-in is delegated to
**Neon Auth (Managed Better Auth)** — Neon owns the OAuth handshake, we verify the JWT it
issues and exchange it for a NexusAI session. There is no `google-auth-library`,
no client secret in this repo, and one token format for the whole API.

**Neon Auth is a backend dependency, reached only from this process.** The browser talks to
this API and to nothing else:

```
Browser ──HTTPS──▶ NexusAI backend ──▶ Neon Auth  (Google sign-in)
                                   ├──▶ Neon Postgres
                                   ├──▶ Tavily
                                   └──▶ Claude
```

The frontend holds no Neon Auth URL, no Neon SDK and no database client, and needs no
environment variables at all — see `frontend/.env.example`. `NEON_AUTH_BASE_URL` and
`NEON_AUTH_JWKS_URL` are server configuration and must never be exposed through a `VITE_`
variable, which is compiled into the JS bundle and served to every visitor.

## Setup

```bash
npm install
neon checkout production      # writes DATABASE_URL, DATABASE_URL_UNPOOLED, NEON_AUTH_* into .env
npm run migrate               # applies src/db/migrations/*.sql over the direct connection
npm run dev
```

Secrets you must set yourself (`openssl rand -base64 48`):
`ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`. Everything else is in `.env.example`.

## Endpoints

All under `/api/v1/user`. Success bodies are `{ success, message, data? }`;
failures are `{ success: false, code, message, errors[] }`.

| Method | Path                     | Auth   | Body                                    |
| ------ | ------------------------ | ------ | --------------------------------------- |
| POST   | `/register`              | —      | `{ email, password, name? }`            |
| POST   | `/login`                 | —      | `{ email, password }`                   |
| GET    | `/googleAuth/start`      | —      | — → `302` to Google (browsers)          |
| GET    | `/googleAuth/callback`   | —      | — → `302` back to the app (browsers)    |
| POST   | `/googleAuth`            | —      | `{ token }` — a Neon Auth JWT           |
| POST   | `/refresh-token`         | —      | `{ refreshToken? }` (or the cookie)     |
| POST   | `/logout`                | —      | `{ refreshToken? }` (or the cookie)     |
| POST   | `/logout-all`            | Bearer | —                                       |
| GET    | `/me`                    | Bearer | —                                       |
| GET    | `/sessions`              | Bearer | —                                       |
| DELETE | `/sessions/:id`          | Bearer | —                                       |
| POST   | `/changePassword`        | Bearer | `{ currentPassword?, newPassword }`     |

Every session response returns `{ user, accessToken, refreshToken, accessTokenExpiresIn,
refreshTokenExpiresIn }` **and** sets `accessToken` / `refreshToken` as httpOnly cookies.
Browsers can ignore the body and rely on cookies; mobile and CLI clients use the body and
send `Authorization: Bearer <accessToken>`.

## Active sessions

`GET /sessions` lists every device currently signed in. One entry per device, not per
token: a session is a refresh-token rotation family, so a laptop that has refreshed forty
times is still one row.

```jsonc
{
  "success": true,
  "message": "Active sessions",
  "data": {
    "total": 3,
    "sessions": [
      {
        "id": "6b332764-9e36-4db2-bb92-5dde6cc67fb0",
        "current": true,                    // the device making this request
        "device": {
          "label": "Chrome on macOS",
          "browser": "Chrome",
          "os": "macOS",
          "type": "desktop"                 // desktop | mobile | tablet | bot | unknown
        },
        "ipAddress": "203.0.113.9",
        "signedInAt": "2026-08-21T09:14:02.117Z",   // when this device logged in
        "lastActiveAt": "2026-08-22T04:31:55.402Z", // its most recent refresh
        "expiresAt": "2026-09-01T04:31:55.402Z",
        "refreshCount": 12,
        "userAgent": "Mozilla/5.0 (Macintosh; ..."  // raw header, unparsed
      }
    ]
  }
}
```

Sessions are ordered most-recently-active first. `current` is resolved from the `fid`
claim on the access token, so it works for cookie and `Bearer` clients alike.

`DELETE /sessions/:id` signs one device out, where `:id` is the `id` from the list:

```jsonc
{ "sessionId": "fd94...", "revokedTokens": 1, "wasCurrentSession": false }
```

The write is scoped to the calling user, so another user's session id returns
`404` and changes nothing. Revoking your own current session is allowed and behaves like
`/logout` — cookies are cleared. To end everything at once, use `/logout-all`.

## Google sign-in

OAuth is a user-agent flow: the browser has to be handed to Google, and only a navigation
can do that. So the browser's half is two redirects on **this** API, and no SDK:

```ts
// The entire client-side implementation.
window.location.assign("/api/v1/user/googleAuth/start");
```

Everything else happens server-side, in `neonAuth.services.ts`:

```
GET /googleAuth/start
  ├─ POST {NEON_AUTH_BASE_URL}/sign-in/social  { provider: "google", callbackURL }
  │    → { url }  +  Set-Cookie: __Secure-neon-auth.session_challenge
  ├─ stores the challenge in an httpOnly `googleAuthFlow` cookie on our own domain
  └─ 302 → url                     ▶ Google consent ▶ Neon /callback/google ▶ our callback

GET /googleAuth/callback?neon_auth_session_verifier=…
  ├─ GET {NEON_AUTH_BASE_URL}/get-session?neon_auth_session_verifier=…
  │    (Cookie: the stored challenge)   → Set-Cookie: __Secure-neon-auth.session_token
  ├─ GET {NEON_AUTH_BASE_URL}/token    → a Neon Auth JWT
  ├─ POST {NEON_AUTH_BASE_URL}/sign-out   (best effort — the Neon session is now spent)
  ├─ verifies the JWT against Neon's JWKS, then finds/links/creates the NexusAI user
  └─ 302 → the app, holding NexusAI's httpOnly accessToken / refreshToken cookies
```

That verifier/challenge exchange is Neon Auth's own protocol for proxied auth — it is what
`@neondatabase/auth/server`'s `exchangeOAuthToken` does, and what its Next.js adapter relies
on. Nothing here reimplements OAuth: no client secret, no authorization code, no PKCE of our
own, no `google-auth-library`.

**Where the browser is sent back to** is derived from the request and checked against
`CORS_ORIGINS`, not taken from a `?next=` parameter — so a forged `Host` header cannot turn
either endpoint into an open redirect. A failed sign-in redirects to
`/?googleAuth=incomplete|conflict|failed` and the SPA renders the reason; it cannot render a
JSON error body, because the caller is a navigating browser.

**No Neon cookie ever reaches the browser.** The Neon session exists only for the two calls
that consume it and is signed out immediately after, so exactly one system answers "who is
signed in": the NexusAI cookie.

### `POST /googleAuth` — non-browser clients

The token exchange endpoint is unchanged and still supported: given a Neon Auth JWT it
verifies it against the JWKS and returns a NexusAI session. Browsers do not use it — they
have no way to obtain a Neon Auth JWT, by design. It is the contract for native apps and CLIs
that run their own Neon Auth handshake and cannot follow a cookie-setting redirect.

Both paths converge on one `resolveGoogleUser()`, so there is a single implementation of
find-link-or-create. Identity always comes from the verified token; a request body cannot
assert a `userId`, `credits`, `role` or `email`.

### Before going live

Google currently runs on Neon's **shared development credentials**, which is fine for
localhost but not for production. To ship:

1. Create your own Google OAuth client and register the redirect URI
   `${NEON_AUTH_BASE_URL}/callback/google` (the Neon host — *not* your app's URL; using
   the app URL is the usual cause of `redirect_uri_mismatch`).
2. Paste the client ID/secret into Neon Console → project → branch → Auth.
3. Trust your app's origins so the post-login redirect is allowed:
   ```bash
   neon neon-auth domain add https://app.example.com
   ```
   `localhost` is already allowed on this project. Each Neon branch has its own
   `NEON_AUTH_BASE_URL`, so preview branches need their own redirect URI registered.
4. Set `CORS_ORIGINS` to your real frontend origins and `NODE_ENV=production` (which
   flips cookies to `Secure; SameSite=None`). `CORS_ORIGINS` now gates the `/googleAuth`
   redirects as well, so an origin missing from it gets `400` on sign-in rather than a
   CORS error later.

## Session model

**Access token** — stateless JWT, HS256, `ACCESS_TOKEN_EXPIRY` (currently `1d`).
15m–1h is the usual production choice; the tradeoff is that revocation only bites at
expiry. `requireAuth` reloads the user from Postgres on every request, so a deleted
account stops working immediately regardless.

**Refresh token** — JWT, stored in `refresh_tokens` as a SHA-256 digest so a database
leak cannot be replayed. Single-use: every refresh rotates it and marks the old one
consumed. All tokens descended from one login share a `family_id`.

**Reuse detection** — presenting an already-consumed refresh token means either an
attacker is replaying a stolen token or the real client is; the two are indistinguishable,
so the whole family is revoked and that device signs in again. The revocation is committed
*before* the 401 is raised, otherwise the rollback would undo it.

`changePassword` revokes every session for the user and issues a fresh pair, so a
password change actually locks out anyone holding an old token.

## Schema notes

Differences from the original draft schema, and why:

- **`password_hash` is nullable.** Google-only accounts never have one. A table-level
  `CHECK (password_hash IS NOT NULL OR neon_auth_user_id IS NOT NULL)` still guarantees
  every row has a usable credential.
- **No `access_token` column.** Access tokens are short-lived and stateless; persisting
  them would add a write per request and create a theft surface for nothing.
- **`refresh_tokens.token` → `token_hash`,** plus `family_id`, `revoked_at`,
  `replaced_by`, `user_agent`, `ip_address` to support rotation and reuse detection.
- **Emails are stored lowercased** (`CHECK (email = lower(email))`) so `A@b.com` and
  `a@b.com` cannot both register.

## Account linking

If a Google identity arrives for an email that already has a password account, we link
them — but **only if Neon reports the email as verified**. Linking an unverified OAuth
identity onto an existing account is an account takeover, so that case returns
`409 EMAIL_NOT_VERIFIED_FOR_LINKING` instead. Real Google sign-ins are verified.

## Rate limits

| Scope                                       | Window | Limit |
| ------------------------------------------- | ------ | ----- |
| all `/api/v1/user` routes                   | 15 min | 100   |
| `/login`, `/googleAuth*`, `/changePassword`  | 15 min | 10    |
| `/register`                                 | 1 h    | 10    |

The credential limiter skips successful requests, so a completed Google sign-in — two `302`s —
costs nothing against the limit; only repeated failures throttle.

Credential endpoints key on **IP + email**, so one attacker cannot lock a victim out by
burning the limit from a single address, and a distributed spray against one account
still gets counted. Counters are in-process — move them to Redis
(`rate-limit-redis`) before running more than one instance.

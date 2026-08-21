# NexusAI — Auth API

Email/password auth is handled in this service. Google sign-in is delegated to
**Neon Auth (Managed Better Auth)** — Neon owns the OAuth handshake, we verify the JWT it
issues and exchange it for a NexusAI session. There is no `google-auth-library`,
no client secret in this repo, and one token format for the whole API.

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

| Method | Path              | Auth   | Body                                        |
| ------ | ----------------- | ------ | ------------------------------------------- |
| POST   | `/register`       | —      | `{ email, password, name? }`                |
| POST   | `/login`          | —      | `{ email, password }`                       |
| POST   | `/googleAuth`     | —      | `{ token }` — a Neon Auth JWT               |
| POST   | `/refresh-token`  | —      | `{ refreshToken? }` (or the cookie)         |
| POST   | `/logout`         | —      | `{ refreshToken? }` (or the cookie)         |
| POST   | `/logout-all`     | Bearer | —                                           |
| GET    | `/me`             | Bearer | —                                           |
| GET    | `/sessions`       | Bearer | —                                           |
| DELETE | `/sessions/:id`   | Bearer | —                                           |
| POST   | `/changePassword` | Bearer | `{ currentPassword?, newPassword }`         |

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

## Google sign-in — the client half

Neon Auth runs the OAuth flow in the browser. Install `@neondatabase/neon-js` in the
frontend and point it at `VITE_NEON_AUTH_URL` (the `NEON_AUTH_BASE_URL` value):

```ts
// src/auth.ts
import { createAuthClient } from "@neondatabase/neon-js/auth";

export const authClient = createAuthClient(import.meta.env.VITE_NEON_AUTH_URL, {
  // The SPA and Neon Auth are on different origins, so the session cookie has to be
  // sent explicitly or authClient.token() comes back undefined.
  fetchOptions: { credentials: "include" },
});
```

```ts
// 1. Send the user to Google. Neon handles the handshake and redirects back.
await authClient.signIn.social({
  provider: "google",
  callbackURL: window.location.origin,
});

// 2. On return, trade the Neon Auth JWT for a NexusAI session.
const { data } = await authClient.token();

const res = await fetch("http://localhost:3003/api/v1/user/googleAuth", {
  method: "POST",
  headers: { "content-type": "application/json" },
  credentials: "include",              // so our httpOnly cookies get stored
  body: JSON.stringify({ token: data.token }),
});
const { data: session } = await res.json();   // { user, accessToken, ... }
```

From here on the frontend only talks to the NexusAI API — the Neon Auth token is not
needed again.

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
   flips cookies to `Secure; SameSite=None`).

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

| Scope                                     | Window | Limit |
| ----------------------------------------- | ------ | ----- |
| all `/api/v1/user` routes                 | 15 min | 100   |
| `/login`, `/googleAuth`, `/changePassword`| 15 min | 10    |
| `/register`                               | 1 h    | 10    |

Credential endpoints key on **IP + email**, so one attacker cannot lock a victim out by
burning the limit from a single address, and a distributed spray against one account
still gets counted. Counters are in-process — move them to Redis
(`rate-limit-redis`) before running more than one instance.

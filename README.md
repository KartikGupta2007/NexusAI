# NexusAI

A Perplexity-style AI answer engine. You ask a question; NexusAI searches the web, reads the
results, answers from them with Claude, and cites the pages it actually used — streaming the answer
token by token. It remembers durable facts about you across conversations, keeps a rolling summary
of each thread, and meters usage in credits.

---

## Features

| Feature | What it does |
| --- | --- |
| **AI chat** | Claude answers each question from retrieved material, streamed over SSE. |
| **Web search** | Every question triggers a Tavily search; the answer is grounded in those results. |
| **Citations** | Claude cites source ids it was actually given; only resolvable ids are persisted. |
| **Conversation history** | Threads with messages, titles, and a sidebar ordered by recent activity. |
| **Semantic memory** | Durable, user-scoped facts extracted from turns, embedded locally and recalled by similarity. |
| **Conversation summaries** | One rolling summary per thread, rewritten after each turn instead of replaying the transcript. |
| **Local embeddings** | BAAI BGE-M3 runs in-process via `@huggingface/transformers` — no embedding API, no per-call cost. |
| **Streaming** | Server-Sent Events: `start` → `token`… → `sources` → `done`, with in-band `error`. |
| **Credits** | Each answered query costs credits; an empty balance is refused before any provider is called. |
| **Password auth** | Registration and login with bcrypt, httpOnly cookies, rotating refresh tokens with reuse detection. |
| **Google auth** | Delegated to Neon Auth (managed Better Auth), driven entirely from the backend. |
| **Source persistence** | Citations are stored against the assistant message and re-readable later. |

---

## Architecture

```
                        Browser (React SPA)
                               │
                               │  HTTPS + SSE, only ever to /api/v1
                               ▼
                        NexusAI Backend (Express)
                               │
        ┌──────────────┬───────┴───────┬──────────────┬──────────────┐
        ▼              ▼               ▼              ▼              ▼
   Neon Auth      Neon Postgres     Tavily        Claude         BGE-M3
  (Google OAuth)   (+ pgvector)   (web search)  (Anthropic)   (in-process)
```

**The frontend never talks to anything but the NexusAI API.** It holds no database client, no
connection string, no auth-provider SDK, no provider API key — and no environment variables at all.
Its entire network surface is the relative path `/api/v1`. Everything else is reached from the
server, where the credentials live.

This is enforced, not just intended: `frontend/src/test/architecture.test.ts` scans the source tree
and `package.json` on every test run and fails if a Neon package, a database client, another auth
provider, a `VITE_` variable, or an `import.meta.env` read appears.

---

## Tech Stack

**Backend** — Node ≥ 20, TypeScript, Express 5, `tsx` (runs TypeScript directly; no build step in
development), `pg`, Zod 4 for validation, `jsonwebtoken` for NexusAI sessions, `jose` for Neon Auth
JWKS verification, `bcrypt`, `helmet`, `cors`, `cookie-parser`, `express-rate-limit`.

**AI / data** — Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) against `claude-opus-5`, `@tavily/core`
for search, `@huggingface/transformers` running BAAI BGE-M3 locally for embeddings, pgvector for
similarity search.

**Frontend** — React 19, Vite 8, React Router 7, `react-markdown` + `remark-gfm`. No state library,
no UI framework, no CSS framework — plain CSS with design tokens.

**Testing** — `node:test` (backend), Vitest + Testing Library + jsdom (frontend), ESLint.

---

## Project Structure

```
NexusAI/
├── README.md                  this file
├── backend/
│   ├── AUTH.md                authentication reference (endpoints, session model, Google flow)
│   ├── package.json
│   └── src/
│       ├── server.ts          boots: migrations → DB check → listen → signal handling
│       ├── app.ts             Express app: helmet, CORS, parsers, route mounts, error handlers
│       ├── constants.ts       every tunable and prompt in one place
│       ├── config/env.ts      Zod-validated environment; fails loudly at startup
│       ├── routes/            chat, conversation, message, user
│       ├── controllers/       HTTP shape only — parse, call a service, format the reply
│       ├── services/          the actual logic (chat pipeline, providers, auth, credits, memory)
│       ├── repositories/      all SQL; every read and write is ownership-scoped
│       ├── middlewares/       auth, validation, rate limiting, error handling
│       ├── validators/        Zod schemas per route
│       ├── db/
│       │   ├── pool.ts        pooled connection + withTransaction
│       │   ├── migrate.ts     forward-only runner, tracked in schema_migrations
│       │   └── migrations/    001…008, applied in filename order
│       ├── scripts/           verifyEmbeddings.ts
│       └── test/              helpers/, integration/, repositories/, services/
└── frontend/
    ├── vite.config.ts         dev proxy /api → 127.0.0.1:3003, plus Vitest config
    └── src/
        ├── main.tsx           BrowserRouter + AppProvider
        ├── App.tsx            shell, routes, lazily-loaded pages
        ├── api/               client.ts (the one fetch wrapper), auth, user, chat, conversations, sse, errors
        ├── state/             AppContext (session, credits, sidebar), chatReducer (thread state)
        ├── hooks/             useChatStream, useStickToBottom
        ├── pages/             LoginPage, ChatPage
        ├── components/        Composer, Message, Sidebar, Markdown, Citation, SourceList, CreditMeter, …
        ├── styles/            tokens.css, app.css
        └── test/              app, auth, ui, sse, chatApi, chatReducer, architecture + helpers/
```

---

## Backend Architecture

```
Route  →  Middleware        →  Controller       →  Service            →  Repository
          requireAuth          HTTP shape only     logic, orchestration   all SQL
          validateBody/Params                      provider calls         ownership-scoped
          rate limiters
```

Rules the layering actually enforces:

- **Controllers hold no logic and no SQL.** They read `req.user`, call one service, format a reply.
- **Repositories hold all SQL**, and every query is scoped by owner — ownership lives in the
  `WHERE` clause, not in a check above it. A foreign id returns nothing rather than being rejected
  after the fact, so an IDOR needs a SQL bug, not just a missing guard.
- **Services take provider "executors" as optional arguments.** Omitted, they use the real Tavily
  and Anthropic clients; tests inject stubs. This is why the pipeline is testable without a network.
- **`req.user.id` is the only identity.** It comes from a verified token, never from a request body.

---

## AI Pipeline

One turn, in order — the order is load-bearing:

```
1. requireAuth                  identity from the access token
2. ownership check              (continue only) foreign conversation → 404, costs nothing
3. deductQueryCredit            charged BEFORE the stream opens, so an empty balance is a real 402
4. create conversation          (new chat only) with a deterministic title, then emit `start`
5. store the user's message     first, so a later failure still leaves the question in the thread
6. retrieval ∥ search           conversation summary + recent messages + memories, and Tavily, in parallel
7. buildAnswerPrompt            labelled blocks: summary, recent, memories, web_results, question
8. Claude (streamObject)        schema-constrained: { answer, title, citations[] }; deltas → `token`
9. store the assistant message  only after Claude answers, so a failure leaves no empty turn
10. mapCitationsToSources       only ids Claude was actually offered can resolve
11. attachMessageSources        persisted, then emitted as `sources`
12. touchConversation           updated_at advances, so the sidebar reorders
13. emit `done`                 { conversationId, title, creditsRemaining }
14. postAnswer (not awaited)    summary refresh + memory extraction
```

Step 3 before step 4 is deliberate: once the first SSE byte ships, the status is fixed at 200 and a
failure can only be reported in-band. Everything rejectable — auth, validation, ownership, credits —
is resolved while a real status code is still possible.

Untrusted content is labelled as data in the prompt. Web pages are attacker-reachable, so the system
prompt states plainly that text inside `<web_results>`, `<memories>`, `<conversation_summary>` and
`<recent_messages>` is content to be summarised, never instructions to obey.

---

## Memory System

- **Model** — BAAI BGE-M3 (`Xenova/bge-m3`), int8, run in-process by `@huggingface/transformers`.
  Weights download once (~570 MB) to `backend/.model-cache` and are reused from disk.
- **Dimensions** — 1024, the model's hidden size. The number lives in `EMBEDDING_DIMENSIONS`
  (`constants.ts`) and in the `vector(1024)` column; `npm run verify:embeddings` asserts the
  constant, the live model output and the column all agree, so a mismatch fails loudly.
- **Storage** — `vector_memories`, pgvector, cosine distance (`<=>`).
- **User scoping** — `user_id` is `NOT NULL` and every read filters on it. One account's memories
  can never surface in another's retrieval. Deleting a user erases their memories by cascade.
- **What gets stored** — only Claude-extracted, privacy-filtered knowledge. The extraction prompt
  forbids credentials, financial data, sensitive personal information, and raw transcript copies.
  An empty result is common and correct.
- **Duplicate suppression** — a unique index on `(user_id, md5(content))` means re-extracting a
  known fact is a no-op instead of a new row.
- **Relevance floor** — hits beyond `MEMORY_DEFAULT_MAX_DISTANCE` (0.6 cosine) are dropped; a
  thin memory table would otherwise return unrelated nearest neighbours as "relevant context".

---

## Conversation Summary

One row per conversation in `conversation_summaries`, rewritten (not appended) after each turn by
`postAnswer`. It is a fixed-size substitute for older messages, so retrieval sends the summary plus
the last few messages rather than a growing transcript. Summaries are conversation-scoped and read
through the owning user, so they are unreachable across accounts.

A failed summary refresh is swallowed and logged: the answer is already delivered, and losing a
summary must not turn a served answer into an error. Nothing is fabricated — the previous summary
simply stands.

---

## Web Search and Citations

```
Tavily results  →  numbered source_1…source_N in the prompt
                →  Claude returns a citation id list
                →  mapCitationsToSources() resolves ids against what was actually offered
                →  message_sources rows (position 1..N, unique per message)
                →  GET /api/v1/messages/:messageId/sources
                →  source cards in the UI
```

Because resolution goes through the offered set, a hallucinated URL cannot be stored — an
unrecognised id is dropped. Duplicates are removed and ordering is preserved. Sources hang off the
assistant message id and are read-only over HTTP: they are provenance, not user input, so there is
no endpoint that lets a client rewrite them.

---

## Authentication

```
Browser  →  NexusAI Backend  →  Neon Auth (managed Better Auth)  →  Google
```

The browser never contacts Neon Auth. It has no Neon Auth URL, no SDK, and never holds a Neon
cookie or token.

**Password** — `bcrypt` (12 rounds). Login equalises response time against a dummy hash so timing
does not reveal which emails are registered, and an unknown email returns the same 401 as a wrong
password.

**Sessions** — a stateless HS256 access token plus a refresh token stored as a SHA-256 digest, so a
database leak cannot be replayed. Refresh tokens are single-use: every refresh rotates them, and
presenting a consumed one revokes the entire rotation family (that device's chain). Both arrive as
httpOnly cookies *and* in the response body — browsers use the cookies, native and CLI clients use
`Authorization: Bearer`. `requireAuth` reloads the user from Postgres on every request, so a deleted
account stops working immediately rather than at token expiry.

**Google** — OAuth is a user-agent flow, so the browser's whole part is one navigation:

```js
window.location.assign("/api/v1/user/googleAuth/start");
```

Everything else runs server-side: the backend asks Neon Auth to begin a Google flow, stores the
returned challenge in an httpOnly cookie scoped to that path, and redirects the browser onward.
When Neon returns the browser to `/api/v1/user/googleAuth/callback`, the backend exchanges the
verifier for a Neon session, fetches a Neon Auth JWT, signs the Neon session out again, verifies the
JWT against Neon's JWKS (EdDSA/Ed25519, issuer-pinned), finds-links-or-creates the NexusAI user, and
redirects back holding NexusAI cookies. A failure redirects to `/?googleAuth=incomplete|conflict|failed`
and the SPA renders the reason.

`POST /api/v1/user/googleAuth` still accepts a Neon Auth JWT directly. Browsers cannot use it —
they have no way to obtain such a token, by design — but native apps and CLIs that run their own
handshake can. Both paths converge on one `resolveGoogleUser()`, so find-link-or-create has a single
implementation.

**Account linking** — a Google identity arriving for an email that already has a password account is
linked only if Neon reports the address as verified. Otherwise it returns
`409 EMAIL_NOT_VERIFIED_FOR_LINKING`, because linking an unverified identity onto an existing
account is an account takeover.

Full endpoint and session detail: [`backend/AUTH.md`](backend/AUTH.md).

---

## Credits

| Value | Source of truth | Current |
| --- | --- | --- |
| Signup grant | `SIGNUP_CREDITS` in `backend/.env`, defaulting to `DEFAULT_USER_CREDITS` in `src/constants.ts` | 500 |
| Cost per query | `CREDITS_PER_QUERY` in `src/constants.ts` | 20 |

Those are the only places the numbers exist — `008_user_credits.sql` names the constant in a comment
for the column default, and the frontend never computes a balance, it only displays what the backend
reports (`/user/me` on load, then `creditsRemaining` on each `done`).

The charge happens after validation and ownership but before any provider call. With an insufficient
balance the request returns **HTTP 402 `INSUFFICIENT_CREDITS`** as JSON: no SSE stream opens, no
conversation or message is created, and neither Tavily nor Claude is called. The deduction is a
single conditional UPDATE, so concurrent requests cannot double-spend the same credit.

**Charges are not refunded** — not on a provider failure, and not when the client disconnects
mid-stream. Reversing a committed charge from inside a half-finished streaming response has worse
failure modes (double refunds, refunds for work that completed) than occasionally charging for a
failed answer. Revisit alongside a real ledger.

---

## Environment Variables

Never commit real values. `backend/.env` is gitignored; `backend/.env.example` is the template.

### Backend (`backend/.env`)

```bash
# Runtime
NODE_ENV=development                    # development | test | production
PORT=3003
HOST=127.0.0.1
CORS_ORIGINS=http://localhost:5173      # comma-separated; credentialed CORS cannot use "*"
# COOKIE_DOMAIN=                        # only when API and frontend share a parent domain

# Neon / Lakebase Postgres — written by `neon checkout <branch>`
DATABASE_URL=postgresql://…             # -pooler endpoint, for request traffic
DATABASE_URL_UNPOOLED=postgresql://…    # direct endpoint, required for migrations
NEON_BRANCH=

# Neon Auth (managed Better Auth) — powers Google sign-in
NEON_AUTH_BASE_URL=https://….neonauth.….neon.tech/…/auth
NEON_AUTH_JWKS_URL=                     # derived from the base URL if omitted

# NexusAI sessions — generate with: openssl rand -base64 48
ACCESS_TOKEN_SECRET=<48+ random bytes>
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_SECRET=<48+ random bytes>
REFRESH_TOKEN_EXPIRY=10d

BCRYPT_SALT_ROUNDS=12
SIGNUP_CREDITS=500

# Providers
ANTHROPIC_API_KEY=<key>
TAVILY_API_KEY=<key>                    # without it, search returns 503 SEARCH_NOT_CONFIGURED

# Optional — relocate the BGE-M3 weight cache (default: backend/.model-cache)
# EMBEDDING_CACHE_DIR=
```

`src/config/env.ts` validates all of this with Zod at startup and throws with a per-field list if
anything is missing or malformed. Misconfiguration fails at boot, not on the first request.

### Frontend

**None.** `frontend/.env` declares no variables and `frontend/.env.example` documents why. The SPA
calls the relative path `/api/v1`, so there is no base URL to configure and no credential it needs.

Anything named `VITE_*` is compiled into the JS bundle and served to every visitor — it must never
carry an API key, a database URL, or a token. If a value is secret, or only exists to reach a
service the browser has no business reaching, it belongs in `backend/.env`.

---

## Local Development

Two terminals. Node ≥ 20.

```bash
# ── Backend ──────────────────────────────────────────────
cd backend
npm install
cp .env.example .env            # then fill it in (see above)
neon checkout production        # optional: writes DATABASE_URL* and NEON_AUTH_* for you
npm run migrate                 # forward-only; safe to re-run
npm run dev                     # tsx watch → http://127.0.0.1:3003

# ── Frontend ─────────────────────────────────────────────
cd frontend
npm install
npm run dev                     # → http://localhost:5173
```

Open **http://localhost:5173**. Vite proxies `/api` to the backend, so the SPA and API share an
origin in development: the auth cookies are first-party, there is no CORS preflight, and the client's
base URL stays `/api/v1` exactly as in production.

Keep the frontend on port **5173** — it is the value in `CORS_ORIGINS`, and the Google redirect
endpoints validate the request origin against that list. If Vite reports "Port 5173 is in use" and
falls back to 5174, Google sign-in returns 400 until you free the port or add the new origin.

### All scripts

| Backend | What it does |
| --- | --- |
| `npm run dev` | `tsx watch src/server.ts` |
| `npm run migrate` | Applies unapplied migrations over the direct connection |
| `npm test` | `node:test` over `src/test/**/*.test.ts` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | `tsc` → `dist/`, then copies `migrations/` |
| `npm start` | `node dist/server.js` |
| `npm run verify:embeddings` | End-to-end embedding + pgvector check against the live DB |

| Frontend | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on 5173 with the `/api` proxy |
| `npm test` | Vitest (jsdom) |
| `npm run typecheck` | `tsc -b` |
| `npm run lint` | ESLint |
| `npm run build` | `tsc -b && vite build` → `dist/` |
| `npm run preview` | Serves the production build |

---

## API Overview

All paths are prefixed `/api/v1`. Success bodies are `{ success, message, data? }`; failures are
`{ success: false, code, message, errors[] }`.

### Authentication — `/user`

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| POST | `/user/register` | — | `{ email, password, name? }` |
| POST | `/user/login` | — | `{ email, password }` |
| GET | `/user/googleAuth/start` | — | — → 302 to Google (browsers) |
| GET | `/user/googleAuth/callback` | — | — → 302 back to the app (browsers) |
| POST | `/user/googleAuth` | — | `{ token }` — a Neon Auth JWT (native/CLI clients) |
| POST | `/user/refresh-token` | — | `{ refreshToken? }` (or the cookie) |
| POST | `/user/logout` | — | `{ refreshToken? }` (or the cookie) |
| POST | `/user/logout-all` | Bearer | — |
| GET | `/user/me` | Bearer | — |
| GET | `/user/sessions` | Bearer | — |
| DELETE | `/user/sessions/:sessionId` | Bearer | — |
| POST | `/user/changePassword` | Bearer | `{ currentPassword?, newPassword }` |

### Chat — `/chat` (SSE)

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| POST | `/chat/new` | Bearer | `{ query }` — creates the conversation and answers |
| POST | `/chat/:conversationId` | Bearer | `{ query }` — continues an existing thread |

### Conversations and messages

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| GET | `/conversations` | Bearer | The user's threads, most recently active first |
| GET | `/conversations/:conversationId` | Bearer | One thread with its messages |
| GET | `/messages/:messageId/sources` | Bearer | The citations under one assistant message |

### Other

`GET /health` → `{ success: true, message }`. No auth, no database access.

### Rate limits

| Scope | Window | Limit |
| --- | --- | --- |
| all `/api/v1/user` routes | 15 min | 100 |
| `/login`, `/googleAuth*`, `/changePassword` | 15 min | 10 |
| `/register` | 1 h | 10 |

Credential endpoints key on **IP + email**, so one attacker cannot lock a victim out from a single
address, and a distributed spray against one account is still counted. Successful requests are
skipped, so a completed sign-in costs nothing against the limit.

---

## SSE Protocol

Chat responses stream as Server-Sent Events. Frames are `event: <name>\ndata: <json>\n\n`.

| Event | Payload | When |
| --- | --- | --- |
| `start` | `{ conversationId }` | Once the conversation id is known — first frame. |
| `token` | `{ text }` | Incremental answer text, in order. Concatenating every `token` yields exactly the stored assistant message. |
| `sources` | `{ sources }` | After persistence, so the ids are real. Always after the last `token`. |
| `done` | `{ conversationId, title, creditsRemaining }` | Terminal. `title` is a string for `/chat/new` and `null` for a continued chat — a thread is never silently renamed. |
| `error` | `{ code, message }` | Terminal. Only used once the stream is open. |

Failures *before* the stream opens are ordinary HTTP responses with real status codes — 400, 401,
402, 404. Once the first byte ships the status is fixed at 200, so anything after that arrives as an
`error` event. Unexpected errors are reported as `INTERNAL_ERROR` with a generic message; provider
detail is logged server-side and never streamed.

---

## Database

Neon Postgres (Lakebase) with pgvector. Forward-only migrations in
`backend/src/db/migrations/`, applied in filename order, each in its own transaction, recorded in
`schema_migrations`. `npm run migrate` is idempotent — a second run reports "database already up to
date". They run over `DATABASE_URL_UNPOOLED` because PgBouncer's transaction mode cannot execute the
session-level statements DDL needs.

| Migration | Adds |
| --- | --- |
| `001_init_auth.sql` | `users`, `refresh_tokens`, `pgcrypto`, the `set_updated_at` trigger |
| `002_chat.sql` | `conversations`, `messages` |
| `003_pgvector.sql` | the `vector` extension |
| `004_conversation_summaries.sql` | `conversation_summaries` |
| `005_vector_memories.sql` | `vector_memories` with `vector(1024)` |
| `006_message_sources.sql` | `message_sources` |
| `007_message_sources_blank_checks.sql` | blank-value CHECK constraints on sources |
| `008_user_credits.sql` | `users.credits` |

### Relationships

```
users ──┬─< refresh_tokens                        ON DELETE CASCADE
        ├─< conversations ──┬─< messages ──< message_sources    all CASCADE
        │                   └─< conversation_summaries          CASCADE
        │                        └── last_message_id → messages SET NULL
        └─< vector_memories                       CASCADE
                 └── conversation_id → conversations  SET NULL
```

A memory outlives the conversation that produced it — that is the point of extracting durable
knowledge rather than storing transcripts — so deleting a conversation keeps the memory and only
forgets its provenance. Deleting a user erases everything they own.

### Constraints worth knowing

- `users`: `CHECK (password_hash IS NOT NULL OR neon_auth_user_id IS NOT NULL)` — every row has a
  usable credential, which is why `password_hash` can be nullable for Google-only accounts.
- `users`: emails stored lowercased (`CHECK (email = lower(email))`) plus a unique index, so
  `A@b.com` and `a@b.com` cannot both register. `credits >= 0`.
- `refresh_tokens`: stores `token_hash`, not the token. There is no `access_token` column anywhere —
  access tokens are stateless and short-lived; persisting them would add a write per request.
- `messages`: `role IN ('user','assistant','system')`.
- `message_sources`: unique `(message_id, position)`, positions from 1, non-blank url and title.
- `vector_memories`: unique `(user_id, md5(content))` for duplicate suppression; non-blank content.

---

## Testing

| Suite | Command | Result |
| --- | --- | --- |
| Backend unit + integration | `cd backend && npm test` | **267 passed / 267**, 47 suites, 0 failed |
| Backend typecheck | `npm run typecheck` | clean |
| Backend build | `npm run build` | clean |
| Embedding + pgvector verification | `npm run verify:embeddings` | all checks passed |
| Frontend unit + integration | `cd frontend && npm test` | **101 passed / 101**, 7 files, 0 failed |
| Frontend typecheck | `npm run typecheck` | clean |
| Frontend lint | `npm run lint` | clean |
| Frontend build | `npm run build` | clean, 298 modules |

Counts are from the final verification run described below.

**Backend tests** run against the real Neon database — most of what is under test (CHECK constraints,
cascades, pgvector distance, ownership in `WHERE` clauses) is Postgres behaviour, not TypeScript, and
a mocked repository would only prove the mock was called. Isolation comes from ownership: every row
is created under a freshly generated probe user, and cleanup deletes those users, cascading
everything they own. Provider calls are stubbed through the executor seams, so **no test reaches
Tavily or Anthropic**. Integration tests boot the real Express app on an ephemeral port and drive it
over HTTP.

**Frontend tests** mount the real application — real router, real provider, real hooks — against a
fake backend that speaks the genuine wire format, including byte-level SSE frames. They cover the
new-chat and follow-up flows, streaming into one message, source rendering, credit presentation,
title and sidebar updates, refresh restoring a conversation, switching threads, the composer's
guards, stopping a stream, and each error path.

`architecture.test.ts` is a boundary guard rather than a behaviour test: it reads the source tree and
fails if the frontend gains a Neon package, a database client, another auth provider, a `VITE_`
variable, or an environment read.

---

## End-to-End Verification

The system was verified as one running application — real frontend dev server, real backend, real
Neon, real Tavily, real Claude — not only through unit tests. **139 automated end-to-end checks
passed.** Probe users lived under `@probe.nexusai.test` and were deleted afterwards; the cleanup
pass confirmed zero probe rows and zero orphaned conversations, messages, sources, memories or
summaries.

What that covered: password registration/login/rejection/`/user/me`/logout and token rejection
(missing, malformed, forged, expired); a full new-chat turn end to end with database inspection
afterwards (conversation, both messages, 5 persisted sources, title, credit decrement, summary);
a contextual follow-up that resolved "they" from prior context, kept the title, advanced
`updated_at`, and updated rather than duplicated the summary; semantic memory written with a
1024-dimensional L2-normalised embedding and recalled in a *different* conversation, with
cross-user isolation and duplicate suppression; the credit ladder to 402 with proof that no stream
opened and no rows were written; concurrent double-spend prevention; client abort; IDOR attempts
across conversations, messages and sources; a request body attempting to smuggle `userId`,
`credits` and `conversationId`; the error matrix (400/401/402/404) with a leak audit for stack
traces, keys, SQL, paths and tokens; and the Vite proxy carrying authenticated, cookie-setting
requests to the backend.

Measured on this machine (macOS, warm caches):

| Observation | Value |
| --- | --- |
| Backend cold start → healthy | ~5.4 s (includes `tsx` compile, migration check, DB connect) |
| Embedding cold start (weights on disk) | ~1.7 s |
| Embedding warm | ~12 ms per call (~13 ms average over 5) |
| Tavily search (`advanced`, 8 results) | ~4.4 s |
| First SSE `token` | ~7.9–8.5 s (Tavily, then Claude's time to first token) |
| Full turn (`start` → `done`) | ~17–20 s |
| Frontend build | 115 ms, 298 modules |
| Bundle: entry | 243.61 kB / **78.29 kB gzip** |
| Bundle: markdown renderer (lazy) | 156.18 kB / 46.81 kB gzip |
| Bundle: ChatPage / LoginPage (lazy) | 14.63 kB / 5.06 kB gzip · 2.89 kB / 1.19 kB gzip |
| Bundle: CSS | 25.90 kB / 6.00 kB gzip |

First-token latency is dominated by the Tavily search, which is sequential with generation by
design — the answer must be grounded in results that exist before Claude starts.

---

## Production Considerations

### Implemented

- **Environment validation** — Zod-checked at startup; misconfiguration fails at boot.
- **Secrets server-side only** — nothing sensitive is reachable from the browser; enforced by test.
- **CORS** — explicit origin allowlist with credentials; `"*"` is impossible for credentialed
  requests. Also gates the Google redirect endpoints.
- **Security headers** — `helmet`, `x-powered-by` disabled.
- **Rate limiting** — per-route limiters, credential endpoints keyed on IP + email.
- **Session security** — httpOnly cookies, `Secure`/`SameSite=None` under `NODE_ENV=production`,
  hashed single-use refresh tokens with rotation-family reuse detection, revocation on password
  change, expired-token pruning every 6 hours.
- **IDOR protection** — ownership in the SQL predicate on every read and write; foreign and
  nonexistent resources are indistinguishable.
- **Prompt-injection posture** — retrieved content is labelled as untrusted data in the system prompt.
- **Error hygiene** — no stack traces, keys, SQL, connection strings or paths in any response body.
- **Migrations** — forward-only, transactional, tracked, idempotent, over the direct connection.
- **Graceful shutdown** — SIGINT/SIGTERM close the server and pool, with a 10 s hard timeout so an
  in-flight stream cannot hold the process open.
- **`trust proxy`** — set, so rate limiters key on the client address behind a load balancer.

### Future / recommended — not implemented

- **Rate-limit store** — counters are in-process. Move to `rate-limit-redis` before running more
  than one instance, or the effective limit multiplies by instance count.
- **`postAnswer` durability** — fire-and-forget (see Known Limitations). A queue would make it
  survive a crash or restart.
- **Monitoring / alerting** — none. No metrics, tracing, error reporting or uptime checks; the only
  observability is `console` output.
- **Database backups** — relies on Neon's branch history. No independent backup or restore drill.
- **Migration rollback** — forward-only by design; there are no `down` scripts.
- **Access-token TTL** — currently `1d` in the checked-in config. 15 m–1 h is the usual production
  choice; revocation only bites at expiry, though `requireAuth`'s per-request user reload means a
  deleted account stops working immediately regardless.
- **Google OAuth credentials** — Neon's shared development credentials work on localhost. For
  production, register your own Google OAuth client with redirect URI
  `${NEON_AUTH_BASE_URL}/callback/google` (the Neon host, *not* your app URL), add it in the Neon
  Console, and trust your origins with `neon neon-auth domain add https://app.example.com`.
- **Horizontal scaling** — the app is stateless apart from the rate-limit counters and the
  in-process embedding model. Each instance loads its own ~570 MB of weights, so memory per
  instance is substantial; a shared embedding service would amortise that.
- **HTTPS** — terminate at the load balancer. `NODE_ENV=production` flips cookies to
  `Secure; SameSite=None`, which requires it.
- **Credit ledger** — the balance is a single column. There is no transaction history, so a charge
  cannot be audited or reversed.

---

## Known Limitations

Found or confirmed during the final audit. None are hidden behind a passing test.

1. **`postAnswer` is fire-and-forget.** The summary refresh and memory extraction start after the
   answer is returned and are never awaited by the request. A process restart mid-task loses that
   turn's summary update and memories silently — the answer is already saved, so nothing signals the
   loss. Failures are caught and logged, never surfaced.

2. **"Stop" is a client-side abort, not server-side cancellation.** Aborting the stream stops token
   delivery immediately and the partial answer stays on screen, but the server completes the turn:
   verification confirmed that ~45 s after an abort the full 4451-character answer, 5 sources, the
   summary and 5 memories were all persisted. So reloading after pressing Stop shows the *complete*
   answer, not the partial one, and the Claude tokens are still paid for. The credit charge is
   therefore consistent, but the UX implies cancellation that does not happen.

3. **Credits are never refunded.** A Tavily outage, a Claude failure, or a client disconnect still
   costs a full query. Deliberate — see Credits — but user-visible.

4. **No ANN index on embeddings.** `vector_memories` has no HNSW/IVFFlat index. Deliberate and
   documented in `005_vector_memories.sql`: searches pre-filter by `user_id`, and a filtered ANN
   scan can return fewer than the requested K, while an exact scan over one user's small candidate
   set is both faster and always correct. Add the HNSW index (the statement is in that migration's
   comment) once a single user's memory count reaches the low thousands.

5. **First-token latency is ~8 s.** The Tavily search (~4.4 s) runs before generation begins,
   because the answer must be grounded in results that exist first. There is no cache and no
   "answer first, cite later" path.

6. **Rate-limit counters are in-process.** Correct for one instance, wrong for several.

7. **Access-token expiry is `1d` in the checked-in configuration**, longer than the 15 m the code
   comments recommend.

8. **Google OAuth has not been verified end to end.** The backend halves are tested — challenge
   issuance, verifier exchange, JWKS verification, find-link-or-create, session issuance, invalid
   and expired and wrong-issuer and foreign-key token rejection, origin allowlisting, and every
   failure redirect — using a stand-in at the `fetch` boundary. The two browser hops through
   Google's consent screen and Neon's callback cannot be automated here and were **not** exercised
   against live Google. See below.

9. **No browser-driven UI test.** There is no Playwright/Puppeteer in the project and none was
   added. The jsdom suite mounts the real application against a fake backend speaking the real wire
   format and covers streaming, sources, credits, titles, sidebar, refresh, thread switching, stop
   and every error path — but real-browser rendering, layout and responsive behaviour were not
   machine-verified.

10. **429 and live provider failures were not exercised end to end.** Tripping a rate limiter would
    have blocked the rest of the audit for 15 minutes, and provider outages cannot be induced on
    demand; both are covered in the unit suites with injected failures.

### Manual verification still required

Two short passes a person needs to do in a browser:

1. **Google sign-in** — with the frontend on `http://localhost:5173`, click *Continue with Google*,
   complete the consent screen, and confirm you land back in the app signed in, with a credit
   balance and a working chat. Then check that `frontend/.env` is still empty and that the browser
   devtools Network tab shows no request to any `neonauth` host.
2. **UI pass** — submit a query and watch tokens stream, confirm source cards link out, press Stop
   mid-answer, refresh on `/chat/:conversationId` and confirm the thread restores, switch
   conversations and confirm no state leaks between them, and check the layout at mobile width.

---

## License

ISC. Author: Kartik Gupta.
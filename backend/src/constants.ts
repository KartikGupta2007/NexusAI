export const SYSTEM_PROMPT = `
YOU DON'T HAVE ACCESS TO ANY TOOLS. You are being given all the context that is needed
to answer the query.

You also need to return follow up questions to the user based on the question they have asked.
The response needs to be structured like this -

<ANSWER>
This is where the actual query should be answered
</ANSWER>

<FOLLOW UPS>
    <question>first follow up question</question>
    <question>second follow up question</question>
    <question>third follow up question</question>
</FOLLOW UPS>

Example -

Query = I want to learn rust, can u suggest me the best ways to do it

Response -

<ANSWER>
For sure, the best resource to learn rust is the rust book
</ANSWER>

<FOLLOW UPS>
    <question>How can I learn advanced rust</question>
    <question>How is rust better than typescript</question>
</FOLLOW UPS> 
`

export const PROMPT_TEMPLATE = `
## Web search results
{{WEB_SEARCH_RESULTS}}

## USER_QUERY
{{USER_QUERY}}
`

export const MODEL = "claude-opus-5";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const DEFAULT_MAX_TOKENS = 64_000;
export const UNIQUE_VIOLATION = "23505";

export const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.eGVjhtaC3MFvGGF9uAiDLg9OQvKcxJm";

export const ACCESS_COOKIE = "accessToken";
export const REFRESH_COOKIE = "refreshToken";

/**
 * Rewrites the rolling conversation summary after a completed turn.
 *
 * Given the previous summary plus what has happened since, Claude returns one replacement
 * summary — not an append. The summary is a fixed-size substitute for the older messages,
 * so it has to stay short as the conversation grows.
 */
export const CONVERSATION_SUMMARY_PROMPT = `
You maintain a running summary of a conversation between a user and NexusAI.

## Previous summary
{{PREVIOUS_SUMMARY}}

## Messages since that summary
{{RECENT_MESSAGES}}

Write an updated summary that replaces the previous one.

Rules:
- Keep it under 200 words. It substitutes for older messages, so it must not grow without bound.
- Preserve durable facts: what the user is working on, decisions reached, stated preferences,
  and unresolved threads.
- Drop pleasantries, restated questions, and anything already superseded.
- Write plain prose in the third person. No headings, no bullet lists, no preamble.
- Do NOT include passwords, API keys, tokens, secrets, credentials, financial details, or
  sensitive personal information, even if the user supplied them. Refer to them only in the
  abstract if the conversation cannot be understood without acknowledging one exists.
- Output the summary text and nothing else.
`;

/**
 * Extracts durable, reusable knowledge from a completed turn for the vector memory store.
 *
 * The privacy rules are the point of this prompt, not decoration. Anything it returns gets
 * embedded and persisted for the lifetime of the account, so the filtering has to happen
 * here — before the text reaches embedText() — rather than at retrieval time.
 *
 * An empty list is a valid and common answer: most turns produce nothing worth keeping.
 */
export const MEMORY_EXTRACTION_PROMPT = `
Extract durable knowledge worth remembering from this exchange, for use in future
conversations with the same user.

## User query
{{USER_QUERY}}

## Assistant response
{{ASSISTANT_RESPONSE}}

Return a JSON object of the form:
{"memories": ["...", "..."]}

What TO extract:
- Stable facts about the user's projects, tools, stack, goals, or stated preferences.
- General knowledge established in the exchange that would be useful again later.
- Each memory as one self-contained sentence that makes sense on its own, months from now,
  with no access to this conversation.

What NOT to extract — these must never appear in a memory:
- Passwords, API keys, access tokens, secrets, connection strings, or any authentication
  credential, in whole or in part.
- Financial information: card numbers, bank details, balances, transactions.
- Highly sensitive personal information: health, biometric, government identifiers, precise
  location, sexuality, religion, political affiliation.
- Personally identifying information that is not necessary to make the memory useful —
  no full names, addresses, phone numbers, or email addresses of the user or anyone else.
- Raw conversation messages. Do not copy or lightly paraphrase what was said; write the
  knowledge it establishes.
- One-off, time-bound, or trivial details: greetings, the current weather, a passing typo.

If nothing in this exchange is genuinely useful to remember, return {"memories": []}.
An empty list is the correct answer more often than not — prefer it to a weak memory.
Output only the JSON object.
`;


// ── Local embeddings (BAAI BGE-M3 via @huggingface/transformers) ──────────────

/**
 * BAAI BGE-M3, ONNX build packaged for transformers.js.
 *
 * Chosen over the smaller bge-*-en models because NexusAI's memories are open-domain and
 * long-lived: BGE-M3 is multilingual (so a non-English query can retrieve a memory stored
 * in another language) and accepts 8192 tokens, where the bge-en family caps at 512.
 */
export const EMBEDDING_MODEL_ID = "Xenova/bge-m3";

/**
 * 1024, the model's hidden size. Verified from BAAI/bge-m3's own config.json
 * (`hidden_size: 1024`) and its pooling config (`word_embedding_dimension: 1024`), not
 * assumed.
 *
 * This is the single source of truth for the `vector(1024)` column in
 * 005_vector_memories.sql. It lives here rather than in embedding.services.ts so that
 * vectorMemory.repository.ts can validate vector width without importing the embedding
 * service — importing that module pulls in @huggingface/transformers and the ONNX runtime,
 * which a repository has no business loading.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * int8 weights: 570 MB instead of 2.27 GB for fp32, which matters because the download is
 * blocking on first use. Change to "fp32" for maximum fidelity — the output dimension, and
 * therefore the database schema, is unaffected either way.
 */
export const EMBEDDING_DTYPE = "q8";

/** Guardrail against embedding a whole book by accident; BGE-M3's own limit is 8192 tokens. */
export const EMBEDDING_MAX_INPUT_CHARS = 32_000;

// ── Semantic memory ──────────────────────────────────────────────────────────

/**
 * The values `vector_memories.source` accepts, mirroring the CHECK constraint in
 * 005_vector_memories.sql. Declared as a tuple so the MemorySource union is derived from it
 * rather than written twice.
 */
export const MEMORY_SOURCES = ["conversation", "web_search", "user_provided"] as const;

/** Enough context to be useful without crowding out the web results and recent messages. */
export const MEMORY_DEFAULT_RECALL_LIMIT = 5;

/**
 * Cosine distance above which a hit is treated as noise.
 *
 * 0.6 distance is ~0.4 similarity. With an empty or thin memory table the nearest neighbour
 * is often unrelated, and feeding that to Claude as "relevant memory" is worse than sending
 * nothing at all.
 */
export const MEMORY_DEFAULT_MAX_DISTANCE = 0.6;

/** Guards against a summariser returning an unbounded list of "memories" for one turn. */
export const MEMORY_MAX_PER_CALL = 32;

// ── Conversation context ─────────────────────────────────────────────────────

/**
 * Four turns is enough to resolve pronouns and follow-ups without the recent window starting
 * to duplicate what the summary already covers.
 */
export const CONVERSATION_RECENT_MESSAGE_LIMIT = 4;

/** Hard ceiling on the recent-message window, so a bad `limit` cannot read a whole thread. */
export const CONVERSATION_MAX_RECENT_MESSAGES = 50;

// ── Message sources (web citations attached to an assistant message) ──────────

/**
 * Most sources one assistant message may cite.
 *
 * A citation list is read by a person, so the ceiling is a UI judgement rather than a storage
 * one — past a couple of dozen entries the list stops being useful. It also bounds how much a
 * single search provider response can write in one call.
 */
export const MESSAGE_MAX_SOURCES = 20;

/** Longest URL accepted. Comfortably above what browsers and CDNs handle in practice. */
export const MESSAGE_SOURCE_MAX_URL_CHARS = 2_048;

/** Longest source title accepted. Anything beyond this is a page that mis-set its <title>. */
export const MESSAGE_SOURCE_MAX_TITLE_CHARS = 512;

/**
 * Longest snippet stored per source. Over-long snippets are truncated rather than rejected:
 * providers return wildly varying amounts of page text, and dropping an otherwise good source
 * because its extract was verbose would be the wrong trade.
 */
export const MESSAGE_SOURCE_MAX_CONTENT_CHARS = 4_000;

// ── Tavily web search ────────────────────────────────────────────────────────

/**
 * Result count requested from Tavily.
 *
 * Eight is enough breadth for a synthesised answer without burning context on near-duplicate
 * pages. It stays at or below MESSAGE_MAX_SOURCES so a whole search can be persisted as
 * citations without anything being dropped at the message-source layer.
 */
export const TAVILY_MAX_RESULTS = 8;

/**
 * "advanced" re-ranks and extracts more relevant snippets than "basic", which matters because
 * the snippet is what Claude actually reads — the alternative is paying for a search whose
 * content is too thin to answer from. The SDK also offers "fast" and "ultra-fast".
 */
export const TAVILY_SEARCH_DEPTH = "advanced";

/** "general" over "news"/"finance": NexusAI answers open-domain questions. */
export const TAVILY_SEARCH_TOPIC = "general";

/**
 * Seconds, not milliseconds — the Tavily SDK multiplies this by 1000 itself. The SDK's own
 * default is 60s, which is far too long to keep a user waiting on one of several pipeline
 * stages.
 */
export const TAVILY_TIMEOUT_SECONDS = 15;

/**
 * Longest query sent to Tavily. Bounded well below Tavily's own documented request limit, and
 * a query longer than this is a paste rather than a question — it degrades search quality as
 * well as costing more.
 */
export const TAVILY_MAX_QUERY_CHARS = 400;

/** Favicons are opt-in on the Tavily API, and the citation UI renders them. */
export const TAVILY_INCLUDE_FAVICON = true;

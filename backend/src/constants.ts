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
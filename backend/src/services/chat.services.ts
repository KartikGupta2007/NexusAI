import {
    CHAT_MAX_QUERY_CHARS,
    CONVERSATION_TITLE_MAX_CHARS,
    SUMMARY_CONTEXT_MESSAGE_LIMIT,
    TAVILY_MAX_QUERY_CHARS,
} from "../constants.ts";
import {
    createConversation,
    renameConversation,
    createMessageForUserConversation,
    findConversationForUser,
    findRecentMessagesForUserConversation,
    touchConversation,
} from "../repositories/conversation.repository.ts";
import type { MessageSourceInput, PublicMessageSource } from "../repositories/messageSource.repository.ts";
import {
    extractMemories,
    generateAnswer,
    generateConversationSummary,
    type AnswerStreamExecutor,
    type TextExecutor,
} from "./claude.services.ts";
import { getConversationSummary, saveConversationSummary } from "./conversationSummary.services.ts";
import { rememberTexts } from "./memory.services.ts";
import { attachMessageSources } from "./messageSource.services.ts";
import { buildAnswerPrompt, mapCitationsToSources } from "./prompt.services.ts";
import { buildQueryContext } from "./retrieval.services.ts";
import { searchWeb, type TavilySearchExecutor } from "./tavily.services.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * The chat pipeline: one question in, one answered turn out.
 *
 * Every step is an existing service. This module sequences them and owns nothing else — no SQL,
 * no provider SDK, no prompt text. Both endpoints share `processChatMessage`; the only thing
 * `startNewChat` adds in front is creating the conversation.
 */

/**
 * The provider seams, threaded to the sub-services that already accept them.
 *
 * Every field is optional and an omitted one falls through to that service's real executor, so
 * production callers pass nothing. Tests supply stubs to run the pipeline without a network.
 */
export interface ChatDeps {
    search?: TavilySearchExecutor;
    answer?: AnswerStreamExecutor;
    summary?: TextExecutor;
    extract?: TextExecutor;
}

/**
 * Integration-test seam.
 *
 * Requests arriving over HTTP get their deps from here, because a controller has nowhere to
 * receive them from. Without it the routes could only be tested on paths that fail before
 * reaching a provider, leaving the credit-charge-then-stream happy path unexercised — or tested
 * against the live Tavily and Anthropic APIs. Production never calls the setter, so the override
 * is null and every request uses each service's real executor.
 */
let depsOverride: ChatDeps | null = null;

export const setChatDepsForTests = (deps: ChatDeps | null): void => {
    depsOverride = deps;
};

/** The deps an HTTP request should run with. `{}` in production. */
export const chatDepsForRequest = (): ChatDeps => depsOverride ?? {};

export interface ChatTurnResult {
    conversationId: string;
    answer: string;
    sources: PublicMessageSource[];
    /** The title Claude proposed for this turn. Informational — see `title`. */
    suggestedTitle: string | null;
    /**
     * The title this request actually wrote to the conversation, or null if it left it alone.
     *
     * Only /chat/new ever sets a title. Continuing a conversation returns null here even when
     * Claude proposed one, so a thread is never silently renamed out from under the user.
     */
    title: string | null;
    /**
     * The summary refresh and memory extraction, already running.
     *
     * Resolved, never rejected — failures are logged inside. The controller does not await it,
     * so the user is not kept waiting on two extra model calls that do not affect their answer.
     * Tests await it to assert the learning steps landed.
     */
    postAnswer: Promise<void>;
}

const normalizeQuery = (query: string): string => {
    if (typeof query !== "string") throw ApiError.badRequest("query must be a string");

    const trimmed = query.trim();
    if (trimmed.length === 0) throw ApiError.badRequest("query must not be empty");
    if (trimmed.length > CHAT_MAX_QUERY_CHARS) {
        throw ApiError.badRequest(
            `query must be at most ${CHAT_MAX_QUERY_CHARS} characters (received ${trimmed.length})`,
        );
    }
    return trimmed;
};

/** A recognisable sidebar label from the first question. No model call — this is deterministic. */
export const conversationTitleFromQuery = (query: string): string => {
    const collapsed = query.trim().replace(/\s+/g, " ");
    return collapsed.length > CONVERSATION_TITLE_MAX_CHARS
        ? `${collapsed.slice(0, CONVERSATION_TITLE_MAX_CHARS - 1).trimEnd()}…`
        : collapsed;
};

/**
 * Refreshes the summary and stores any durable memories.
 *
 * Deliberately swallows its own failures. Both are enrichment: the answer is already written and
 * returned, and losing a summary refresh must not turn a served answer into an error. Nothing is
 * fabricated on failure — a failed summary simply leaves the previous one in place.
 */
const runPostAnswerTasks = async (input: {
    userId: string;
    conversationId: string;
    query: string;
    answer: string;
    deps: ChatDeps;
}): Promise<void> => {
    const { userId, conversationId, query, answer, deps } = input;

    try {
        const [previous, recent] = await Promise.all([
            getConversationSummary(userId, conversationId),
            findRecentMessagesForUserConversation(conversationId, userId, SUMMARY_CONTEXT_MESSAGE_LIMIT),
        ]);

        const summary = await generateConversationSummary(
            {
                previousSummary: previous?.summary ?? null,
                // The repository returns newest-first; a transcript reads oldest-first.
                recentMessages: [...recent].reverse(),
            },
            deps.summary,
        );

        if (summary) {
            await saveConversationSummary(userId, conversationId, {
                summary,
                lastMessageId: recent[0]?.id ?? null,
                messageCount: recent.length,
            });
        }
    } catch (error) {
        console.error("[chat] summary refresh failed", error);
    }

    try {
        const memories = await extractMemories({ query, answer }, deps.extract);
        if (memories.length > 0) {
            await rememberTexts(userId, memories, { conversationId, source: "conversation" });
        }
    } catch (error) {
        console.error("[chat] memory extraction failed", error);
    }
};

/**
 * Runs one turn against a conversation the user already owns.
 *
 * Order matters and is load-bearing:
 *   - the user's message is written first, so a failure downstream still leaves their question
 *     visible in the thread rather than silently dropping it;
 *   - the assistant message is written only *after* Claude answers, so a model failure never
 *     leaves an empty assistant turn;
 *   - sources are attached after the assistant message exists, because they hang off its id;
 *   - the summary and memory work starts last and is not awaited.
 *
 * @throws ApiError 404 when the conversation is not the user's · 400 invalid query ·
 *         502/503/429 from search or generation.
 */
export const processChatMessage = async (
    input: { userId: string; conversationId: string; query: string },
    deps: ChatDeps = {},
    options: { onToken?: (delta: string) => void } = {},
): Promise<ChatTurnResult> => {
    const { userId, conversationId } = input;
    const query = normalizeQuery(input.query);

    const userMessage = await createMessageForUserConversation({
        conversationId,
        userId,
        role: "user",
        content: query,
    });
    // The insert is ownership-scoped, so nothing written means the conversation is not theirs.
    if (!userMessage) throw ApiError.notFound("Conversation not found");

    // Retrieval reads the summary and the thread; search is independent of both. The user
    // message is already stored, so context includes the question that was just asked.
    const [context, webResults] = await Promise.all([
        buildQueryContext({ userId, conversationId, query }),
        // Tavily caps its query length below what a chat message may be, so only the search
        // input is clipped — Claude still sees the whole question.
        searchWeb(query.slice(0, TAVILY_MAX_QUERY_CHARS), {}, deps.search),
    ]);

    const assembled = buildAnswerPrompt({
        query,
        conversationSummary: context.conversationSummary,
        recentMessages: context.recentMessages,
        relevantMemories: context.relevantMemories,
        webResults,
    });

    const generated = await generateAnswer(assembled, { onToken: options.onToken }, deps.answer);

    const assistantMessage = await createMessageForUserConversation({
        conversationId,
        userId,
        role: "assistant",
        content: generated.answer,
    });
    if (!assistantMessage) throw ApiError.notFound("Conversation not found");

    // Only ids Claude was actually offered can resolve, so a hallucinated URL cannot be stored.
    const citedSources: MessageSourceInput[] = mapCitationsToSources(
        generated.citations,
        assembled.sources,
    );
    const sources = await attachMessageSources(userId, assistantMessage.id, citedSources);

    await touchConversation(conversationId, userId);

    return {
        conversationId,
        answer: generated.answer,
        sources,
        suggestedTitle: generated.title,
        // Never renames. Retitling an established thread on every question would make the
        // sidebar shift under the user; only a new chat gets a title.
        title: null,
        postAnswer: runPostAnswerTasks({
            userId, conversationId, query, answer: generated.answer, deps,
        }),
    };
};

/**
 * Creates a conversation and answers its first question in one request.
 *
 * The conversation is created before the pipeline runs so the client gets an id back even if
 * generation fails — the thread exists with the user's question in it, and they can retry
 * against it instead of losing the turn.
 */
export const startNewChat = async (
    input: { userId: string; query: string },
    deps: ChatDeps = {},
    options: { onToken?: (delta: string) => void; onConversationCreated?: (id: string) => void } = {},
): Promise<ChatTurnResult> => {
    const query = normalizeQuery(input.query);

    // A deterministic title is written up front so the sidebar has a label from the moment the
    // conversation exists, then refined below once Claude proposes a better one. The sidebar is
    // therefore never blank and never briefly wrong.
    const fallbackTitle = conversationTitleFromQuery(query);
    const conversation = await createConversation(input.userId, fallbackTitle);
    options.onConversationCreated?.(conversation.id);

    const turn = await processChatMessage(
        { userId: input.userId, conversationId: conversation.id, query },
        deps,
        { onToken: options.onToken },
    );

    let title = fallbackTitle;
    if (turn.suggestedTitle) {
        // A failed rename is not worth losing the answer over — the fallback title stands.
        try {
            const renamed = await renameConversation(conversation.id, input.userId, turn.suggestedTitle);
            if (renamed?.title) title = renamed.title;
        } catch (error) {
            console.error("[chat] title rename failed", error);
        }
    }

    return { ...turn, title };
};

/**
 * Ownership gate for the continue endpoint.
 *
 * processChatMessage's ownership-scoped insert would catch a foreign conversation anyway, but
 * checking first means a rejected request writes nothing at all, and the 404 is identical to the
 * one a nonexistent conversation produces.
 */
export const assertConversationOwned = async (userId: string, conversationId: string) => {
    const conversation = await findConversationForUser(conversationId, userId);
    if (!conversation) throw ApiError.notFound("Conversation not found");
    return conversation;
};

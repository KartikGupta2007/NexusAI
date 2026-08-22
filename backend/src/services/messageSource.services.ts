import {
    MESSAGE_MAX_SOURCES,
    MESSAGE_SOURCE_MAX_CONTENT_CHARS,
    MESSAGE_SOURCE_MAX_TITLE_CHARS,
    MESSAGE_SOURCE_MAX_URL_CHARS,
} from "../constants.ts";
import { findMessageForUser } from "../repositories/conversation.repository.ts";
import {
    deleteMessageSourcesForUserMessage,
    findMessageSourcesForUserMessage,
    replaceMessageSources,
    toPublicMessageSource,
    type MessageSourceInput,
    type PublicMessageSource,
} from "../repositories/messageSource.repository.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Web sources cited by an assistant message.
 *
 * Provider-neutral on purpose: this service knows nothing about Tavily or any other search
 * API. A provider integration maps its own response into MessageSourceInput and calls
 * attachMessageSources(); swapping providers never reaches this file, let alone the database.
 */

/** Trimmed, length-bounded, and guaranteed non-blank. */
const normalizeSource = (source: MessageSourceInput, index: number): MessageSourceInput => {
    const label = `sources[${index}]`;

    if (!Number.isInteger(source.position) || source.position < 1) {
        throw ApiError.badRequest(`${label}.position must be an integer of 1 or greater`);
    }

    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (url.length === 0) throw ApiError.badRequest(`${label}.url must not be empty`);
    if (url.length > MESSAGE_SOURCE_MAX_URL_CHARS) {
        throw ApiError.badRequest(
            `${label}.url must be at most ${MESSAGE_SOURCE_MAX_URL_CHARS} characters`,
        );
    }

    const title = typeof source.title === "string" ? source.title.trim() : "";
    if (title.length === 0) throw ApiError.badRequest(`${label}.title must not be empty`);
    if (title.length > MESSAGE_SOURCE_MAX_TITLE_CHARS) {
        throw ApiError.badRequest(
            `${label}.title must be at most ${MESSAGE_SOURCE_MAX_TITLE_CHARS} characters`,
        );
    }

    // Snippets are truncated rather than rejected: providers return wildly varying amounts of
    // page text, and losing a good source because its extract was long is the wrong trade.
    // A blank snippet is stored as NULL so "no snippet" has one representation, not two.
    const trimmedContent = source.content?.trim() ?? "";
    const content =
        trimmedContent.length === 0
            ? null
            : trimmedContent.slice(0, MESSAGE_SOURCE_MAX_CONTENT_CHARS);

    const trimmedFavicon = source.favicon?.trim() ?? "";
    const favicon = trimmedFavicon.length === 0 ? null : trimmedFavicon;

    return { position: source.position, url, title, content, favicon };
};

/**
 * Reads the sources cited by one message.
 *
 * A message that does not exist and a message belonging to someone else both raise the same
 * 404, matching how the conversation endpoints behave. The distinction is not merely hidden in
 * the response — the repository's join means this code never learns it either.
 *
 * A message with no sources is an empty array, not an error: most messages have none.
 *
 * @throws ApiError 404 when the message does not exist or belongs to another user.
 */
export const getMessageSources = async (
    userId: string,
    messageId: string,
): Promise<PublicMessageSource[]> => {
    const message = await findMessageForUser(messageId, userId);
    if (!message) {
        throw ApiError.notFound("Message not found");
    }

    const rows = await findMessageSourcesForUserMessage(messageId, userId);
    return rows.map(toPublicMessageSource);
};

/**
 * Attaches a set of web sources to an assistant message, replacing any it already had.
 *
 * Intended for the backend's own answer pipeline, not for user input — sources are generated
 * alongside an assistant reply, never submitted by a client. It is exported as a service
 * rather than an endpoint for exactly that reason.
 *
 * Assistant-only, enforced here rather than in SQL: sources are citations *for an answer*, so
 * a user or system message carrying them would be meaningless. Expressing that in the schema
 * would need a trigger or a duplicated role column, and neither earns its cost — but the rule
 * still holds, and it fails as a 400 rather than a silent no-op so a mis-wired caller is
 * obvious.
 *
 * Passing an empty array clears the message's sources.
 *
 * @throws ApiError 404 when the message does not exist or belongs to another user.
 * @throws ApiError 400 for a non-assistant message, too many sources, duplicate positions,
 *         or a source that is missing a url or title.
 */
export const attachMessageSources = async (
    userId: string,
    messageId: string,
    sources: MessageSourceInput[],
): Promise<PublicMessageSource[]> => {
    if (!Array.isArray(sources)) {
        throw ApiError.badRequest("sources must be an array");
    }
    if (sources.length > MESSAGE_MAX_SOURCES) {
        throw ApiError.badRequest(
            `Cannot attach more than ${MESSAGE_MAX_SOURCES} sources to a message (received ${sources.length})`,
        );
    }

    // Ownership and role are resolved before anything is written, so a rejected call leaves
    // the message's existing sources untouched.
    const message = await findMessageForUser(messageId, userId);
    if (!message) {
        throw ApiError.notFound("Message not found");
    }
    if (message.role !== "assistant") {
        throw ApiError.badRequest(
            `Sources may only be attached to an assistant message (this message is '${message.role}')`,
            [{ field: "messageId", message: "not an assistant message" }],
        );
    }

    // Validate every source before writing any of them, so a bad entry in the middle of a
    // batch cannot leave the message half-populated.
    const normalized = sources.map(normalizeSource);

    const positions = new Set(normalized.map((source) => source.position));
    if (positions.size !== normalized.length) {
        // The UNIQUE (message_id, position) constraint would catch this, but as a 500. A
        // duplicate position is a caller bug worth naming.
        throw ApiError.badRequest("sources must not contain duplicate positions");
    }

    const rows = await replaceMessageSources({ messageId, userId, sources: normalized });
    return rows.map(toPublicMessageSource);
};

/**
 * Removes every source from a message. Returns how many were removed.
 *
 * @throws ApiError 404 when the message does not exist or belongs to another user.
 */
export const clearMessageSources = async (userId: string, messageId: string): Promise<number> => {
    const message = await findMessageForUser(messageId, userId);
    if (!message) {
        throw ApiError.notFound("Message not found");
    }

    // Deletes directly rather than routing through attachMessageSources([]): that path returns
    // the rows it *inserted*, which is always zero here, and would additionally reject a
    // non-assistant message — clearing stray rows off one should stay possible.
    return deleteMessageSourcesForUserMessage(messageId, userId);
};

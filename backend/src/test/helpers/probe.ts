/**
 * Shared fixtures for the audit suite.
 *
 * Every test in this suite runs against the real Neon database — there are no mocks, because
 * most of what is under test (CHECK constraints, cascades, pgvector distance, ownership in
 * WHERE clauses) is behaviour of Postgres, not of TypeScript. A mocked repository would only
 * prove the mock was called.
 *
 * Isolation comes from ownership instead of from a separate schema: every row is created
 * under a freshly generated probe user, and `cleanupProbes()` deletes those users, which
 * cascades their conversations, summaries, messages, and memories away. Real user data is
 * never touched because nothing here selects or deletes outside the tracked ids.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { query } from "../../db/pool.ts";
import { ApiError } from "../../utils/ApiError.ts";

/** Postgres SQLSTATE codes the constraint tests assert on. */
export const PG = {
    NOT_NULL: "23502",
    FOREIGN_KEY: "23503",
    UNIQUE: "23505",
    CHECK: "23514",
} as const;

const trackedUsers = new Set<string>();

export const createProbeUser = async (): Promise<string> => {
    const { rows } = await query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, auth_provider)
         VALUES ($1, 'probe-not-a-real-hash', 'audit probe', 'password')
         RETURNING id`,
        [`audit-probe-${randomUUID()}@example.com`],
    );
    const id = rows[0]!.id;
    trackedUsers.add(id);
    return id;
};

export const createProbeConversation = async (
    userId: string,
    title: string | null = "audit probe",
): Promise<string> => {
    const { rows } = await query<{ id: string }>(
        `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`,
        [userId, title],
    );
    return rows[0]!.id;
};

/** Inserts messages in order and returns their BIGINT ids as strings. */
export const addProbeMessages = async (
    conversationId: string,
    messages: { role: "user" | "assistant" | "system"; content: string }[],
): Promise<string[]> => {
    const ids: string[] = [];
    for (const message of messages) {
        const { rows } = await query<{ id: string }>(
            `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3) RETURNING id`,
            [conversationId, message.role, message.content],
        );
        ids.push(rows[0]!.id);
    }
    return ids;
};

/** Inserts one message and returns its BIGINT id as a string. */
export const addProbeMessage = async (
    conversationId: string,
    role: "user" | "assistant" | "system",
    content = "probe message",
): Promise<string> => {
    const [id] = await addProbeMessages(conversationId, [{ role, content }]);
    return id!;
};

/** A probe user with one conversation and one assistant message, the usual source fixture. */
export const createProbeAssistantMessage = async (): Promise<{
    userId: string;
    conversationId: string;
    messageId: string;
}> => {
    const userId = await createProbeUser();
    const conversationId = await createProbeConversation(userId);
    const messageId = await addProbeMessage(conversationId, "assistant", "here is the answer");
    return { userId, conversationId, messageId };
};

/** Deletes every probe user created by this file, cascading everything they own. */
export const cleanupProbes = async (): Promise<void> => {
    if (trackedUsers.size === 0) return;
    const ids = [...trackedUsers];
    trackedUsers.clear();
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
};

/** Asserts a promise rejects with an ApiError carrying `statusCode`, and returns it. */
export const expectApiError = async (
    operation: Promise<unknown>,
    statusCode: number,
): Promise<ApiError> => {
    try {
        await operation;
    } catch (error) {
        assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
        assert.equal(error.statusCode, statusCode, `message: ${error.message}`);
        return error;
    }
    throw new assert.AssertionError({ message: `expected a ${statusCode} rejection, but it resolved` });
};

/** Asserts a promise rejects with a Postgres error carrying `code`. */
export const expectPgError = async (operation: Promise<unknown>, code: string): Promise<void> => {
    try {
        await operation;
    } catch (error) {
        const actual = (error as { code?: string }).code;
        assert.equal(actual, code, `expected SQLSTATE ${code}, got ${actual}: ${String(error)}`);
        return;
    }
    throw new assert.AssertionError({ message: `expected SQLSTATE ${code}, but it resolved` });
};

/** Rejects only if the promise resolves; used where any failure mode is acceptable. */
export const expectRejection = async (operation: Promise<unknown>): Promise<unknown> => {
    try {
        await operation;
    } catch (error) {
        return error;
    }
    throw new assert.AssertionError({ message: "expected a rejection, but it resolved" });
};

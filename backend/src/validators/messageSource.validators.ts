import { z } from "zod";

/**
 * `messages.id` is a BIGINT identity, not a UUID, so it is validated as a digit string rather
 * than parsed into a number — Number.MAX_SAFE_INTEGER is smaller than the column's range and
 * coercing here would silently corrupt large ids. The value stays a string all the way to
 * node-postgres, matching MessageRow.id.
 *
 * Rejecting non-numeric input here turns a malformed id into a clean 400 "Validation failed"
 * instead of Postgres raising `invalid input syntax for type bigint`, which the error handler
 * could only report as a 500.
 */
export const messageIdParamSchema = z.object({
    messageId: z
        .string()
        .regex(/^[1-9]\d{0,18}$/, "messageId must be a valid message id"),
});

export type MessageIdParams = z.infer<typeof messageIdParamSchema>;

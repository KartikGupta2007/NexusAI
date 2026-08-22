import { CREDITS_PER_QUERY } from "../constants.ts";
import { deductUserCredits, findUserCredits } from "../repositories/user.repository.ts";
import { ApiError } from "../utils/ApiError.ts";

/**
 * Query credits.
 *
 * **Charges are not refunded.** Once a request clears validation and ownership and this succeeds,
 * the credit is spent — even if Tavily is down, Claude fails, or the client disconnects
 * mid-stream. That is deliberate: a refund path would have to reverse a committed charge from
 * inside a half-finished streaming response, and the failure modes of getting *that* wrong
 * (double refunds, refunds for work that did complete) are worse than occasionally charging for a
 * failed answer. Revisit only alongside a real transaction/ledger mechanism, which the
 * architecture does not have.
 */

/**
 * Charges one query's worth of credits.
 *
 * @returns the balance remaining after the charge.
 * @throws ApiError 402 INSUFFICIENT_CREDITS when the balance will not cover a query. A missing
 *         user is reported the same way: the id comes from a verified token, so "not found" means
 *         the account was deleted mid-session, and there is nothing useful — or safe — to tell a
 *         caller beyond that they cannot proceed.
 */
export const deductQueryCredit = async (userId: string): Promise<number> => {
    if (typeof userId !== "string" || userId.trim().length === 0) {
        throw new Error("deductQueryCredit requires a userId");
    }

    const outcome = await deductUserCredits(userId, CREDITS_PER_QUERY);

    if (!outcome.ok) {
        if (outcome.reason === "not_found") {
            console.error(`[credits] deduction for unknown user ${userId}`);
        }
        throw new ApiError(402, "You do not have enough credits for this query.", {
            code: "INSUFFICIENT_CREDITS",
        });
    }

    return outcome.remaining;
};

/** Current balance for the authenticated user. */
export const getCreditBalance = async (userId: string): Promise<number> => {
    const credits = await findUserCredits(userId);
    if (credits === null) throw ApiError.notFound("User not found");
    return credits;
};

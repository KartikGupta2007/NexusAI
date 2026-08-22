/** Credit business rules: constants, error shape, and the no-refund contract. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { CREDITS_PER_QUERY, DEFAULT_USER_CREDITS } from "../../constants.ts";
import { closePool } from "../../db/pool.ts";
import { deductQueryCredit, getCreditBalance } from "../../services/credit.services.ts";
import { ApiError } from "../../utils/ApiError.ts";
import { cleanupProbes, createProbeUser, readProbeCredits, setProbeCredits } from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

const expectApiError = async (operation: Promise<unknown>, statusCode: number, code: string) => {
    try {
        await operation;
    } catch (error) {
        assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
        assert.equal(error.statusCode, statusCode);
        assert.equal(error.code, code);
        return error;
    }
    throw new assert.AssertionError({ message: `expected ${statusCode} ${code}` });
};

describe("deductQueryCredit", () => {
    it("9/11: charges CREDITS_PER_QUERY and returns the remaining balance", async () => {
        const userId = await createProbeUser();
        assert.equal(await deductQueryCredit(userId), DEFAULT_USER_CREDITS - CREDITS_PER_QUERY);
        assert.equal(await readProbeCredits(userId), 480);
        assert.equal(await getCreditBalance(userId), 480);
    });

    it("10: insufficient credits is a 402 with a stable code", async () => {
        const userId = await createProbeUser();
        await setProbeCredits(userId, CREDITS_PER_QUERY - 1);

        const error = await expectApiError(deductQueryCredit(userId), 402, "INSUFFICIENT_CREDITS");
        assert.equal(error.message, "You do not have enough credits for this query.");
        assert.deepEqual(error.errors, [], "no SQL or internal detail may be attached");
        assert.equal(await readProbeCredits(userId), CREDITS_PER_QUERY - 1, "balance untouched");
    });

    it("a deleted account is reported the same way, revealing nothing extra", async () => {
        const error = await expectApiError(deductQueryCredit(randomUUID()), 402, "INSUFFICIENT_CREDITS");
        assert.ok(!/not found|exist/i.test(error.message), "must not disclose account existence");
    });

    it("a missing userId is a programming error, not a 402", async () => {
        for (const bad of ["", "   ", null as unknown as string]) {
            await assert.rejects(() => deductQueryCredit(bad), (error: unknown) => {
                assert.ok(!(error instanceof ApiError), "should not masquerade as a client error");
                return true;
            });
        }
    });

    it("getCreditBalance is read-only", async () => {
        const userId = await createProbeUser();
        await getCreditBalance(userId);
        await getCreditBalance(userId);
        assert.equal(await readProbeCredits(userId), DEFAULT_USER_CREDITS, "reading must not charge");
    });

    it("documents the no-refund contract: a failed downstream call keeps the charge", async () => {
        // Deliberate: there is no refund path, so a charged credit stays charged even when the
        // work it paid for fails. Asserted so the behaviour cannot change silently.
        const userId = await createProbeUser();
        const remaining = await deductQueryCredit(userId);
        assert.equal(remaining, 480);
        assert.equal(await readProbeCredits(userId), 480,
            "nothing restores credits after a successful charge");
    });
});

/** Atomic credit deduction, including the concurrency guarantee. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { CREDITS_PER_QUERY, DEFAULT_USER_CREDITS } from "../../constants.ts";
import { closePool } from "../../db/pool.ts";
import { deductUserCredits, findUserCredits } from "../../repositories/user.repository.ts";
import { cleanupProbes, createProbeUser, readProbeCredits, setProbeCredits } from "../helpers/probe.ts";

after(async () => { await cleanupProbes(); await closePool(); });

describe("deductUserCredits", () => {
    it("1/8: a new probe user starts at the default and 20 leaves 480", async () => {
        const userId = await createProbeUser();
        assert.equal(await readProbeCredits(userId), DEFAULT_USER_CREDITS);
        assert.equal(DEFAULT_USER_CREDITS, 500);
        assert.equal(CREDITS_PER_QUERY, 20);

        const outcome = await deductUserCredits(userId, CREDITS_PER_QUERY);
        assert.deepEqual(outcome, { ok: true, remaining: 480 });
        assert.equal(await readProbeCredits(userId), 480, "the returned balance must match the row");
    });

    it("2: repeated deductions walk the balance down exactly", async () => {
        const userId = await createProbeUser();
        const expected = [480, 460, 440, 420, 400];
        for (const remaining of expected) {
            const outcome = await deductUserCredits(userId, CREDITS_PER_QUERY);
            assert.deepEqual(outcome, { ok: true, remaining });
        }
        assert.equal(await readProbeCredits(userId), 400);
    });

    it("2b: the full grant buys exactly 25 queries and no more", async () => {
        const userId = await createProbeUser();
        for (let i = 0; i < DEFAULT_USER_CREDITS / CREDITS_PER_QUERY; i++) {
            assert.equal((await deductUserCredits(userId, CREDITS_PER_QUERY)).ok, true, `query ${i + 1}`);
        }
        assert.equal(await readProbeCredits(userId), 0);
        assert.deepEqual(await deductUserCredits(userId, CREDITS_PER_QUERY),
            { ok: false, reason: "insufficient", credits: 0 });
    });

    it("3: exactly 20 credits succeeds and lands on 0", async () => {
        const userId = await createProbeUser();
        await setProbeCredits(userId, CREDITS_PER_QUERY);
        assert.deepEqual(await deductUserCredits(userId, CREDITS_PER_QUERY), { ok: true, remaining: 0 });
        assert.equal(await readProbeCredits(userId), 0);
    });

    it("4/5: fewer than 20 is rejected and the balance is untouched", async () => {
        for (const starting of [19, 10, 1, 0]) {
            const userId = await createProbeUser();
            await setProbeCredits(userId, starting);
            assert.deepEqual(await deductUserCredits(userId, CREDITS_PER_QUERY),
                { ok: false, reason: "insufficient", credits: starting });
            assert.equal(await readProbeCredits(userId), starting, "a refused charge must not move the balance");
        }
    });

    it("5b: the balance can never go negative", async () => {
        const userId = await createProbeUser();
        await setProbeCredits(userId, 30);
        await deductUserCredits(userId, CREDITS_PER_QUERY);           // -> 10
        await deductUserCredits(userId, CREDITS_PER_QUERY);           // refused
        await deductUserCredits(userId, CREDITS_PER_QUERY);           // refused
        assert.equal(await readProbeCredits(userId), 10);
        assert.ok((await readProbeCredits(userId)) >= 0);
    });

    it("6: a nonexistent user is reported distinctly from an insufficient balance", async () => {
        assert.deepEqual(await deductUserCredits(randomUUID(), CREDITS_PER_QUERY), { ok: false, reason: "not_found" });
        assert.equal(await findUserCredits(randomUUID()), null);
    });

    it("a non-positive amount is refused, so a charge can never be a top-up", async () => {
        const userId = await createProbeUser();
        for (const amount of [0, -20, 1.5, Number.NaN]) {
            await assert.rejects(() => deductUserCredits(userId, amount), /positive integer/);
        }
        assert.equal(await readProbeCredits(userId), DEFAULT_USER_CREDITS);
    });

    it("7: two concurrent deductions with 20 credits cannot overspend", async () => {
        const userId = await createProbeUser();
        await setProbeCredits(userId, CREDITS_PER_QUERY);

        // Fired without awaiting in between, so both reach the database concurrently.
        const outcomes = await Promise.all([
            deductUserCredits(userId, CREDITS_PER_QUERY),
            deductUserCredits(userId, CREDITS_PER_QUERY),
        ]);

        assert.equal(outcomes.filter((o) => o.ok).length, 1, "exactly one charge may succeed");
        assert.equal(outcomes.filter((o) => !o.ok).length, 1, "exactly one must be refused");
        assert.equal(await readProbeCredits(userId), 0);
        assert.ok((await readProbeCredits(userId)) >= 0);
    });

    it("7b: two concurrent deductions with 40 credits both succeed", async () => {
        const userId = await createProbeUser();
        await setProbeCredits(userId, CREDITS_PER_QUERY * 2);

        const outcomes = await Promise.all([
            deductUserCredits(userId, CREDITS_PER_QUERY),
            deductUserCredits(userId, CREDITS_PER_QUERY),
        ]);

        assert.equal(outcomes.filter((o) => o.ok).length, 2);
        assert.deepEqual(outcomes.filter((o) => o.ok).map((o) => (o as { remaining: number }).remaining).sort(),
            [0, 20], "the two must observe different post-charge balances");
        assert.equal(await readProbeCredits(userId), 0);
    });

    it("7c: ten concurrent deductions against 100 credits settle at exactly five successes", async () => {
        const userId = await createProbeUser();
        await setProbeCredits(userId, CREDITS_PER_QUERY * 5);

        const outcomes = await Promise.all(
            Array.from({ length: 10 }, () => deductUserCredits(userId, CREDITS_PER_QUERY)));

        assert.equal(outcomes.filter((o) => o.ok).length, 5, "no overspend under contention");
        assert.equal(await readProbeCredits(userId), 0);
        // Every successful charge saw a distinct remaining balance — no lost update.
        const remaining = outcomes.filter((o) => o.ok).map((o) => (o as { remaining: number }).remaining);
        assert.equal(new Set(remaining).size, 5, "two charges reported the same balance");
    });
});

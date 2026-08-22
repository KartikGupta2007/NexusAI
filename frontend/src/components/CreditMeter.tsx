import { useEffect, useRef, useState } from "react";
import {
    CREDITS_PER_QUERY,
    CREDIT_FLASH_MS,
    LOW_CREDIT_THRESHOLD,
    STARTING_CREDITS,
} from "../constants.ts";

/**
 * The credit balance.
 *
 * Rendered straight from whatever the backend last reported — this component never computes or
 * decrements a balance. The "queries remaining" figure below is a *description* of that balance
 * at a known price, not a second source of truth: it is recomputed from the authoritative number
 * every render, so it cannot drift.
 *
 * The bar is measured against the signup grant, which makes an unfamiliar number ("340 credits")
 * legible at a glance without the user knowing what the scale is.
 */
export const CreditMeter = ({ credits }: { credits: number | null }) => {
    const [flash, setFlash] = useState(false);
    const previous = useRef<number | null>(null);

    // A change flashes once. Skipped on the first value, which is a load rather than a spend.
    useEffect(() => {
        if (credits === null) return;
        if (previous.current !== null && previous.current !== credits) {
            setFlash(true);
            const timer = window.setTimeout(() => setFlash(false), CREDIT_FLASH_MS);
            return () => window.clearTimeout(timer);
        }
        previous.current = credits;
    }, [credits]);

    useEffect(() => {
        if (credits !== null) previous.current = credits;
    }, [credits]);

    if (credits === null) {
        return <div className="skeleton credits-skeleton" aria-hidden="true" />;
    }

    const queriesLeft = Math.floor(credits / CREDITS_PER_QUERY);
    const exhausted = queriesLeft < 1;
    const low = !exhausted && credits <= LOW_CREDIT_THRESHOLD;
    const filled = Math.max(0, Math.min(100, (credits / STARTING_CREDITS) * 100));

    const state = exhausted ? " credits-empty" : low ? " credits-low" : "";

    return (
        <div className={`credits${state}${flash ? " credits-changed" : ""}`}>
            <div className="credits-top">
                <span>
                    {/* aria-live so a spend is announced once, without moving focus. */}
                    <span className="credits-value" aria-live="polite">
                        {credits.toLocaleString()}
                    </span>{" "}
                    <span className="credits-unit">credits</span>
                </span>
                <span className="credits-queries">
                    {exhausted
                        ? "none left"
                        : `${queriesLeft} ${queriesLeft === 1 ? "query" : "queries"}`}
                </span>
            </div>

            <div
                className="credits-bar"
                role="progressbar"
                aria-valuenow={credits}
                aria-valuemin={0}
                aria-valuemax={STARTING_CREDITS}
                aria-label="Credits remaining"
            >
                <div className="credits-fill" style={{ width: `${filled}%` }} />
            </div>
        </div>
    );
};

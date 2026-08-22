import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Cascade assertions against app.css.
 *
 * The rest of this suite mounts components in jsdom, which loads no stylesheet, resolves no media
 * query and performs no layout. That blind spot is not theoretical: the drawer's close button was
 * shipped visible-but-inert on the desktop layout, and the existing drawer test clicked it happily
 * the whole time — a programmatic click does not care that a real user could never reach it.
 *
 * So this file reads the stylesheet and resolves the cascade by hand for the handful of elements
 * whose visibility is load-bearing. It is deliberately narrow: it answers "which `display` wins"
 * for one element at one breakpoint, not "is the CSS correct".
 */

const appCss = readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "styles"), "app.css"),
    "utf8",
);

// ── A very small CSS reader ───────────────────────────────────────────────────

interface Rule {
    selector: string;
    body: string;
    /** The `@media` condition this rule sits under, or null at the top level. */
    media: string | null;
    /** Source order, so ties can be broken the way a browser breaks them. */
    order: number;
}

/** Flattens top-level rules and one level of @media into an ordered list. */
const readRules = (css: string): Rule[] => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules: Rule[] = [];
    let order = 0;

    const parseBlock = (source: string, media: string | null) => {
        let index = 0;
        while (index < source.length) {
            const open = source.indexOf("{", index);
            if (open === -1) break;

            const prelude = source.slice(index, open).trim();

            // Walk to the matching close brace so nested blocks stay intact.
            let depth = 1;
            let cursor = open + 1;
            while (cursor < source.length && depth > 0) {
                if (source[cursor] === "{") depth++;
                else if (source[cursor] === "}") depth--;
                cursor++;
            }
            const body = source.slice(open + 1, cursor - 1);

            if (prelude.startsWith("@media")) {
                parseBlock(body, prelude.replace(/^@media\s*/, "").trim());
            } else if (prelude.startsWith("@")) {
                // @keyframes and friends declare no cascading `display` for our purposes.
            } else if (prelude.length > 0) {
                rules.push({ selector: prelude, body, media, order: order++ });
            }

            index = cursor;
        }
    };

    parseBlock(withoutComments, null);
    return rules;
};

const rules = readRules(appCss);

/** Specificity of a simple selector, as (ids, classes, elements). Enough for this stylesheet. */
const specificity = (selector: string): number => {
    const ids = (selector.match(/#[\w-]+/g) ?? []).length;
    const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+\([^)]*\)|:(?!:)[\w-]+/g) ?? []).length;
    const elements = (selector.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) ?? []).length;
    return ids * 10_000 + classes * 100 + elements;
};

/** An element under test: its own classes plus the classes of its ancestors. */
interface Subject {
    classes: string[];
    ancestors: string[][];
}

/** Does one compound selector (no combinators) match this class list? */
const compoundMatches = (compound: string, classes: string[]): boolean => {
    const wanted = compound.match(/\.[\w-]+/g) ?? [];
    if (wanted.length === 0) return false;
    return wanted.every((c) => classes.includes(c.slice(1)));
};

/**
 * Descendant-combinator matching only — which is all this stylesheet uses for the elements below.
 * The rightmost compound must match the subject; each earlier compound must match some ancestor,
 * in order.
 */
const selectorMatches = (selector: string, subject: Subject): boolean =>
    selector.split(",").some((branch) => {
        const compounds = branch.trim().split(/\s+/).filter(Boolean);
        const target = compounds.pop();
        if (!target || !compoundMatches(target, subject.classes)) return false;

        let index = subject.ancestors.length - 1;
        for (const compound of [...compounds].reverse()) {
            while (index >= 0 && !compoundMatches(compound, subject.ancestors[index]!)) index--;
            if (index < 0) return false;
            index--;
        }
        return true;
    });

const DISPLAY = /(?:^|;|\s)display\s*:\s*([^;}]+)/;

/**
 * The `display` value that actually wins for `subject`, given which media blocks apply.
 *
 * `applies` decides whether a rule's `@media` condition is in force, which is how a breakpoint is
 * simulated without a layout engine.
 */
const winningDisplay = (subject: Subject, applies: (media: string | null) => boolean): string | null => {
    let best: { value: string; specificity: number; order: number } | null = null;

    for (const rule of rules) {
        if (!applies(rule.media)) continue;
        if (!selectorMatches(rule.selector, subject)) continue;

        const declared = DISPLAY.exec(rule.body);
        if (!declared) continue;

        const candidate = {
            value: declared[1]!.trim(),
            specificity: Math.max(...rule.selector.split(",").map((s) => specificity(s.trim()))),
            order: rule.order,
        };
        // Later wins at equal specificity — the rule that caused the original bug.
        if (
            !best ||
            candidate.specificity > best.specificity ||
            (candidate.specificity === best.specificity && candidate.order > best.order)
        ) {
            best = candidate;
        }
    }

    return best?.value ?? null;
};

const desktop = (media: string | null) => media === null;
const mobile = (media: string | null) => media === null || media.includes("max-width: 900px");

/** The drawer close button, exactly as Sidebar renders it inside `.sidebar-head`. */
const drawerClose: Subject = {
    classes: ["btn", "btn-icon", "drawer-close"],
    ancestors: [["shell", "drawer-open"], ["shell-aside"], ["sidebar"], ["sidebar-head"]],
};

describe("the stylesheet parses", () => {
    it("reads a plausible number of rules, so the assertions below are not vacuous", () => {
        expect(rules.length).toBeGreaterThan(100);
        expect(rules.some((r) => r.media?.includes("max-width: 900px"))).toBe(true);
    });

    it("resolves a rule this element genuinely matches", () => {
        // Sanity check on the matcher itself: .btn must be seen to apply to the close button.
        expect(rules.some((r) => r.selector.trim() === ".btn" && selectorMatches(r.selector, drawerClose)))
            .toBe(true);
    });
});

describe("drawer close button visibility", () => {
    /**
     * The regression. `.btn { display: inline-flex }` appears after the rule that hides the close
     * button, so at equal specificity it used to win — leaving a cross on the desktop sidebar that
     * closed a drawer which was not open and could not be. Clicking it did nothing at all.
     */
    it("is hidden on the desktop layout, where there is no drawer to close", () => {
        expect(winningDisplay(drawerClose, desktop)).toBe("none");
    });

    it("is shown inside the mobile drawer", () => {
        expect(winningDisplay(drawerClose, mobile)).toBe("inline-flex");
    });

    it("is hidden by a rule that outranks .btn rather than by source order", () => {
        // Ordering is the fragile part: moving .btn earlier must not resurrect the bug.
        const hide = rules.find(
            (r) => r.media === null && selectorMatches(r.selector, drawerClose) && DISPLAY.exec(r.body)?.[1]?.trim() === "none",
        );
        const btn = rules.find((r) => r.media === null && r.selector.trim() === ".btn");
        expect(hide, "no top-level rule hides the drawer close button").toBeDefined();
        expect(specificity(hide!.selector)).toBeGreaterThan(specificity(btn!.selector));
    });
});

describe("drawer chrome only exists in the drawer layout", () => {
    const scrim: Subject = { classes: ["scrim"], ancestors: [["shell", "drawer-open"]] };
    const mobileBar: Subject = { classes: ["mobile-bar"], ancestors: [["shell"]] };

    it("the scrim is desktop-hidden and drawer-visible", () => {
        expect(winningDisplay(scrim, desktop)).toBe("none");
        expect(winningDisplay(scrim, mobile)).toBe("block");
    });

    it("the mobile bar is desktop-hidden and drawer-visible", () => {
        expect(winningDisplay(mobileBar, desktop)).toBe("none");
        expect(winningDisplay(mobileBar, mobile)).toBe("flex");
    });
});
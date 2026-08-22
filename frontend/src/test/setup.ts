import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * jsdom does not implement scrollTo, and the thread container calls it whenever the reader jumps
 * back to the latest answer. Without a stub every auto-scroll throws inside a React effect.
 */
if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function scrollTo() {};
}

afterEach(() => {
    cleanup();
});

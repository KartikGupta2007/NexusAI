import { useCallback, useEffect, useRef, useState } from "react";
import { NEAR_BOTTOM_PX } from "../constants.ts";

/**
 * Keeps a scroll container pinned to the bottom while content grows — but only while the reader
 * wants it to be.
 *
 * The rule that matters: scrolling up is an intent signal. Once the user does it, auto-scroll
 * stops until they come back to the bottom. Otherwise reading an earlier paragraph during a long
 * answer would be impossible, because every token would yank them back down.
 */
export const useStickToBottom = <T extends HTMLElement>(dependency: unknown) => {
    const ref = useRef<T | null>(null);
    const [isPinned, setIsPinned] = useState(true);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        const element = ref.current;
        if (!element) return;
        element.scrollTo({ top: element.scrollHeight, behavior });
        setIsPinned(true);
    }, []);

    // Track intent. Comparing against the threshold rather than remembering a direction means
    // scrolling back down re-arms following, which is what a reader expects.
    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const onScroll = () => {
            const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
            setIsPinned(distance <= NEAR_BOTTOM_PX);
        };

        element.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
        return () => element.removeEventListener("scroll", onScroll);
    }, []);

    // Follow new content only while pinned. `auto` during streaming: a smooth animation cannot
    // keep up with tokens and ends up lagging behind the text.
    useEffect(() => {
        if (!isPinned) return;
        const element = ref.current;
        if (element) element.scrollTop = element.scrollHeight;
    }, [dependency, isPinned]);

    return { ref, isPinned, scrollToBottom };
};

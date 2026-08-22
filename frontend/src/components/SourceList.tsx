import { useMemo, useState } from "react";
import { IconExternal } from "./Icon.tsx";
import { SOURCES_VISIBLE_BY_DEFAULT } from "../constants.ts";
import type { Source } from "../types/api.ts";

/** Hostname without `www.`, which is what a citation card should actually show. */
const displayHost = (url: string): string => {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        // A malformed URL should still render something recognisable rather than blank.
        return url;
    }
};

/**
 * The citation list under an answer.
 *
 * Shows only what a reader needs — numbered position, title, host, favicon. Database ids, message
 * ids and internal source ids are never rendered, and the raw `content` snippet is used only as a
 * tooltip rather than bloating the card.
 *
 * Beyond four sources the rest collapse behind a toggle, so a long list cannot dominate the answer
 * it belongs to. The extra cards are mounted only once expanded, which also means their favicons
 * are not fetched until someone asks to see them.
 */
export const SourceList = ({ sources }: { sources: Source[] }) => {
    const [expanded, setExpanded] = useState(false);

    const ordered = useMemo(
        () => [...sources].sort((a, b) => a.position - b.position),
        [sources],
    );

    if (ordered.length === 0) return null;

    const hidden = Math.max(0, ordered.length - SOURCES_VISIBLE_BY_DEFAULT);
    const shown = expanded ? ordered : ordered.slice(0, SOURCES_VISIBLE_BY_DEFAULT);

    return (
        <section className="sources" aria-label="Sources">
            <div className="sources-head">
                <h3 className="sources-title">Sources</h3>
                <span className="sources-count">{ordered.length}</span>
            </div>

            <ul className="source-grid">
                {shown.map((source, index) => (
                    <li key={source.id} className={index >= SOURCES_VISIBLE_BY_DEFAULT ? "is-extra" : undefined}>
                        <a
                            className="source-card"
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={source.content ?? source.title}
                        >
                            <span className="source-index" aria-hidden="true">
                                {source.position}
                            </span>

                            <span className="source-body">
                                <span className="source-title">{source.title}</span>
                                <span className="source-host">
                                    {source.favicon ? (
                                        <img
                                            className="favicon"
                                            src={source.favicon}
                                            alt=""
                                            width={13}
                                            height={13}
                                            loading="lazy"
                                            decoding="async"
                                            referrerPolicy="no-referrer"
                                            // A broken icon collapses to the reserved box rather
                                            // than leaving a torn-image glyph.
                                            onError={(event) => {
                                                event.currentTarget.style.visibility = "hidden";
                                            }}
                                        />
                                    ) : (
                                        <span className="favicon" aria-hidden="true" />
                                    )}
                                    <span className="source-domain">{displayHost(source.url)}</span>
                                </span>
                            </span>

                            <IconExternal className="icon source-out" />
                            {/* The visual card is compact; screen readers get the full picture. */}
                            <span className="sr-only">
                                {`Source ${source.position}: ${source.title}, ${displayHost(source.url)}. Opens in a new tab.`}
                            </span>
                        </a>
                    </li>
                ))}
            </ul>

            {hidden > 0 ? (
                <div className="sources-more">
                    <button
                        type="button"
                        className="link-button"
                        onClick={() => setExpanded((open) => !open)}
                        aria-expanded={expanded}
                    >
                        {expanded ? "Show fewer" : `Show ${hidden} more`}
                    </button>
                </div>
            ) : null}
        </section>
    );
};

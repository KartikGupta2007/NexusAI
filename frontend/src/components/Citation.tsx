import type { Source } from "../types/api.ts";

/**
 * An inline citation chip.
 *
 * Rendered only for a marker that resolves to a source the backend actually sent. Nothing is
 * invented here: an unresolved marker is left as plain text rather than being turned into a link
 * to nowhere.
 */
export const Citation = ({ source }: { source: Source }) => (
    <a
        className="cite"
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${source.title} — ${source.url}`}
    >
        {source.position}
        <span className="sr-only">{` (source ${source.position}: ${source.title})`}</span>
    </a>
);

/**
 * The NexusAI mark: three nodes joined by links, inside an orbit.
 *
 * The motif is the product — separate points of information connected into one answer. It is
 * static by default and only animates while `thinking` is true, so motion always means the model
 * is working rather than decorating the page. Reduced-motion handling lives in app.css, which
 * disables the orbit and pulse but keeps the mark legible.
 */
export const BrandMark = ({
    size = 18,
    thinking = false,
}: {
    size?: number;
    thinking?: boolean;
}) => (
    <svg
        className={`mark${thinking ? " is-thinking" : ""}`}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
    >
        <circle
            className="mark-orbit"
            cx="12"
            cy="12"
            r="9.25"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeDasharray="3 4.5"
            strokeLinecap="round"
        />
        <g className="mark-link" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
            <line x1="12" y1="5.6" x2="6.4" y2="15.4" />
            <line x1="12" y1="5.6" x2="17.6" y2="15.4" />
            <line x1="6.4" y1="15.4" x2="17.6" y2="15.4" />
        </g>
        <circle className="mark-node" cx="12" cy="5.6" r="2.5" fill="currentColor" />
        <circle className="mark-node" cx="6.4" cy="15.4" r="2.5" fill="currentColor" />
        <circle className="mark-node" cx="17.6" cy="15.4" r="2.5" fill="currentColor" />
    </svg>
);

/** Mark plus wordmark, for the sidebar head, the login card and the empty state. */
export const BrandLockup = ({
    size = 18,
    large = false,
    thinking = false,
}: {
    size?: number;
    large?: boolean;
    thinking?: boolean;
}) => (
    <span className={`brand${large ? " brand-lg" : ""}`}>
        <BrandMark size={large ? Math.max(size, 26) : size} thinking={thinking} />
        <span className="brand-word">
            Nexus<span>AI</span>
        </span>
    </span>
);

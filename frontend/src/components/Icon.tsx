import type { SVGProps } from "react";

/**
 * The icon set, inline.
 *
 * A dependency would ship thousands of glyphs to deliver the nine below, all of which are a few
 * paths each. They inherit `currentColor` and the surrounding font size, so a button styles its
 * icon by styling itself.
 *
 * Every icon is `aria-hidden`: each one sits inside a control that already carries a text label
 * or an aria-label, and announcing it again would only add noise.
 */
const base = (props: SVGProps<SVGSVGElement>) => ({
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: "false" as const,
    className: "icon",
    ...props,
});

export const IconPlus = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base(props)}>
        <path d="M12 5v14M5 12h14" />
    </svg>
);

export const IconMenu = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base(props)}>
        <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
);

export const IconClose = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base(props)}>
        <path d="M6 6l12 12M18 6L6 18" />
    </svg>
);

export const IconArrowUp = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base(props)}>
        <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
);

export const IconArrowDown = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base(props)}>
        <path d="M12 5v14M18 13l-6 6-6-6" />
    </svg>
);

/** A filled square: the universal "stop", and unmistakable at 12px. */
export const IconStop = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base({ strokeWidth: 0, ...props })}>
        <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
);

export const IconCopy = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base({ width: 13, height: 13, ...props })}>
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
);

export const IconCheck = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base({ width: 13, height: 13, ...props })}>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
);

export const IconExternal = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base({ width: 12, height: 12, ...props })}>
        <path d="M14 4h6v6M20 4l-8.5 8.5" />
        <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
);

export const IconSearch = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base({ width: 15, height: 15, ...props })}>
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4 4" />
    </svg>
);

export const IconSignOut = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base({ width: 15, height: 15, ...props })}>
        <path d="M15 17l5-5-5-5M20 12H9M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5" />
    </svg>
);

export const IconAlert = (props: SVGProps<SVGSVGElement>) => (
    <svg {...base({ width: 15, height: 15, ...props })}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 8v4.5M12 16h.01" />
    </svg>
);

/** Google's four-colour mark. Fixed brand colours, so it does not inherit currentColor. */
export const IconGoogle = (props: SVGProps<SVGSVGElement>) => (
    <svg width={17} height={17} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
        <path
            fill="#4285F4"
            d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.45a5.51 5.51 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.65z"
        />
        <path
            fill="#34A853"
            d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.16-4.06 1.16-3.13 0-5.78-2.11-6.73-4.96H1.26v3.09A11.99 11.99 0 0 0 12 24z"
        />
        <path
            fill="#FBBC05"
            d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.26a12 12 0 0 0 0 10.74l4.01-3.09z"
        />
        <path
            fill="#EA4335"
            d="M12 4.76c1.76 0 3.34.61 4.59 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.26 6.63l4.01 3.09C6.22 6.87 8.87 4.76 12 4.76z"
        />
    </svg>
);

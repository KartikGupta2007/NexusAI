/**
 * Turns a raw User-Agent string into something a person can recognise in a session list
 * ("Chrome on macOS"), so they can tell their laptop from their phone.
 *
 * This is deliberately a small hand-rolled matcher rather than a dependency. The output
 * is a display label only — nothing security-relevant branches on it, a wrong guess is
 * cosmetic, and User-Agent is attacker-controlled anyway. The raw string is always
 * returned alongside the parse so the truth is never lost.
 */

export interface ParsedUserAgent {
    browser: string | null;
    os: string | null;
    deviceType: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
    /** Human-readable summary, e.g. "Safari on iOS". */
    label: string;
}

// Order matters: Edge and Opera both advertise "Chrome", and Chrome advertises "Safari".
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bEdg(?:e|A|iOS)?\//, "Edge"],
    [/\bOPR\/|\bOpera\//, "Opera"],
    [/\bSamsungBrowser\//, "Samsung Internet"],
    [/\bFirefox\/|\bFxiOS\//, "Firefox"],
    [/\bCriOS\//, "Chrome"],
    [/\bChrome\//, "Chrome"],
    [/\bSafari\//, "Safari"],
    [/\bcurl\//, "curl"],
    [/\bwget\//i, "Wget"],
    [/\bPostmanRuntime\//, "Postman"],
    [/\binsomnia\//i, "Insomnia"],
    [/\bokhttp\//i, "OkHttp"],
    [/\baxios\/|\bnode-fetch\/|\bundici\//i, "Node.js"],
    [/\bDart\/|\bDio\//, "Dart"],
];

const OPERATING_SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
    // iPadOS still reports "Mac OS X" in some modes, so iPad must be tested before macOS.
    [/\biPad\b/, "iPadOS"],
    [/\biPhone\b|\biPod\b/, "iOS"],
    [/\bAndroid\b/, "Android"],
    [/\bWindows NT 10\.0\b/, "Windows"],
    [/\bWindows\b/, "Windows"],
    [/\bCrOS\b/, "ChromeOS"],
    [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
    [/\bLinux\b|\bX11\b/, "Linux"],
];

const BOT = /\bbot\b|\bcrawler\b|\bspider\b|\bslurp\b|headless/i;

const firstMatch = (ua: string, table: ReadonlyArray<readonly [RegExp, string]>): string | null => {
    for (const [pattern, name] of table) {
        if (pattern.test(ua)) return name;
    }
    return null;
};

const detectDeviceType = (ua: string, os: string | null): ParsedUserAgent["deviceType"] => {
    if (BOT.test(ua)) return "bot";
    if (os === "iPadOS" || /\bTablet\b/i.test(ua)) return "tablet";
    // Android without the "Mobi" token is conventionally a tablet.
    if (os === "Android" && !/\bMobi/i.test(ua)) return "tablet";
    if (os === "iOS" || /\bMobi/i.test(ua)) return "mobile";
    if (os) return "desktop";
    return "unknown";
};

export const parseUserAgent = (raw: string | null): ParsedUserAgent => {
    if (!raw?.trim()) {
        return { browser: null, os: null, deviceType: "unknown", label: "Unknown device" };
    }

    const ua = raw.trim();
    const browser = firstMatch(ua, BROWSERS);
    const os = firstMatch(ua, OPERATING_SYSTEMS);
    const deviceType = detectDeviceType(ua, os);

    let label: string;
    if (browser && os) label = `${browser} on ${os}`;
    else if (browser) label = browser;
    else if (os) label = os;
    // Nothing recognised: show a clipped prefix of the raw string rather than "Unknown",
    // which at least lets the user identify an unusual client.
    else label = ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;

    return { browser, os, deviceType, label };
};
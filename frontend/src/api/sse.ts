/**
 * A reusable Server-Sent Events reader.
 *
 * EventSource cannot be used here: it only issues GET requests, and both chat endpoints are
 * POST. So the response body is read as a stream and parsed by hand — which this module does
 * once, for both the new-chat and continue flows.
 *
 * The parsing that matters is buffering. A network chunk has no relationship to an event
 * boundary: one chunk can carry three events, half an event, or a single byte splitting a
 * multi-byte character. So bytes are decoded with a streaming decoder and events are only
 * emitted once a blank-line terminator has actually arrived.
 */
import { SSE_FRAME_SEPARATOR } from "../constants.ts";

/** One decoded SSE frame, before it is interpreted as a domain event. */
export interface SSEFrame {
    event: string;
    data: string;
}

/** Parses one raw frame block into its event name and concatenated data payload. */
export const parseFrame = (block: string): SSEFrame | null => {
    let event = "message";
    const data: string[] = [];

    for (const rawLine of block.split(/\r\n|\n|\r/)) {
        // A leading colon is a comment/heartbeat and carries no payload.
        if (rawLine.length === 0 || rawLine.startsWith(":")) continue;

        const colon = rawLine.indexOf(":");
        const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
        // Exactly one optional space after the colon is part of the framing, not the value.
        let value = colon === -1 ? "" : rawLine.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);

        if (field === "event") event = value;
        // Multiple data: lines in one frame join with newlines, per the SSE spec.
        else if (field === "data") data.push(value);
    }

    return data.length === 0 ? null : { event, data: data.join("\n") };
};

/**
 * Yields frames from a byte stream as they complete.
 *
 * Reads to the end even if the server closes without a trailing blank line — a final
 * unterminated block is still emitted rather than silently dropped.
 */
export async function* readSSEFrames(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            if (signal?.aborted) return;

            const { done, value } = await reader.read();
            if (done) break;

            // `stream: true` keeps a multi-byte character split across chunks intact.
            buffer += decoder.decode(value, { stream: true });

            while (true) {
                const match = SSE_FRAME_SEPARATOR.exec(buffer);
                if (!match) break;

                const block = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);

                const frame = parseFrame(block);
                if (frame) yield frame;
            }
        }

        buffer += decoder.decode();
        const trailing = parseFrame(buffer);
        if (trailing) yield trailing;
    } finally {
        // Releasing matters on abort: without it the stream stays locked to a dead reader.
        reader.releaseLock();
    }
}

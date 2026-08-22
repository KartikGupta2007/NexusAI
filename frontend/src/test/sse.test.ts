import { describe, expect, it } from "vitest";
import { parseFrame, readSSEFrames } from "../api/sse.ts";
import type { SSEFrame } from "../api/sse.ts";

/**
 * The parser is the one place a network detail can corrupt an answer, so these tests feed it the
 * chunk boundaries a real socket produces: events split in half, several events in one chunk, and
 * a multi-byte character straddling two chunks.
 */

const encoder = new TextEncoder();

/** A body that delivers exactly the chunks given, in order. */
const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });

/** Splits a string into fixed-size byte chunks, to simulate an adversarial socket. */
const byteChunks = (text: string, size: number): ReadableStream<Uint8Array> => {
    const bytes = encoder.encode(text);
    return new ReadableStream({
        start(controller) {
            for (let offset = 0; offset < bytes.length; offset += size) {
                controller.enqueue(bytes.slice(offset, offset + size));
            }
            controller.close();
        },
    });
};

const collect = async (body: ReadableStream<Uint8Array>, signal?: AbortSignal) => {
    const frames: SSEFrame[] = [];
    for await (const frame of readSSEFrames(body, signal)) frames.push(frame);
    return frames;
};

describe("parseFrame", () => {
    it("reads the event name and data payload", () => {
        expect(parseFrame("event: token\ndata: {\"text\":\"hi\"}")).toEqual({
            event: "token",
            data: '{"text":"hi"}',
        });
    });

    it("joins multiple data lines with newlines, per the SSE spec", () => {
        expect(parseFrame("event: token\ndata: one\ndata: two")).toEqual({
            event: "token",
            data: "one\ntwo",
        });
    });

    it("ignores comment lines and returns null for a payload-free block", () => {
        expect(parseFrame(": keep-alive")).toBeNull();
    });

    it("strips exactly one space after the colon, preserving the rest", () => {
        expect(parseFrame("data:  two spaces")?.data).toBe(" two spaces");
    });
});

describe("readSSEFrames", () => {
    it("emits one frame per event when several arrive in a single chunk", async () => {
        const frames = await collect(
            streamOf(
                'event: token\ndata: {"text":"a"}\n\nevent: token\ndata: {"text":"b"}\n\n',
            ),
        );

        expect(frames.map((frame) => frame.data)).toEqual(['{"text":"a"}', '{"text":"b"}']);
    });

    it("buffers an event split across chunks until its terminator arrives", async () => {
        const frames = await collect(streamOf("event: tok", 'en\ndata: {"text":', '"split"}\n\n'));

        expect(frames).toEqual([{ event: "token", data: '{"text":"split"}' }]);
    });

    it("survives a multi-byte character split across a chunk boundary", async () => {
        // Two-byte-per-chunk slicing guarantees the emoji's UTF-8 bytes are torn apart.
        const frames = await collect(byteChunks('event: token\ndata: {"text":"héllo 🚀"}\n\n', 2));

        expect(JSON.parse(frames[0]!.data)).toEqual({ text: "héllo 🚀" });
    });

    it("emits a trailing block when the server closes without a blank line", async () => {
        const frames = await collect(streamOf('event: done\ndata: {"ok":true}'));

        expect(frames).toEqual([{ event: "done", data: '{"ok":true}' }]);
    });

    it("accepts CRLF terminators as well as LF", async () => {
        const frames = await collect(streamOf("event: token\r\ndata: crlf\r\n\r\n"));

        expect(frames).toEqual([{ event: "token", data: "crlf" }]);
    });

    it("stops yielding once the signal aborts", async () => {
        const controller = new AbortController();
        controller.abort();

        expect(await collect(streamOf("event: token\ndata: x\n\n"), controller.signal)).toEqual([]);
    });
});

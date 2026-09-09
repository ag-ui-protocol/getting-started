/**
 * What the binary reader does with what is left in its buffer when the stream
 * ends, and whether it reports at all.
 *
 * A short final frame never throws — the framing loop simply breaks, waiting
 * for bytes that will never arrive — so a `try`/`catch` around the last
 * `processBuffer()` cannot see it. Left that way, a connection cut mid-message
 * silently loses the message and the run reports success.
 */
import { describe, expect, it, vi } from "vitest";
import { Subject } from "rxjs";
import { EventType } from "@ag-ui/core";
import * as proto from "@ag-ui/proto";
import * as encoder from "@ag-ui/encoder";
import { transformHttpEventStream } from "../http";
import { HttpEvent, HttpEventType } from "../../run/http-request";

vi.unmock("@ag-ui/proto");

const eventEncoder = new encoder.EventEncoder({ accept: proto.AGUI_MEDIA_TYPE });

const FIRST = {
  type: EventType.TEXT_MESSAGE_START,
  messageId: "msg-stream-end-first",
  role: "assistant",
} as const;
const SECOND = {
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg-stream-end-first",
  delta: "the tail that never arrives",
} as const;

interface Collected {
  types: string[];
  error?: Error;
  completed: boolean;
}

function drive(chunks: Uint8Array[], debug?: boolean): Collected {
  const chunk$ = new Subject<HttpEvent>();
  const collected: Collected = { types: [], completed: false };
  transformHttpEventStream(chunk$, debug).subscribe({
    next: (event) => collected.types.push(String(event.type)),
    error: (err: Error) => {
      collected.error = err;
    },
    complete: () => {
      collected.completed = true;
    },
  });
  chunk$.next({
    type: HttpEventType.HEADERS,
    status: 200,
    headers: new Headers([["content-type", proto.AGUI_MEDIA_TYPE]]),
  });
  for (const data of chunks) {
    chunk$.next({ type: HttpEventType.DATA, data });
  }
  chunk$.complete();
  return collected;
}

describe("a binary stream that ends mid-frame", () => {
  it("fails the stream instead of dropping the message and completing", () => {
    const whole = eventEncoder.encodeBinary(FIRST);
    const encodedSecond = eventEncoder.encodeBinary(SECOND);
    const truncated = encodedSecond.slice(0, encodedSecond.length - 5);

    const collected = drive([whole, truncated]);

    expect(collected.types).toEqual([EventType.TEXT_MESSAGE_START]);
    expect(collected.completed, "a truncated stream is not a completed one").toBe(false);
    expect(collected.error?.message ?? "").toContain("ended mid-frame");
    expect(collected.error?.message ?? "").toContain("5");
  });

  it("completes normally when the last frame is whole", () => {
    const collected = drive([
      eventEncoder.encodeBinary(FIRST),
      eventEncoder.encodeBinary(SECOND),
    ]);
    expect(collected.types).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(collected.error).toBeUndefined();
    expect(collected.completed).toBe(true);
  });
});

describe("the binary branch and the debug logger", () => {
  it("logs its events, as the SSE branch does", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      drive([eventEncoder.encodeBinary(FIRST)], true);
      expect(
        debug.mock.calls.some((call) => String(call[0]).includes("[PROTO]")),
        `expected a [PROTO] debug line; saw: ${debug.mock.calls
          .map((call) => String(call[0]))
          .join(" | ")}`,
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });
});

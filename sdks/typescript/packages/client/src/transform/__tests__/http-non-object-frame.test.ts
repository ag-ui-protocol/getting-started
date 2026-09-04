/**
 * A frame whose JSON is not an object at all.
 *
 * `parseSSEStream` hands on whatever `JSON.parse` returned, and `null`, a
 * number, a string and an array are all valid JSON documents. The transport's
 * one requirement — a string `type` — cannot be read off any of them, and
 * reading it off `null` throws inside an RxJS `next` handler, where the throw
 * does not become `eventSubject.error` but an asynchronous unhandled rejection:
 * the run then RESOLVES, reporting success for a stream it never read.
 *
 * So these assert two things at once — the run fails, and nothing escaped the
 * stream to be rethrown by the host.
 */
import { describe, expect, it } from "vitest";
import { Subject } from "rxjs";
import { HttpAgent } from "@/agent";
import { transformHttpEventStream } from "../http";
import { HttpEvent, HttpEventType } from "../../run/http-request";

const encoder = new TextEncoder();

/** A fetch that replays `frames` as one SSE body, each as its own frame. */
function sseFetch(frames: string[]) {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

/** Runs `body` while recording anything the host had to rethrow. */
async function withEscapeWatch<T>(body: () => Promise<T>): Promise<{
  result: T;
  escaped: unknown[];
}> {
  const escaped: unknown[] = [];
  const onUncaught = (error: unknown) => escaped.push(error);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
  try {
    const result = await body();
    // reportUnhandledError rethrows on a macrotask, so give it one.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { result, escaped };
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
  }
}

const START = JSON.stringify({
  type: "RUN_STARTED",
  threadId: "t-non-object",
  runId: "r-non-object",
});
const FINISH = JSON.stringify({
  type: "RUN_FINISHED",
  threadId: "t-non-object",
  runId: "r-non-object",
});

describe("a frame whose JSON is not an object", () => {
  for (const frame of ["null", "42", '"str"', "[]"]) {
    it(`fails the run rather than escaping the stream: ${frame}`, async () => {
      const agent = new HttpAgent({
        url: "https://example.test/agent",
        fetch: sseFetch([START, frame, FINISH]) as never,
      });

      const { result, escaped } = await withEscapeWatch(async () => {
        try {
          await agent.runAgent({ runId: "r-non-object" });
          return "resolved" as const;
        } catch (thrown) {
          return thrown instanceof Error ? thrown.message : String(thrown);
        }
      });

      expect(result, "the run must not report success").not.toBe("resolved");
      expect(result).toContain("not a JSON object");
      expect(
        escaped,
        "nothing may escape the stream to the host's unhandled-error path",
      ).toEqual([]);
    });
  }
});

describe("transformHttpEventStream (unit)", () => {
  for (const frame of ["null", "42", '"str"', "[]"]) {
    it(`errors the event stream on ${frame}`, async () => {
      const source$ = new Subject<HttpEvent>();
      const seen: unknown[] = [];
      let errored: unknown;
      let completed = false;
      transformHttpEventStream(source$).subscribe({
        next: (event) => seen.push(event),
        error: (err) => {
          errored = err;
        },
        complete: () => {
          completed = true;
        },
      });

      const { escaped } = await withEscapeWatch(async () => {
        source$.next({
          type: HttpEventType.HEADERS,
          status: 200,
          headers: new Headers([["content-type", "text/event-stream"]]),
        });
        source$.next({
          type: HttpEventType.DATA,
          data: encoder.encode(`data: ${frame}\n\n`),
        });
      });

      expect(seen).toEqual([]);
      expect(completed).toBe(false);
      expect((errored as Error | undefined)?.message).toContain(
        "not a JSON object",
      );
      expect(escaped).toEqual([]);
    });
  }
});

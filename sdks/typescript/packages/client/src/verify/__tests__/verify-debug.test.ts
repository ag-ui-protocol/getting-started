import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { Subject, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { verifyEvents } from "../verify";
import { createDebugLogger, DebugLogger } from "@/debug-logger";
import {
  BaseEvent,
  EventType,
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  RunFinishedEvent,
} from "@ag-ui/core";

describe("verifyEvents debug logging", () => {
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const emitCompleteSequence = (source$: Subject<BaseEvent>) => {
    source$.next({
      type: EventType.RUN_STARTED,
      threadId: "thread-1",
      runId: "run-1",
    } as RunStartedEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    } as TextMessageStartEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "Hello",
    } as TextMessageContentEvent);
    source$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);
    source$.next({
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
    } as RunFinishedEvent);
    source$.complete();
  };

  describe("when debugLogger is falsy", () => {
    it("no console.debug calls when debugLogger is undefined", async () => {
      const source$ = new Subject<BaseEvent>();
      const result$ = verifyEvents(undefined)(source$).pipe(toArray());
      const resultPromise = firstValueFrom(result$);
      emitCompleteSequence(source$);
      await resultPromise;
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it("no console.debug calls when debugLogger is false", async () => {
      const source$ = new Subject<BaseEvent>();
      const result$ = verifyEvents(false)(source$).pipe(toArray());
      const resultPromise = firstValueFrom(result$);
      emitCompleteSequence(source$);
      await resultPromise;
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it("no console.debug calls when debugLogger is null", async () => {
      const source$ = new Subject<BaseEvent>();
      const result$ = verifyEvents(null)(source$).pipe(toArray());
      const resultPromise = firstValueFrom(result$);
      emitCompleteSequence(source$);
      await resultPromise;
      expect(debugSpy).not.toHaveBeenCalled();
    });
  });

  describe("when debug events enabled with verbose", () => {
    let logger: DebugLogger;

    beforeEach(() => {
      logger = createDebugLogger({
        enabled: true,
        events: true,
        lifecycle: true,
        verbose: true,
      })!;
    });

    it("logs full JSON of each event", async () => {
      const source$ = new Subject<BaseEvent>();
      const result$ = verifyEvents(logger)(source$).pipe(toArray());
      const resultPromise = firstValueFrom(result$);
      emitCompleteSequence(source$);
      await resultPromise;

      const verifyCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[VERIFY]"),
      );

      // One log per event in the sequence (5 events)
      expect(verifyCalls.length).toBe(5);

      // In verbose mode, should get JSON strings
      for (const call of verifyCalls) {
        expect(typeof call[1]).toBe("string");
        // Should be valid JSON
        expect(() => JSON.parse(call[1])).not.toThrow();
      }
    });
  });

  describe("when debug events enabled without verbose", () => {
    let logger: DebugLogger;

    beforeEach(() => {
      logger = createDebugLogger({
        enabled: true,
        events: true,
        lifecycle: true,
        verbose: false,
      })!;
    });

    it("logs only { type } summary", async () => {
      const source$ = new Subject<BaseEvent>();
      const result$ = verifyEvents(logger)(source$).pipe(toArray());
      const resultPromise = firstValueFrom(result$);
      emitCompleteSequence(source$);
      await resultPromise;

      const verifyCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[VERIFY]"),
      );

      expect(verifyCalls.length).toBe(5);

      // In summary mode, the second argument should be { type: ... }
      expect(verifyCalls[0][1]).toEqual({ type: EventType.RUN_STARTED });
      expect(verifyCalls[1][1]).toEqual({ type: EventType.TEXT_MESSAGE_START });
      expect(verifyCalls[2][1]).toEqual({
        type: EventType.TEXT_MESSAGE_CONTENT,
      });
      expect(verifyCalls[3][1]).toEqual({ type: EventType.TEXT_MESSAGE_END });
      expect(verifyCalls[4][1]).toEqual({ type: EventType.RUN_FINISHED });
    });
  });

  describe("prefix format", () => {
    it("uses [VERIFY] prefix", async () => {
      const logger = createDebugLogger({
        enabled: true,
        events: true,
        lifecycle: true,
        verbose: false,
      })!;

      const source$ = new Subject<BaseEvent>();
      const result$ = verifyEvents(logger)(source$).pipe(toArray());
      const resultPromise = firstValueFrom(result$);
      emitCompleteSequence(source$);
      await resultPromise;

      const allCalls = debugSpy.mock.calls;
      for (const call of allCalls) {
        expect(call[0]).toMatch(/^\[VERIFY\]/);
      }
    });
  });

  describe("event count verification", () => {
    it("each event in the sequence produces exactly one debug log", async () => {
      const logger = createDebugLogger({
        enabled: true,
        events: true,
        lifecycle: true,
        verbose: false,
      })!;

      const source$ = new Subject<BaseEvent>();
      const result$ = verifyEvents(logger)(source$).pipe(toArray());
      const resultPromise = firstValueFrom(result$);
      emitCompleteSequence(source$);
      const events = await resultPromise;

      const verifyCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[VERIFY]"),
      );

      // Exactly one log per event
      expect(verifyCalls.length).toBe(events.length);
    });
  });
});

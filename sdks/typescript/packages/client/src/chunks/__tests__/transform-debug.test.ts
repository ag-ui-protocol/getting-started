import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { of, concat, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import { transformChunks } from "../transform";
import { createDebugLogger, DebugLogger } from "@/debug-logger";
import {
  BaseEvent,
  EventType,
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  ReasoningMessageChunkEvent,
  RunFinishedEvent,
} from "@ag-ui/core";

describe("transformChunks debug logging", () => {
  let debugSpy: MockInstance<typeof console.debug>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const closeEvent: RunFinishedEvent = {
    type: EventType.RUN_FINISHED,
    threadId: "thread-1",
    runId: "run-1",
  };

  describe("when debugLogger is falsy", () => {
    it("no console.debug calls when debugLogger is undefined", async () => {
      const chunk: TextMessageChunkEvent = {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "Hello",
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(undefined)(events$).pipe(toArray()));
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it("no console.debug calls when debugLogger is false", async () => {
      const chunk: TextMessageChunkEvent = {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "Hello",
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(false)(events$).pipe(toArray()));
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it("no console.debug calls when debugLogger is null", async () => {
      const chunk: TextMessageChunkEvent = {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "Hello",
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(null)(events$).pipe(toArray()));
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

    it("TEXT_MESSAGE_CHUNK produces debug logs for TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END with full JSON payloads", async () => {
      const chunk: TextMessageChunkEvent = {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "Hello",
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(logger)(events$).pipe(toArray()));

      // Should have logs for: TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END
      const transformCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[TRANSFORM]"),
      );
      expect(transformCalls.length).toBe(3);

      expect(transformCalls[0][0]).toBe("[TRANSFORM] TEXT_MESSAGE_START");
      expect(typeof transformCalls[0][1]).toBe("string"); // JSON.stringify in verbose mode
      expect(JSON.parse(transformCalls[0][1])).toMatchObject({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-1",
      });

      expect(transformCalls[1][0]).toBe("[TRANSFORM] TEXT_MESSAGE_CONTENT");
      expect(typeof transformCalls[1][1]).toBe("string");
      expect(JSON.parse(transformCalls[1][1])).toMatchObject({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
      });

      expect(transformCalls[2][0]).toBe("[TRANSFORM] TEXT_MESSAGE_END");
      expect(typeof transformCalls[2][1]).toBe("string");
      expect(JSON.parse(transformCalls[2][1])).toMatchObject({
        type: EventType.TEXT_MESSAGE_END,
        messageId: "msg-1",
      });
    });

    it("TOOL_CALL_CHUNK produces debug logs for TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END with full payloads", async () => {
      const chunk: ToolCallChunkEvent = {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc-1",
        toolCallName: "myTool",
        delta: '{"key":"value"}',
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(logger)(events$).pipe(toArray()));

      const transformCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[TRANSFORM]"),
      );
      expect(transformCalls.length).toBe(3);

      expect(transformCalls[0][0]).toBe("[TRANSFORM] TOOL_CALL_START");
      expect(JSON.parse(transformCalls[0][1])).toMatchObject({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-1",
        toolCallName: "myTool",
      });

      expect(transformCalls[1][0]).toBe("[TRANSFORM] TOOL_CALL_ARGS");
      expect(JSON.parse(transformCalls[1][1])).toMatchObject({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc-1",
      });

      expect(transformCalls[2][0]).toBe("[TRANSFORM] TOOL_CALL_END");
      expect(JSON.parse(transformCalls[2][1])).toMatchObject({
        type: EventType.TOOL_CALL_END,
        toolCallId: "tc-1",
      });
    });

    it("REASONING_MESSAGE_CHUNK produces corresponding debug logs", async () => {
      const chunk: ReasoningMessageChunkEvent = {
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "rmsg-1",
        delta: "thinking...",
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(logger)(events$).pipe(toArray()));

      const transformCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[TRANSFORM]"),
      );
      expect(transformCalls.length).toBe(3);

      expect(transformCalls[0][0]).toBe("[TRANSFORM] REASONING_MESSAGE_START");
      expect(transformCalls[1][0]).toBe("[TRANSFORM] REASONING_MESSAGE_CONTENT");
      expect(transformCalls[2][0]).toBe("[TRANSFORM] REASONING_MESSAGE_END");
    });
  });

  describe("when debug events enabled without verbose (summary mode)", () => {
    let logger: DebugLogger;

    beforeEach(() => {
      logger = createDebugLogger({
        enabled: true,
        events: true,
        lifecycle: true,
        verbose: false,
      })!;
    });

    it("TEXT_MESSAGE_CHUNK logs include summary with messageId", async () => {
      const chunk: TextMessageChunkEvent = {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "Hello",
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(logger)(events$).pipe(toArray()));

      const transformCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[TRANSFORM]"),
      );

      // In summary mode, the second argument should be the summary object, not a JSON string
      expect(transformCalls[0][0]).toBe("[TRANSFORM] TEXT_MESSAGE_START");
      expect(transformCalls[0][1]).toEqual({ messageId: "msg-1" });

      expect(transformCalls[1][0]).toBe("[TRANSFORM] TEXT_MESSAGE_CONTENT");
      expect(transformCalls[1][1]).toEqual({ messageId: "msg-1" });

      expect(transformCalls[2][0]).toBe("[TRANSFORM] TEXT_MESSAGE_END");
      expect(transformCalls[2][1]).toEqual({ messageId: "msg-1" });
    });

    it("TOOL_CALL_CHUNK logs include summary with toolCallId/toolCallName", async () => {
      const chunk: ToolCallChunkEvent = {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc-1",
        toolCallName: "myTool",
        delta: '{"key":"value"}',
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(logger)(events$).pipe(toArray()));

      const transformCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[TRANSFORM]"),
      );

      expect(transformCalls[0][0]).toBe("[TRANSFORM] TOOL_CALL_START");
      expect(transformCalls[0][1]).toEqual({
        toolCallId: "tc-1",
        toolCallName: "myTool",
      });

      expect(transformCalls[1][0]).toBe("[TRANSFORM] TOOL_CALL_ARGS");
      expect(transformCalls[1][1]).toEqual({ toolCallId: "tc-1" });

      expect(transformCalls[2][0]).toBe("[TRANSFORM] TOOL_CALL_END");
      expect(transformCalls[2][1]).toEqual({ toolCallId: "tc-1" });
    });

    it("REASONING_MESSAGE_CHUNK logs include summary with messageId", async () => {
      const chunk: ReasoningMessageChunkEvent = {
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "rmsg-1",
        delta: "thinking...",
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(logger)(events$).pipe(toArray()));

      const transformCalls = debugSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].startsWith("[TRANSFORM]"),
      );

      expect(transformCalls[0][0]).toBe("[TRANSFORM] REASONING_MESSAGE_START");
      expect(transformCalls[0][1]).toEqual({ messageId: "rmsg-1" });

      expect(transformCalls[1][0]).toBe("[TRANSFORM] REASONING_MESSAGE_CONTENT");
      expect(transformCalls[1][1]).toEqual({ messageId: "rmsg-1" });

      expect(transformCalls[2][0]).toBe("[TRANSFORM] REASONING_MESSAGE_END");
      expect(transformCalls[2][1]).toEqual({ messageId: "rmsg-1" });
    });
  });

  describe("prefix format", () => {
    it("uses [TRANSFORM] prefix", async () => {
      const logger = createDebugLogger({
        enabled: true,
        events: true,
        lifecycle: true,
        verbose: false,
      })!;

      const chunk: TextMessageChunkEvent = {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "Hello",
      };
      const events$ = concat(of(chunk as BaseEvent), of(closeEvent as BaseEvent));
      await firstValueFrom(transformChunks(logger)(events$).pipe(toArray()));

      const allCalls = debugSpy.mock.calls;
      for (const call of allCalls) {
        expect(call[0]).toMatch(/^\[TRANSFORM\]/);
      }
    });
  });
});

import { from, lastValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  BaseEvent,
  EventType,
  TextMessageChunkEvent,
  ToolCallChunkEvent,
} from "@ag-ui/core";
import { transformChunks } from "../transform";
import { describe, expect, it } from "vitest";

// A continuation chunk MAY repeat a field its opener established, but only with
// the same value: a conflicting repeat is fatal, the same judgment the
// continuation-owner rule passes on a disagreeing subagentRunId.
describe("transformChunks opener agreement", () => {
  const expand = (events: BaseEvent[]) =>
    lastValueFrom(from(events).pipe(transformChunks(false), toArray()));

  const textChunk = (fields: Partial<TextMessageChunkEvent>): TextMessageChunkEvent =>
    ({ type: EventType.TEXT_MESSAGE_CHUNK, ...fields }) as TextMessageChunkEvent;

  const toolChunk = (fields: Partial<ToolCallChunkEvent>): ToolCallChunkEvent =>
    ({ type: EventType.TOOL_CALL_CHUNK, ...fields }) as ToolCallChunkEvent;

  it("rejects a continuation whose role conflicts with the opener's explicit role", async () => {
    await expect(
      expand([
        textChunk({ messageId: "msg-1", role: "user", delta: "a" }),
        textChunk({ messageId: "msg-1", role: "assistant", delta: "b" }),
      ]),
    ).rejects.toThrow(
      "Cannot continue text message 'msg-1': chunk role 'assistant' does not match the open stream's role 'user'.",
    );
  });

  it("rejects a continuation whose role conflicts with the defaulted assistant role", async () => {
    await expect(
      expand([
        textChunk({ messageId: "msg-1", delta: "a" }),
        textChunk({ messageId: "msg-1", role: "user", delta: "b" }),
      ]),
    ).rejects.toThrow(
      "Cannot continue text message 'msg-1': chunk role 'user' does not match the open stream's role 'assistant'.",
    );
  });

  it("rejects a continuation that introduces a name the opener did not carry", async () => {
    await expect(
      expand([
        textChunk({ messageId: "msg-1", delta: "a" }),
        textChunk({ messageId: "msg-1", name: "bob", delta: "b" }),
      ]),
    ).rejects.toThrow(
      "Cannot continue text message 'msg-1': chunk name 'bob' does not match the open stream's name (absent).",
    );
  });

  it("rejects a continuation whose toolCallName conflicts with the opener's", async () => {
    await expect(
      expand([
        toolChunk({ toolCallId: "tc-1", toolCallName: "search", delta: "{" }),
        toolChunk({ toolCallId: "tc-1", toolCallName: "delete", delta: "}" }),
      ]),
    ).rejects.toThrow(
      "Cannot continue tool call 'tc-1': chunk toolCallName 'delete' does not match the open stream's toolCallName 'search'.",
    );
  });

  it("rejects a continuation whose parentMessageId conflicts with the opener's", async () => {
    await expect(
      expand([
        toolChunk({
          toolCallId: "tc-1",
          toolCallName: "search",
          parentMessageId: "msg-1",
          delta: "{",
        }),
        toolChunk({ toolCallId: "tc-1", parentMessageId: "msg-2", delta: "}" }),
      ]),
    ).rejects.toThrow(
      "Cannot continue tool call 'tc-1': chunk parentMessageId 'msg-2' does not match the open stream's parentMessageId 'msg-1'.",
    );
  });

  it("accepts a continuation that repeats the opener's fields with identical values", async () => {
    const events = await expand([
      toolChunk({
        toolCallId: "tc-1",
        toolCallName: "search",
        parentMessageId: "msg-1",
        delta: "{",
      }),
      toolChunk({
        toolCallId: "tc-1",
        toolCallName: "search",
        parentMessageId: "msg-1",
        delta: "}",
      }),
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
    ]);
    expect(events.map((e) => e.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("accepts a continuation repeating the assistant role the opener defaulted to", async () => {
    const events = await expand([
      textChunk({ messageId: "msg-1", delta: "a" }),
      textChunk({ messageId: "msg-1", role: "assistant", delta: "b" }),
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
    ]);
    expect(events.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("does not treat a chunk opening a new message as a conflicting continuation", async () => {
    const events = await expand([
      textChunk({ messageId: "msg-1", role: "user", delta: "a" }),
      textChunk({ messageId: "msg-2", role: "assistant", delta: "b" }),
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
    ]);
    expect(events.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });
});

// A continuation carrying `subagentRunId: null` is a violation the verifier
// names. Expansion must not read the null as absence and substitute the
// opener's owner — that concealed the defect on paths where expansion runs
// before enforcement. The null rides the synthesized event to the judge.
describe("transformChunks null attribution preservation", () => {
  const expand = (events: BaseEvent[]) =>
    lastValueFrom(from(events).pipe(transformChunks(false), toArray()));

  it("preserves a continuation's null subagentRunId for enforcement to reject", async () => {
    const events = await expand([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "a",
      } as TextMessageChunkEvent,
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "b",
        subagentRunId: null,
      } as unknown as TextMessageChunkEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
    ]);
    const contents = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
    expect(contents).toHaveLength(2);
    expect("subagentRunId" in contents[0]).toBe(false);
    expect((contents[1] as { subagentRunId?: string | null }).subagentRunId).toBeNull();
  });

  it("preserves a metadata-only continuation's null subagentRunId", async () => {
    const events = await expand([
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc-1",
        toolCallName: "search",
        delta: "{}",
      } as ToolCallChunkEvent,
      {
        type: EventType.TOOL_CALL_CHUNK,
        metadata: { finish: "stop" },
        subagentRunId: null,
      } as unknown as ToolCallChunkEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
    ]);
    const args = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);
    expect(args).toHaveLength(2);
    expect((args[1] as { subagentRunId?: string | null }).subagentRunId).toBeNull();
  });
});

// The synthesized START deliberately carries no rawEvent, so a first chunk
// with a provider payload but no delta needs a content event as the carrier —
// otherwise the payload is silently lost.
describe("transformChunks rawEvent-only chunks", () => {
  const expand = (events: BaseEvent[]) =>
    lastValueFrom(from(events).pipe(transformChunks(false), toArray()));

  it("carries a first chunk's rawEvent on a zero-delta content event", async () => {
    const events = await expand([
      {
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        rawEvent: { provider: "payload" },
      } as TextMessageChunkEvent,
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent,
    ]);
    expect(events.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    const content = events[1] as { delta?: string; rawEvent?: unknown };
    expect(content.delta).toBe("");
    expect(content.rawEvent).toEqual({ provider: "payload" });
  });
});

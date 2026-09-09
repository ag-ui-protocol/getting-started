import {
  createActivityDeltaEvent,
  createActivitySnapshotEvent,
  createCustomEvent,
  createMessagesSnapshotEvent,
  createRawEvent,
  createRunErrorEvent,
  createRunFinishedEvent,
  createRunFinishedInterruptEvent,
  createRunFinishedSuccessEvent,
  createRunStartedEvent,
  createStateDeltaEvent,
  createStateSnapshotEvent,
  createStepFinishedEvent,
  createStepStartedEvent,
  createTextMessageChunkEvent,
  createTextMessageContentEvent,
  createTextMessageEndEvent,
  createTextMessageStartEvent,
  createToolCallArgsEvent,
  createToolCallChunkEvent,
  createToolCallEndEvent,
  createToolCallResultEvent,
  createToolCallStartEvent,
} from "../event-factories";
import { EventType } from "../index";

describe("event factories", () => {
  it("creates TEXT_MESSAGE_START without materialising the role default", () => {
    const event = createTextMessageStartEvent({ messageId: "msg-1" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(event.messageId).toBe("msg-1");
    // An absent role MEANS assistant — the schema states that in prose, and a
    // validator treats a default as documentation rather than behaviour, so
    // nothing invents the value.
    expect(event.role).toBeUndefined();
  });

  it("creates TEXT_MESSAGE_START with custom role", () => {
    const event = createTextMessageStartEvent({ messageId: "msg-2", role: "user" });

    expect(event.role).toBe("user");
  });

  it("accepts empty deltas in TEXT_MESSAGE_CONTENT", () => {
    const event = createTextMessageContentEvent({ messageId: "msg-3", delta: "" });
    expect(event.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(event.delta).toBe("");
  });

  it("creates TEXT_MESSAGE_CONTENT when delta provided", () => {
    const event = createTextMessageContentEvent({ messageId: "msg-4", delta: "hi" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(event.delta).toBe("hi");
  });

  it("creates TEXT_MESSAGE_END", () => {
    const event = createTextMessageEndEvent({ messageId: "msg-5" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_END);
    expect(event.messageId).toBe("msg-5");
  });

  it("creates TEXT_MESSAGE_START with name", () => {
    const event = createTextMessageStartEvent({
      messageId: "msg-1",
      name: "research-agent",
    });
    expect(event.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(event.messageId).toBe("msg-1");
    expect(event.role).toBeUndefined();
    expect(event.name).toBe("research-agent");
  });

  it("creates TEXT_MESSAGE_START without name", () => {
    const event = createTextMessageStartEvent({
      messageId: "msg-1",
    });
    expect(event.name).toBeUndefined();
  });

  it("creates TEXT_MESSAGE_CHUNK with name", () => {
    const event = createTextMessageChunkEvent({
      messageId: "msg-1",
      delta: "Hello",
      name: "research-agent",
    });
    expect(event.type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect(event.name).toBe("research-agent");
  });

  it("creates TEXT_MESSAGE_CHUNK without name", () => {
    const event = createTextMessageChunkEvent({
      messageId: "msg-1",
      delta: "Hello",
    });
    expect(event.name).toBeUndefined();
  });

  it("creates TEXT_MESSAGE_CHUNK with optional fields", () => {
    const event = createTextMessageChunkEvent({ delta: "partial" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_CHUNK);
    expect(event.delta).toBe("partial");
    expect(event.messageId).toBeUndefined();
  });

  it("creates TOOL_CALL_START/ARGS/END/CHUNK/RESULT", () => {
    const start = createToolCallStartEvent({
      toolCallId: "tc-1",
      toolCallName: "search",
      parentMessageId: "msg-parent",
    });
    const args = createToolCallArgsEvent({ toolCallId: "tc-1", delta: '{"q":"hi"}' });
    const chunk = createToolCallChunkEvent({
      toolCallId: "tc-1",
      toolCallName: "search",
      delta: "partial",
    });
    const end = createToolCallEndEvent({ toolCallId: "tc-1" });
    const result = createToolCallResultEvent({
      messageId: "msg-6",
      toolCallId: "tc-1",
      content: '{"ok":true}',
      role: "tool",
    });

    expect(start.type).toBe(EventType.TOOL_CALL_START);
    expect(start.parentMessageId).toBe("msg-parent");
    expect(args.delta).toContain("q");
    expect(chunk.delta).toBe("partial");
    expect(end.type).toBe(EventType.TOOL_CALL_END);
    expect(result.role).toBe("tool");
    expect(result.content).toBe('{"ok":true}');
  });

  it("creates STATE_SNAPSHOT and STATE_DELTA", () => {
    const snapshot = createStateSnapshotEvent({ snapshot: { step: 1 } });
    const delta = createStateDeltaEvent({ delta: [{ op: "add", path: "/foo", value: "bar" }] });

    expect(snapshot.type).toBe(EventType.STATE_SNAPSHOT);
    expect(snapshot.snapshot).toEqual({ step: 1 });
    expect(delta.type).toBe(EventType.STATE_DELTA);
    expect(delta.delta[0]).toMatchObject({ op: "add" });
  });

  it("creates MESSAGES_SNAPSHOT and validates nested messages", () => {
    const event = createMessagesSnapshotEvent({
      messages: [
        { id: "u1", role: "user", content: "hello" },
        { id: "a1", role: "assistant", content: "hi there" },
      ],
      timestamp: 123,
    });

    expect(event.type).toBe(EventType.MESSAGES_SNAPSHOT);
    expect(event.messages).toHaveLength(2);
    expect(event.timestamp).toBe(123);
  });

  it("creates ACTIVITY_SNAPSHOT and ACTIVITY_DELTA", () => {
    const snapshot = createActivitySnapshotEvent({
      messageId: "activity-1",
      activityType: "PLAN",
      content: { steps: [] },
    });
    const delta = createActivityDeltaEvent({
      messageId: "activity-1",
      activityType: "PLAN",
      patch: [{ op: "replace", path: "/steps/0", value: "done" }],
    });

    expect(snapshot.type).toBe(EventType.ACTIVITY_SNAPSHOT);
    // Absent means replace-the-snapshot; the prose default is not materialised.
    expect(snapshot.replace).toBeUndefined();
    expect(delta.type).toBe(EventType.ACTIVITY_DELTA);
    expect(delta.patch[0].path).toBe("/steps/0");
  });

  it("creates RAW and CUSTOM events", () => {
    const raw = createRawEvent({ event: { any: true }, source: "webhook" });
    const custom = createCustomEvent({ name: "metric", value: 42 });

    expect(raw.type).toBe(EventType.RAW);
    expect(raw.source).toBe("webhook");
    expect(custom.type).toBe(EventType.CUSTOM);
    expect(custom.value).toBe(42);
  });

  it("creates RUN events", () => {
    const started = createRunStartedEvent({
      threadId: "t1",
      runId: "r1",
      input: { threadId: "t1", runId: "r1", state: {}, messages: [], tools: [], context: [], forwardedProps: {} },
    });
    const finished = createRunFinishedEvent({ threadId: "t1", runId: "r1", result: { ok: true } });
    const error = createRunErrorEvent({ message: "boom", code: "E_FAIL" });

    expect(started.type).toBe(EventType.RUN_STARTED);
    expect(started.input?.runId).toBe("r1");
    expect(finished.result).toEqual({ ok: true });
    expect(error.code).toBe("E_FAIL");
  });

  it("creates STEP events", () => {
    const started = createStepStartedEvent({ stepName: "fetch" });
    const finished = createStepFinishedEvent({ stepName: "fetch" });

    expect(started.type).toBe(EventType.STEP_STARTED);
    expect(finished.type).toBe(EventType.STEP_FINISHED);
    expect(finished.stepName).toBe("fetch");
  });
});

describe("createRunFinishedSuccessEvent", () => {
  it("produces a RUN_FINISHED event with outcome={ type: 'success' }", () => {
    const e = createRunFinishedSuccessEvent({
      threadId: "t-1",
      runId: "r-1",
      result: { ok: true },
    });
    expect(e.type).toBe(EventType.RUN_FINISHED);
    expect(e.outcome).toEqual({ type: "success" });
    expect(e.result).toEqual({ ok: true });
  });
});

describe("createRunFinishedInterruptEvent", () => {
  it("produces a RUN_FINISHED event with outcome={ type: 'interrupt', interrupts }", () => {
    const e = createRunFinishedInterruptEvent({
      threadId: "t-1",
      runId: "r-1",
      interrupts: [{ id: "int-1", reason: "tool_call" }],
    });
    expect(e.type).toBe(EventType.RUN_FINISHED);
    expect(e.outcome?.type).toBe("interrupt");
    if (e.outcome?.type === "interrupt") {
      expect(e.outcome.interrupts).toHaveLength(1);
    }
  });

  it("rejects empty interrupts array", () => {
    expect(() =>
      createRunFinishedInterruptEvent({
        threadId: "t-1",
        runId: "r-1",
        interrupts: [],
      }),
    ).toThrow();
  });
});

describe("createRunFinishedEvent", () => {
  it("produces a RUN_FINISHED event with no outcome (legacy shape)", () => {
    const e = createRunFinishedEvent({ threadId: "t-1", runId: "r-1", result: { ok: true } });
    expect(e.outcome).toBeUndefined();
    expect(e.result).toEqual({ ok: true });
  });

  it("accepts an explicit outcome={ type: 'success' }", () => {
    const e = createRunFinishedEvent({
      threadId: "t-1",
      runId: "r-1",
      outcome: { type: "success" },
    });
    expect(e.outcome).toEqual({ type: "success" });
  });

  it("accepts an explicit outcome={ type: 'interrupt', interrupts }", () => {
    const e = createRunFinishedEvent({
      threadId: "t-1",
      runId: "r-1",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "int-1", reason: "tool_call" }],
      },
    });
    expect(e.outcome?.type).toBe("interrupt");
  });
});

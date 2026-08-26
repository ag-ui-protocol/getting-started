import { describe, expect, it, vi } from "vitest";
import { Subject, firstValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  AGUI_METADATA_KEY,
  ActivityDeltaEvent,
  ActivityMessage,
  ActivitySnapshotEvent,
  AssistantMessage,
  BaseEvent,
  EventType,
  Message,
  MessagesSnapshotEvent,
  ReasoningEncryptedValueEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
  StepStartedEvent,
  TextMessageChunkEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { transformChunks } from "@/chunks/transform";
import { AbstractAgent } from "@/agent";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

const createInput = (): RunAgentInput => ({
  messages: [],
  state: {},
  threadId: "test-thread",
  runId: "test-run",
  tools: [],
  context: [],
});

/**
 * Runs a stream of events through the reducer and returns the final message
 * list, so each test can assert on what a consumer actually ends up holding.
 */
const applyAndGetMessages = async (events: BaseEvent[]): Promise<Message[]> => {
  const events$ = new Subject<BaseEvent>();
  const input = createInput();
  const agent = createAgent();
  const result$ = defaultApplyEvents(input, events$, agent, []);
  const updates = firstValueFrom(result$.pipe(toArray()));

  for (const event of events) {
    events$.next(event);
  }
  events$.complete();

  const emitted = await updates;
  const last = [...emitted].reverse().find((u) => u.messages !== undefined);
  return last?.messages ?? [];
};

const runStarted = { type: EventType.RUN_STARTED } as RunStartedEvent;

describe("metadata merging into text messages", () => {
  it("merges across start, content and end with the last write winning", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { source: "openai", stage: "start" },
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Hello",
        metadata: { stage: "content" },
      } as TextMessageContentEvent,
      // The interesting values are only known at the end.
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        metadata: { stage: "end", usage: { input: 10, output: 20 } },
      } as TextMessageEndEvent,
    ]);

    expect(messages[0].metadata).toEqual({
      source: "openai",
      stage: "end",
      usage: { input: 10, output: 20 },
    });
  });

  it("leaves metadata absent when no event carries any", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Hi",
      } as TextMessageContentEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
    ]);

    expect(messages[0]).not.toHaveProperty("metadata");
  });

  it("changes nothing when a later event carries an empty object", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { a: 1 },
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "x",
        metadata: {},
      } as TextMessageContentEvent,
    ]);

    expect(messages[0].metadata).toEqual({ a: 1 });
  });

  it("keeps a null value rather than dropping the key", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { finishReason: "stop" },
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        metadata: { finishReason: null },
      } as TextMessageEndEvent,
    ]);

    expect(messages[0].metadata).toEqual({ finishReason: null });
  });

  it("does not alias the event payload into the message", async () => {
    const shared = { tags: ["a"] };
    const startEvent = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
      metadata: shared,
    } as TextMessageStartEvent;

    const messages = await applyAndGetMessages([runStarted, startEvent]);

    // Mutating the caller's object afterwards must not reach the message.
    shared.tags.push("b");
    expect((messages[0].metadata as { tags: string[] }).tags).toEqual(["a"]);
  });
});

describe("wholesale replacement", () => {
  it("replaces an array instead of concatenating it", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { tags: ["a", "b", "c"] },
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        metadata: { tags: ["z"] },
      } as TextMessageEndEvent,
    ]);

    expect(messages[0].metadata).toEqual({ tags: ["z"] });
  });

  it("replaces a nested object under the reserved key instead of deep-merging", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
        metadata: { [AGUI_METADATA_KEY]: { usage: { input: 10 }, dropped: true } },
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
        metadata: { [AGUI_METADATA_KEY]: { usage: { output: 20 } } },
      } as TextMessageEndEvent,
    ]);

    // A deep merge would leave `dropped` and `usage.input` behind.
    expect(messages[0].metadata).toEqual({ [AGUI_METADATA_KEY]: { usage: { output: 20 } } });
  });
});

describe("metadata on tool calls and results", () => {
  it("merges tool call event metadata into the tool call itself", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        metadata: { stage: "start", provider: "anthropic" },
      } as ToolCallStartEvent,
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc1",
        delta: '{"q":1}',
        metadata: { stage: "args" },
      } as ToolCallArgsEvent,
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: "tc1",
        metadata: { stage: "end" },
      } as ToolCallEndEvent,
    ]);

    const assistant = messages.find((m) => m.role === "assistant") as AssistantMessage;
    const toolCall = assistant.toolCalls!.find((tc) => tc.id === "tc1")!;
    expect(toolCall.metadata).toEqual({ stage: "end", provider: "anthropic" });
    // It stays off the parent, which several tool calls can share.
    expect(assistant).not.toHaveProperty("metadata");
  });

  it("puts tool result metadata on the tool message it creates", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
      } as ToolCallStartEvent,
      { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as ToolCallEndEvent,
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tm1",
        toolCallId: "tc1",
        content: "result",
        metadata: { latencyMs: 12 },
      } as ToolCallResultEvent,
    ]);

    const toolMessage = messages.find((m) => m.role === "tool")!;
    expect(toolMessage.metadata).toEqual({ latencyMs: 12 });

    // And it must not have landed on the assistant message that owns the call.
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant).not.toHaveProperty("metadata");
  });
});

describe("metadata on reasoning messages", () => {
  it("merges across the reasoning message lifecycle", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "r1",
        role: "reasoning",
        metadata: { stage: "start" },
      } as ReasoningMessageStartEvent,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "thinking",
        metadata: { stage: "content" },
      } as ReasoningMessageContentEvent,
      {
        type: EventType.REASONING_MESSAGE_END,
        messageId: "r1",
        metadata: { stage: "end", tokens: 7 },
      } as ReasoningMessageEndEvent,
    ]);

    expect(messages[0].metadata).toEqual({ stage: "end", tokens: 7 });
  });

  it("keeps encrypted value metadata off the message it names", async () => {
    // The event attaches a blob to an existing entity rather than building one,
    // so its metadata stays on the event — which is also what keeps a compacted
    // replay agreeing with the original stream.
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.REASONING_MESSAGE_START,
        messageId: "r1",
        role: "reasoning",
      } satisfies ReasoningMessageStartEvent,
      {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: "r1",
        encryptedValue: "secret",
        metadata: { sealed: true },
      } satisfies ReasoningEncryptedValueEvent,
    ]);

    const message = messages[0];
    if (message?.role !== "reasoning") {
      throw new Error(`Expected reasoning message, got role ${message?.role}`);
    }

    expect(message.encryptedValue).toBe("secret");
    expect(message).not.toHaveProperty("metadata");
  });
});

describe("metadata on activity messages", () => {
  it("merges across a snapshot and a following delta", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "a1",
        activityType: "PLAN",
        content: { steps: ["one"] },
        replace: true,
        metadata: { origin: "planner", revision: 1 },
      } as ActivitySnapshotEvent,
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: "a1",
        activityType: "PLAN",
        patch: [{ op: "add", path: "/steps/-", value: "two" }],
        metadata: { revision: 2 },
      } as ActivityDeltaEvent,
    ]);

    expect(messages[0].metadata).toEqual({ origin: "planner", revision: 2 });
  });

  it("keeps accumulated metadata when a replacing snapshot carries none", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "a1",
        activityType: "PLAN",
        content: { steps: ["one"] },
        replace: true,
        metadata: { origin: "planner" },
      } as ActivitySnapshotEvent,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "a1",
        activityType: "PLAN",
        content: { steps: ["one", "two"] },
        replace: true,
      } as ActivitySnapshotEvent,
    ]);

    expect(messages[0].metadata).toEqual({ origin: "planner" });
  });
});

describe("metadata that belongs to a non-message event", () => {
  it("never reaches a message from RUN_STARTED, STEP_STARTED or RUN_FINISHED", async () => {
    const messages = await applyAndGetMessages([
      {
        type: EventType.RUN_STARTED,
        threadId: "t",
        runId: "r",
        metadata: { run: true },
      } as RunStartedEvent,
      {
        type: EventType.STEP_STARTED,
        stepName: "s1",
        metadata: { step: true },
      } as StepStartedEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as TextMessageStartEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "hi",
      } as TextMessageContentEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as TextMessageEndEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r",
        metadata: { usage: { total: 100 } },
      } as RunFinishedEvent,
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toHaveProperty("metadata");
  });
});

describe("metadata through a messages snapshot", () => {
  it("carries each message's own metadata and does not leak the event's", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.MESSAGES_SNAPSHOT,
        metadata: { snapshotLevel: true },
        messages: [
          { id: "m1", role: "assistant", content: "a", metadata: { own: 1 } },
          { id: "m2", role: "assistant", content: "b" },
        ],
      } as MessagesSnapshotEvent,
    ]);

    expect(messages[0].metadata).toEqual({ own: 1 });
    // The second message had none, and must not inherit the first's or the event's.
    expect(messages[1]).not.toHaveProperty("metadata");
  });
});

describe("chunked stream end to end", () => {
  // The motivating case from the ticket: a provider streams text as chunks and
  // sends usage only in a final chunk that carries no delta. Piping through
  // transformChunks and then the reducer must land that usage on the message.
  it("lands a final usage-only chunk's metadata on the message", async () => {
    const events$ = new Subject<BaseEvent>();
    const input = createInput();
    const agent = createAgent();
    const result$ = defaultApplyEvents(input, events$.pipe(transformChunks()), agent, []);
    const updates = firstValueFrom(result$.pipe(toArray()));

    events$.next(runStarted);
    events$.next({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      role: "assistant",
      delta: "Hello",
      metadata: { source: "openai" },
    } as TextMessageChunkEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      metadata: { usage: { input: 10, output: 340 }, finishReason: "stop" },
    } as TextMessageChunkEvent);
    events$.complete();

    const emitted = await updates;
    const messages = [...emitted].reverse().find((u) => u.messages !== undefined)!.messages!;

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello");
    expect(messages[0].metadata).toEqual({
      source: "openai",
      usage: { input: 10, output: 340 },
      finishReason: "stop",
    });
  });
});

describe("activity delta metadata when the patch fails", () => {
  it("still merges metadata but leaves content unchanged", async () => {
    // Metadata is independent of the patch: a stale path should not cost the
    // message its usage or trace keys.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "a1",
        activityType: "PLAN",
        content: { steps: ["one"] },
        replace: true,
        metadata: { revision: 1 },
      } as ActivitySnapshotEvent,
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: "a1",
        activityType: "PLAN",
        // Removing a path that does not exist makes applyPatch throw.
        patch: [{ op: "remove", path: "/missing/deeply" }],
        metadata: { revision: 2, usage: { total: 9 } },
      } as ActivityDeltaEvent,
    ]);

    const activity = messages.find((m) => m.role === "activity")!;
    expect((activity as ActivityMessage).content).toEqual({ steps: ["one"] });
    expect(activity.metadata).toEqual({ revision: 2, usage: { total: 9 } });

    warn.mockRestore();
  });
});

describe("metadata on a message provided by a snapshot", () => {
  it("merges a later event's metadata onto a snapshot-provided message", async () => {
    const messages = await applyAndGetMessages([
      runStarted,
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "m1", role: "assistant", content: "original", metadata: { a: 1 } }],
      } as MessagesSnapshotEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "-appended",
        metadata: { b: 2 },
      } as TextMessageContentEvent,
    ]);

    expect(messages[0].content).toBe("original-appended");
    expect(messages[0].metadata).toEqual({ a: 1, b: 2 });
  });
});

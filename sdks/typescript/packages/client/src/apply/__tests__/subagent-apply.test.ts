import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  BaseEvent,
  EventType,
  Message,
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ActivitySnapshotEvent,
  RunAgentInput,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

describe("defaultApplyEvents with subagentRunId attribution", () => {
  it("should copy subagentRunId from TEXT_MESSAGE_START onto the newly created message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
      subagentRunId: "sub-1",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg1",
      delta: "Hello",
    } as TextMessageContentEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "msg1");

    expect(message).toBeDefined();
    expect((message as any).subagentRunId).toBe("sub-1");
  });

  it("treats a null attribution tag as absent — nothing persists it into state", async () => {
    // The verifier is the rejection layer for null tags; this reducer also runs
    // on unverified inputs, where persisting the null meant it was cloned into
    // the next run's input and serialized back out — an egress path for a
    // spelling the contract forbids (PNI-199 alignment).
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg1",
      role: "assistant",
      subagentRunId: null,
    } as unknown as TextMessageStartEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg1",
    } as TextMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "msg1");

    expect(message).toBeDefined();
    expect("subagentRunId" in (message as object)).toBe(false);
  });

  it("strips a null tag from snapshot messages and the input echo — nothing persists it", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };
    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.RUN_STARTED,
      input: {
        messages: [{ id: "echo1", role: "assistant", content: "x", subagentRunId: null }],
      },
    } as unknown as RunStartedEvent);
    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "snap1", role: "assistant", content: "y", subagentRunId: null },
        { id: "snap2", role: "assistant", content: "z", subagentRunId: "s1" },
      ],
    } as unknown as BaseEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalMessages = stateUpdates[stateUpdates.length - 1]?.messages ?? [];
    const byId = new Map(finalMessages.map((m) => [m.id, m]));
    expect("subagentRunId" in (byId.get("snap1") as object)).toBe(false);
    expect((byId.get("snap2") as { subagentRunId?: string }).subagentRunId).toBe("s1");
    // The echo message was replaced by the snapshot merge or kept — either way
    // no message in final state carries a null tag.
    for (const m of finalMessages) {
      expect((m as { subagentRunId?: unknown }).subagentRunId).not.toBeNull();
    }
  });

  it("should copy subagentRunId from TOOL_CALL_RESULT onto the newly created tool message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_123",
      toolCallName: "doSomething",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_123",
    } as ToolCallEndEvent);
    events$.next({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tool-result-1",
      toolCallId: "call_123",
      content: '{"success":true}',
      role: "tool",
      subagentRunId: "sub-2",
    } as ToolCallResultEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "tool-result-1");

    expect(message).toBeDefined();
    expect(message?.role).toBe("tool");
    expect((message as any).subagentRunId).toBe("sub-2");
  });

  it("should not overwrite an existing message's subagentRunId (first-writer-wins)", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m2",
      role: "assistant",
      subagentRunId: "owner",
    } as TextMessageStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_456",
      toolCallName: "doSomethingElse",
      parentMessageId: "m2",
      subagentRunId: "intruder",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_456",
    } as ToolCallEndEvent);
    events$.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "m2",
    } as TextMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "m2");

    expect(message).toBeDefined();
    expect((message as any).subagentRunId).toBe("owner");
  });

  it("should set subagentRunId on TOOL_CALL_START creation and not overwrite it on a later resolve to the same message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    // No parentMessageId -> resolveOrCreateAssistantMessage creates a brand new
    // assistant message keyed by toolCallId ("call_1"), so wasCreated is true
    // and the positive `wasCreated && subagentRunId !== undefined` branch fires.
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_1",
      toolCallName: "f",
      subagentRunId: "first",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_1",
    } as ToolCallEndEvent);
    // parentMessageId now points at the message created above, so this
    // resolves to the EXISTING message (wasCreated=false) — the guard must
    // block the overwrite regardless of the `=== undefined` sub-check.
    events$.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call_2",
      toolCallName: "g",
      parentMessageId: "call_1",
      subagentRunId: "second",
    } as ToolCallStartEvent);
    events$.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call_2",
    } as ToolCallEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "call_1");

    expect(message).toBeDefined();
    expect((message as any).subagentRunId).toBe("first");
  });

  // The audit (PNI-195) lists reasoning and activity as attribution paths in
  // their own right. Both were implemented but only exercised through text and
  // tool calls, so a regression in either would have gone unnoticed.
  it("should copy subagentRunId from REASONING_MESSAGE_START onto the newly created reasoning message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "reason1",
      subagentRunId: "sub-r",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "reason1",
      delta: "thinking",
    } as ReasoningMessageContentEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_END,
      messageId: "reason1",
    } as ReasoningMessageEndEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "reason1");

    expect(message).toBeDefined();
    expect(message!.role).toBe("reasoning");
    expect((message as any).subagentRunId).toBe("sub-r");
  });

  it("should copy subagentRunId from ACTIVITY_SNAPSHOT onto the newly created activity message", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "act1",
      activityType: "search",
      content: { query: "q" },
      replace: false,
      subagentRunId: "sub-a",
    } as ActivitySnapshotEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    const message = finalUpdate?.messages?.find((m) => m.id === "act1");

    expect(message).toBeDefined();
    expect(message!.role).toBe("activity");
    expect((message as any).subagentRunId).toBe("sub-a");
  });

  it("should leave subagentRunId absent on reasoning and activity messages when the event omits it", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    events$.next({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "reason2",
    } as ReasoningMessageStartEvent);
    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "act2",
      activityType: "search",
      content: {},
    } as ActivitySnapshotEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];

    // Absent, not present-and-undefined: the field is spread in conditionally so
    // an unattributed message must not carry the key at all.
    expect(
      finalUpdate?.messages?.find((m) => m.id === "reason2"),
    ).not.toHaveProperty("subagentRunId");
    expect(finalUpdate?.messages?.find((m) => m.id === "act2")).not.toHaveProperty(
      "subagentRunId",
    );
  });

  // A REPLACING ACTIVITY_SNAPSHOT re-mints the activity, so it brings its own attribution
  // with it -- including the ABSENCE of attribution. Spreading the old message kept the
  // old owner, so a subagent's snapshot could not take over a parent activity and, in the
  // other direction, the parent could never reclaim one a subagent had taken. All four
  // directions of the branch are pinned here.
  const applySnapshots = async (...snapshots: BaseEvent[]) => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({ type: EventType.RUN_STARTED } as RunStartedEvent);
    for (const snapshot of snapshots) {
      events$.next(snapshot);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalUpdate = stateUpdates[stateUpdates.length - 1];
    return finalUpdate?.messages?.find((m) => m.id === "act");
  };

  /** The activity every case below starts from: created by, and owned by, s1. */
  const ownedByS1 = {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: "act",
    activityType: "search",
    content: { step: 1 },
    subagentRunId: "s1",
  } as BaseEvent;

  it("should re-own an activity when a replacing snapshot comes from another subagent", async () => {
    const message = await applySnapshots(ownedByS1, {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "act",
      activityType: "search",
      content: { step: 2 },
      replace: true,
      subagentRunId: "s2",
    } as BaseEvent);

    expect((message as any).subagentRunId).toBe("s2");
    expect(message!.content).toEqual({ step: 2 });
  });

  it("should DROP the attribution when an UNTAGGED replacing snapshot takes over", async () => {
    const message = await applySnapshots(ownedByS1, {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "act",
      activityType: "search",
      content: { step: 2 },
      replace: true,
    } as BaseEvent);

    // The key is deleted, not set to undefined: an unattributed message belongs to the
    // parent, and a consumer checking `"subagentRunId" in message` must see it gone.
    expect(message).toBeDefined();
    expect("subagentRunId" in (message as object)).toBe(false);
  });

  it("should treat an omitted `replace` as replacing and drop the attribution too", async () => {
    // The schema defaults replace to true, so an omitted flag must behave as `true` here
    // as well -- for a typed producer that never went through Zod.
    const message = await applySnapshots(ownedByS1, {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "act",
      activityType: "search",
      content: { step: 2 },
    } as BaseEvent);

    expect(message).toBeDefined();
    expect("subagentRunId" in (message as object)).toBe(false);
    expect(message!.content).toEqual({ step: 2 });
  });

  it("should leave the owner alone when a non-replacing snapshot arrives from another subagent", async () => {
    // replace:false leaves the existing message untouched, attribution included.
    const message = await applySnapshots(ownedByS1, {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "act",
      activityType: "search",
      content: { step: 2 },
      replace: false,
      subagentRunId: "s2",
    } as BaseEvent);

    expect((message as any).subagentRunId).toBe("s1");
    expect(message!.content).toEqual({ step: 1 });
  });
});

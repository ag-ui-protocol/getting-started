import { EventType } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
  FakeMemory,
  FakeLocalAgent,
} from "./helpers";

/**
 * Regression tests for OSS-105: the bridge must stream the assistant message
 * under the id Mastra announces on the start / step-start chunk (the id Mastra
 * persists), not a freshly minted randomUUID. Otherwise the id the client sees
 * differs from the stored id, and re-sent history on the next turn fails to
 * dedupe, duplicating the assistant message in storage.
 */
describe("assistant message id alignment", () => {
  it("adopts the start chunk's messageId for streamed text", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-msg-1" } },
        { type: "text-delta", payload: { text: "Hello" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const chunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    expect(chunk).toBeDefined();
    expect(chunk.messageId).toBe("mastra-msg-1");
  });

  it("adopts the step-start messageId and applies it to a tool call's parentMessageId", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: "mastra-msg-2" } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "call-1",
            toolName: "get_weather",
            args: { city: "NYC" },
          },
        },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const start = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;

    expect(start).toBeDefined();
    expect(start.parentMessageId).toBe("mastra-msg-2");
  });

  it("uses a new messageId per step when step-start announces a new id", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-msg-A" } },
        { type: "text-delta", payload: { text: "first" } },
        { type: "step-finish", payload: {} },
        { type: "step-start", payload: { messageId: "mastra-msg-B" } },
        { type: "text-delta", payload: { text: "second" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const ids = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e: any) => e.messageId);

    expect(ids).toContain("mastra-msg-A");
    expect(ids).toContain("mastra-msg-B");
  });

  it("falls back to a generated id when no start messageId is provided", async () => {
    // Remote/older streams may omit the start messageId. The bridge must still
    // emit a valid, stable messageId so the stream is well-formed.
    const agent = makeRemoteMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Hello" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const chunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    expect(chunk).toBeDefined();
    expect(typeof chunk.messageId).toBe("string");
    expect(chunk.messageId.length).toBeGreaterThan(0);
  });
});

/**
 * Regression tests for the message-ORDERING bug: Mastra assigns ONE messageId
 * to an entire assistant turn and re-announces it on the next step-start, so a
 * backend tool call (step 1) and the model's trailing narration (step 2) land
 * under the same id. Under one AG-UI messageId CopilotKit draws text BEFORE tool
 * calls, so the narration renders ABOVE the tool card even though it streamed
 * last. The bridge must split trailing text that lands on a tool-call id into a
 * SEPARATE, deterministic continuation message so it renders card -> result ->
 * text — while keeping that split id dedup-able across re-sent history.
 */
describe("assistant text ordering vs backend tool calls", () => {
  const TURN_ID = "mastra-turn-1";
  // Keep in sync with MastraAgent.continuationMessageId (private).
  const CONTINUATION_ID = `${TURN_ID}-agui-text`;

  it("splits trailing text onto a distinct continuation id when Mastra reuses the turn id across the tool call", async () => {
    // The exact real-world shape: one messageId re-announced on both step-starts.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: TURN_ID } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "call-1",
            toolName: "get_weather",
            args: { city: "SF" },
          },
        },
        { type: "tool-result", payload: { toolCallId: "call-1", result: { t: 20 } } },
        { type: "step-finish", payload: {} },
        // Mastra re-announces the SAME id for the trailing-text step.
        { type: "step-start", payload: { messageId: TURN_ID } },
        { type: "text-delta", payload: { text: "It is sunny." } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;
    const textChunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    // Tool call keeps the turn id; text splits to the continuation id.
    expect(toolStart.parentMessageId).toBe(TURN_ID);
    expect(textChunk.messageId).toBe(CONTINUATION_ID);
    expect(textChunk.messageId).not.toBe(toolStart.parentMessageId);

    // And it is emitted AFTER the tool call (renders below the card).
    const toolIdx = events.indexOf(toolStart);
    const textIdx = events.indexOf(textChunk);
    expect(textIdx).toBeGreaterThan(toolIdx);
  });

  it("keeps text that PRECEDES a tool call under the base id (renders above the card, correctly)", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: TURN_ID } },
        { type: "text-delta", payload: { text: "Let me check the weather." } },
        {
          type: "tool-call",
          payload: { toolCallId: "call-1", toolName: "get_weather", args: {} },
        },
        { type: "tool-result", payload: { toolCallId: "call-1", result: {} } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;
    const textChunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    // Pre-tool narration legitimately shares the tool call's message id.
    expect(textChunk.messageId).toBe(TURN_ID);
    expect(toolStart.parentMessageId).toBe(TURN_ID);
  });

  it("dedups the split continuation message from re-sent history (no duplicate text next turn)", async () => {
    // Mastra recall reports the turn stored under its base id only. On the next
    // turn CopilotKit re-sends the base assistant message AND the split
    // continuation text; both must be filtered so only the new user turn is
    // forwarded — otherwise the trailing text is re-persisted and duplicated.
    const memory = new FakeMemory();
    memory.recallMessages = [{ id: TURN_ID }];
    const fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-turn-2" } },
        { type: "text-delta", payload: { text: "ok" } },
        { type: "finish", payload: {} },
      ],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: TURN_ID, role: "assistant", content: "" } as any,
          {
            id: CONTINUATION_ID,
            role: "assistant",
            content: "It is sunny.",
          } as any,
          { id: "user-2", role: "user", content: "and tomorrow?" } as any,
        ],
      }),
    );

    const forwarded = JSON.stringify(fake.lastStreamMessages ?? []);
    // The already-stored turn and its continuation text are dropped...
    expect(forwarded).not.toContain("It is sunny.");
    // ...only the new user turn is forwarded.
    expect(forwarded).toContain("and tomorrow?");
  });
});

import { EventType } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import { continuationMessageId } from "../message-ids";
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
  const CONTINUATION_ID = continuationMessageId(TURN_ID);

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

/**
 * Regression tests for #2380: a turn that alternates text -> tool -> text ->
 * tool -> text produces MORE THAN ONE tool->text boundary. Each boundary must
 * open its OWN continuation message, otherwise every segment after the first
 * tool call reuses one id: the client appends the later deltas onto the message
 * at its original index, so segments run together and render above the tool
 * cards they were written after. The per-segment ids stay DERIVABLE from the
 * stored base id so re-sent history still dedups (see #2054).
 */
describe("assistant text segments across multiple tool calls", () => {
  const TURN_ID = "mastra-turn-multi";
  const SEGMENT_2_ID = continuationMessageId(TURN_ID);
  const SEGMENT_3_ID = continuationMessageId(TURN_ID, 2);

  const alternatingChunks = [
    { type: "step-start", payload: { messageId: TURN_ID } },
    { type: "text-delta", payload: { text: "First" } },
    { type: "text-delta", payload: { text: " line." } },
    {
      type: "tool-call",
      payload: {
        toolCallId: "call-1",
        toolName: "search_apps",
        args: { q: "a" },
      },
    },
    { type: "tool-result", payload: { toolCallId: "call-1", result: {} } },
    { type: "step-finish", payload: {} },
    { type: "step-start", payload: { messageId: TURN_ID } },
    { type: "text-delta", payload: { text: "Second" } },
    { type: "text-delta", payload: { text: " line." } },
    {
      type: "tool-call",
      payload: {
        toolCallId: "call-2",
        toolName: "search_apps",
        args: { q: "b" },
      },
    },
    { type: "tool-result", payload: { toolCallId: "call-2", result: {} } },
    { type: "step-finish", payload: {} },
    { type: "step-start", payload: { messageId: TURN_ID } },
    { type: "text-delta", payload: { text: "Third line." } },
    { type: "finish", payload: {} },
  ];

  it("gives each text segment its own message id", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: alternatingChunks });

    const events = await collectEvents(agent, makeInput());
    const textIds = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e: any) => e.messageId);

    // Three contiguous runs of text -> three distinct ids, and the deltas
    // within a run share one id.
    expect(textIds).toEqual([
      TURN_ID,
      TURN_ID,
      SEGMENT_2_ID,
      SEGMENT_2_ID,
      SEGMENT_3_ID,
    ]);
    expect(new Set(textIds).size).toBe(3);
  });

  it("emits each segment after the tool call it followed", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: alternatingChunks });

    const events = await collectEvents(agent, makeInput());
    // The interleaving as the client sees it: text, card, text, card, text.
    const timeline = events
      .filter(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_CHUNK ||
          e.type === EventType.TOOL_CALL_START,
      )
      .map((e: any) =>
        e.type === EventType.TOOL_CALL_START
          ? `tool:${e.toolCallId}`
          : `text:${e.messageId}`,
      );

    expect(timeline).toEqual([
      `text:${TURN_ID}`,
      `text:${TURN_ID}`,
      "tool:call-1",
      `text:${SEGMENT_2_ID}`,
      `text:${SEGMENT_2_ID}`,
      "tool:call-2",
      `text:${SEGMENT_3_ID}`,
    ]);
  });

  it("does not open a new segment for back-to-back tool calls with no text between", async () => {
    // Parallel/consecutive calls must not burn segment indexes — the text that
    // follows them is still the first continuation.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: TURN_ID } },
        {
          type: "tool-call",
          payload: { toolCallId: "call-1", toolName: "a", args: {} },
        },
        {
          type: "tool-call",
          payload: { toolCallId: "call-2", toolName: "b", args: {} },
        },
        { type: "tool-result", payload: { toolCallId: "call-1", result: {} } },
        { type: "tool-result", payload: { toolCallId: "call-2", result: {} } },
        { type: "step-finish", payload: {} },
        { type: "step-start", payload: { messageId: TURN_ID } },
        { type: "text-delta", payload: { text: "Done." } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const textIds = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e: any) => e.messageId);

    expect(textIds).toEqual([SEGMENT_2_ID]);
  });

  it("dedups every segment of a re-sent turn (no duplicate text next turn)", async () => {
    // #2054's contract, extended: Mastra recall reports the turn under its base
    // id only, so EVERY derived segment id must be recognised as already
    // stored. If it is not, the extra segments are re-forwarded and re-persisted
    // on each turn — the O(n^2) thread growth #2054 exists to prevent.
    const memory = new FakeMemory();
    memory.recallMessages = [{ id: TURN_ID }];
    const fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-turn-next" } },
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
          { id: TURN_ID, role: "assistant", content: "First line." } as any,
          {
            id: SEGMENT_2_ID,
            role: "assistant",
            content: "Second line.",
          } as any,
          {
            id: SEGMENT_3_ID,
            role: "assistant",
            content: "Third line.",
          } as any,
          { id: "user-2", role: "user", content: "and now?" } as any,
        ],
      }),
    );

    const forwarded = JSON.stringify(fake.lastStreamMessages ?? []);
    expect(forwarded).not.toContain("First line.");
    expect(forwarded).not.toContain("Second line.");
    expect(forwarded).not.toContain("Third line.");
    expect(forwarded).toContain("and now?");
  });

  it("does not treat an unrelated message id as a continuation of a stored turn", async () => {
    // The dedupe must key off the STORED base id, not the suffix shape alone,
    // or a genuinely new message could be swallowed.
    const memory = new FakeMemory();
    memory.recallMessages = [{ id: TURN_ID }];
    const fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-turn-next" } },
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
          { id: TURN_ID, role: "assistant", content: "stored" } as any,
          {
            id: "some-other-turn-agui-text-2",
            role: "assistant",
            content: "unrelated segment",
          } as any,
          // A genuinely new turn, so the diff is non-empty and the
          // "never send an empty turn" fallback cannot mask the filter.
          { id: "user-2", role: "user", content: "and now?" } as any,
        ],
      }),
    );

    const forwarded = JSON.stringify(fake.lastStreamMessages ?? []);
    expect(forwarded).toContain("unrelated segment");
  });
});

/**
 * The same segmentation, with output processors on.
 *
 * `useProcessedFinalText: true` buffers `text-delta` chunks and emits the processed text at a
 * finish boundary instead of as it streams. Both halves of the segmentation logic read state at
 * the moment text is emitted, so deferring that call past the tool boundary reads it too late:
 * the first segment picks up a boundary that had not opened when its text arrived, and
 * `textSinceLastToolCall` is still false when the next tool call opens, so two boundaries collapse
 * into one and later segments share an id.
 */
describe("assistant text segmentation with useProcessedFinalText", () => {
  const assistantText = (text: string) => ({
    response: {
      uiMessages: [{ role: "assistant", content: [{ type: "text", text }] }],
    },
  });

  /*
   * The shape that actually bites: Mastra re-announces the same messageId across the step
   * boundary, and the tool call lands before the buffered text is released. Both halves of the
   * segmentation logic read state when text is emitted, and buffering moves that to `step-finish`
   * — after the boundary has been counted. So the first segment picks up a boundary that had not
   * opened when its text arrived, and `textSinceLastToolCall` is still false when the next tool
   * call opens, so two boundaries collapse into one and later segments share an id.
   */
  it("gives each text segment its own id across two tool boundaries", async () => {
    const agent = makeLocalMastraAgent({
      useProcessedFinalText: true,
      streamChunks: [
        { type: "start", payload: { messageId: "base" } },
        { type: "text-delta", payload: { text: "first" } },
        {
          type: "tool-call",
          payload: { toolCallId: "call-1", toolName: "t1", args: {} },
        },
        { type: "step-finish", payload: assistantText("first") },
        { type: "step-start", payload: { messageId: "base" } },
        { type: "text-delta", payload: { text: "second" } },
        {
          type: "tool-call",
          payload: { toolCallId: "call-2", toolName: "t2", args: {} },
        },
        { type: "step-finish", payload: assistantText("second") },
        { type: "step-start", payload: { messageId: "base" } },
        { type: "text-delta", payload: { text: "third" } },
        { type: "finish", payload: assistantText("third") },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const ids = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e) => (e as any).messageId);

    // One id per segment, none reused.
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("base");
  });
});

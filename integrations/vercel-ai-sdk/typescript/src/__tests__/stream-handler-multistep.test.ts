import { describe, expect, it } from "vitest";
import {
  EventType,
  type AssistantMessage,
  type MessagesSnapshotEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
  type TextMessageContentEvent,
  type TextMessageStartEvent,
  type ToolCallStartEvent,
} from "@ag-ui/client";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import {
  collectEvents,
  eventsOfType,
  finishStop,
  finishToolCalls,
  fsFinish,
  fsFinishStep,
  fsUsage,
  makeMockModel,
  responseMetadata,
  streamStart,
  type FullStreamPart,
} from "./helpers";

const weatherTool = {
  get_weather: tool({
    description: "Get weather for a city",
    inputSchema: jsonSchema<{ city: string }>({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    }),
    execute: async ({ city }: { city: string }) => ({ city, ok: true }),
  }),
};

describe("StreamHandler — multi-step", () => {
  it("emits one STEP_STARTED and one STEP_FINISHED per step", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"Tokyo"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"Tokyo"}',
            },
            finishToolCalls(),
          ]
        : [
            streamStart,
            responseMetadata("s2"),
            { type: "text-start", id: "txt-final" },
            { type: "text-delta", id: "txt-final", delta: "All done." },
            { type: "text-end", id: "txt-final" },
            finishStop(),
          ],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const stepStarts = eventsOfType<StepStartedEvent>(events, EventType.STEP_STARTED);
    const stepEnds = eventsOfType<StepFinishedEvent>(events, EventType.STEP_FINISHED);
    expect(stepStarts).toHaveLength(2);
    expect(stepEnds).toHaveLength(2);
    expect(stepStarts.map((e) => e.stepName)).toEqual(["step-1", "step-2"]);
    expect(stepEnds.map((e) => e.stepName)).toEqual(["step-1", "step-2"]);
  });

  it("rotates assistantMessage.id between steps (each step has a distinct id)", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "text-start", id: "txt-a" },
            { type: "text-delta", id: "txt-a", delta: "Step 1." },
            { type: "text-end", id: "txt-a" },
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"Tokyo"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"Tokyo"}',
            },
            finishToolCalls(),
          ]
        : [
            streamStart,
            responseMetadata("s2"),
            { type: "text-start", id: "txt-b" },
            { type: "text-delta", id: "txt-b", delta: "Step 2." },
            { type: "text-end", id: "txt-b" },
            finishStop(),
          ],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Hi",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const assistants = snapshot.messages.filter((m) => m.role === "assistant") as AssistantMessage[];
    expect(assistants).toHaveLength(2);
    expect(assistants[0].id).not.toBe(assistants[1].id);
    expect(assistants[0].toolCalls?.length).toBeGreaterThan(0);
    expect(assistants[1].content).toContain("Step 2");

    // Step 1 streamed text "txt-a" before the tool call, so the assistant id
    // is anchored to that text id and the tool call's TOOL_CALL_START
    // parentMessageId points at it (not an orphan UUID).
    expect(assistants[0].id).toBe("txt-a");
    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as ToolCallStartEvent;
    expect(toolStart.parentMessageId).toBe("txt-a");
  });

  it("TOOL_CALL_START.parentMessageId rotates per step", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"NYC"}',
            },
            finishToolCalls(),
          ]
        : n === 2
          ? [
              streamStart,
              responseMetadata("s2"),
              { type: "tool-input-start", id: "tc-2", toolName: "get_weather" },
              { type: "tool-input-end", id: "tc-2" },
              {
                type: "tool-call",
                toolCallId: "tc-2",
                toolName: "get_weather",
                input: '{"city":"Paris"}',
              },
              finishToolCalls(),
            ]
          : [streamStart, responseMetadata("s3"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "two cities",
        tools: weatherTool,
        stopWhen: stepCountIs(3),
      }).fullStream,
    );

    const starts = eventsOfType<ToolCallStartEvent>(events, EventType.TOOL_CALL_START);
    expect(starts).toHaveLength(2);
    expect(starts[0].parentMessageId).toBeDefined();
    expect(starts[1].parentMessageId).toBeDefined();
    expect(starts[0].parentMessageId).not.toBe(starts[1].parentMessageId);
  });

  it("does NOT push a trailing empty assistant message after the last step", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "first" },
            { type: "text-end", id: "t1" },
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"Tokyo"}',
            },
            finishToolCalls(),
          ]
        : [
            streamStart,
            responseMetadata("s2"),
            { type: "text-start", id: "t2" },
            { type: "text-delta", id: "t2", delta: "second" },
            { type: "text-end", id: "t2" },
            finishStop(),
          ],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "hi",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
      { messages: [{ id: "u1", role: "user", content: "hi" }] },
    );

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    // Expected: user + step1 assistant (toolCall) + tool result + step2 assistant — no trailing empty.
    const assistants = snapshot.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    const trailing = assistants[assistants.length - 1] as AssistantMessage;
    expect(trailing.content).toBe("second");
  });

  it("interleaves text segments and tool calls across multi-step (Anthropic 'check then answer' pattern)", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "text-start", id: "intro" },
            { type: "text-delta", id: "intro", delta: "Let me check." },
            { type: "text-end", id: "intro" },
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"Tokyo"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"Tokyo"}',
            },
            finishToolCalls(),
          ]
        : [
            streamStart,
            responseMetadata("s2"),
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "It's sunny." },
            { type: "text-end", id: "answer" },
            finishStop(),
          ],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const types = events.map((e) => e.type);
    // Step 1 text comes before tool start; step 2 text comes after tool result.
    const introIdx = events.findIndex(
      (e) => e.type === EventType.TEXT_MESSAGE_START && (e as unknown as { messageId: string }).messageId === "intro",
    );
    const toolStartIdx = events.findIndex((e) => e.type === EventType.TOOL_CALL_START);
    const toolResultIdx = events.findIndex((e) => e.type === EventType.TOOL_CALL_RESULT);
    const answerIdx = events.findIndex(
      (e) => e.type === EventType.TEXT_MESSAGE_START && (e as unknown as { messageId: string }).messageId === "answer",
    );

    expect(introIdx).toBeLessThan(toolStartIdx);
    expect(toolResultIdx).toBeLessThan(answerIdx);
    expect(types).toContain(EventType.MESSAGES_SNAPSHOT);
  });
});

describe("StreamHandler — step-boundary hygiene", () => {
  it("closes an open text message at a step boundary when text-end is missing", async () => {
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "text-start", id: "t-open" };
      yield { type: "text-delta", id: "t-open", text: "cut off" };
      // Provider omitted text-end before finishing the step.
      yield fsFinishStep();
      yield fsFinish();
    }

    const events = await collectEvents(parts());
    const ends = events.filter(
      (e) =>
        e.type === EventType.TEXT_MESSAGE_END &&
        (e as unknown as { messageId: string }).messageId === "t-open",
    );
    expect(ends).toHaveLength(1);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("closes an open reasoning at a step boundary when reasoning-end is missing", async () => {
    // Reasoning part ids restart per step on providers that key them by
    // content-block index, so an unclosed reasoning would otherwise swallow
    // the next step's reasoning under the stale id.
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "reasoning-start", id: "0" };
      yield { type: "reasoning-delta", id: "0", text: "step one thinking" };
      // Provider omitted reasoning-end before finishing the step.
      yield fsFinishStep();
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "reasoning-start", id: "0" };
      yield { type: "reasoning-delta", id: "0", text: "step two thinking" };
      yield { type: "reasoning-end", id: "0" };
      yield fsFinishStep();
      yield fsFinish(fsUsage({ inputTokens: 2, outputTokens: 2, totalTokens: 4 }));
    }

    const events = await collectEvents(parts());
    const starts = events.filter((e) => e.type === EventType.REASONING_MESSAGE_START);
    expect(starts).toHaveLength(2);

    const snap = events.find(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as MessagesSnapshotEvent;
    const reasonings = snap.messages.filter((m) => m.role === "reasoning");
    expect(reasonings).toHaveLength(2);
    expect(reasonings.map((m) => (m as { content?: string }).content)).toEqual([
      "step one thinking",
      "step two thinking",
    ]);
    expect(new Set(reasonings.map((m) => m.id)).size).toBe(2);
  });

  it("does not reuse a per-step-constant text part id across steps", async () => {
    // Chat-completions-style providers restart text part ids every step
    // (a constant "0"), so step 2's id collides with step 1's snapshot message.
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "text-start", id: "0" };
      yield { type: "text-delta", id: "0", text: "step one" };
      yield { type: "text-end", id: "0" };
      yield fsFinishStep();
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "text-start", id: "0" };
      yield { type: "text-delta", id: "0", text: "step two" };
      yield { type: "text-end", id: "0" };
      yield fsFinishStep();
      yield fsFinish(fsUsage({ inputTokens: 2, outputTokens: 2, totalTokens: 4 }));
    }

    const events = await collectEvents(parts());
    const starts = eventsOfType<TextMessageStartEvent>(events, EventType.TEXT_MESSAGE_START);
    expect(starts).toHaveLength(2);
    expect(starts[0].messageId).toBe("0");
    expect(starts[1].messageId).not.toBe("0");

    const contents = eventsOfType<TextMessageContentEvent>(
      events,
      EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(contents[1].messageId).toBe(starts[1].messageId);

    const snap = events.find(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as MessagesSnapshotEvent;
    const assistants = snap.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    const ids = assistants.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
    // Streamed ids and snapshot ids stay aligned.
    expect(ids).toEqual(starts.map((s) => s.messageId));
  });
});

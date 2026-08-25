import { describe, expect, it } from "vitest";
import {
  EventType,
  type AssistantMessage,
  type MessagesSnapshotEvent,
  type ToolCallArgsEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
  type ToolMessage,
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
    execute: async ({ city }: { city: string }) => ({
      city,
      condition: "sunny",
      tempC: 22,
    }),
  }),
};

describe("StreamHandler — tool streaming", () => {
  it("emits TOOL_CALL_ARGS for each tool-input-delta (true streaming)", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("step1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":' },
            { type: "tool-input-delta", id: "tc-1", delta: '"Tokyo"' },
            { type: "tool-input-delta", id: "tc-1", delta: "}" },
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
            responseMetadata("step2"),
            { type: "text-start", id: "txt-b" },
            { type: "text-delta", id: "txt-b", delta: "It's sunny." },
            { type: "text-end", id: "txt-b" },
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

    const argsEvents = eventsOfType<ToolCallArgsEvent>(events, EventType.TOOL_CALL_ARGS);
    expect(argsEvents).toHaveLength(3);
    expect(argsEvents.map((e) => e.delta).join("")).toBe('{"city":"Tokyo"}');
    expect(argsEvents.every((e) => e.toolCallId === "tc-1")).toBe(true);
  });

  it("does NOT duplicate TOOL_CALL_START when tool-input-start preceded the tool-call", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"NYC"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"NYC"}',
            },
            finishToolCalls(),
          ]
        : [streamStart, responseMetadata("s2"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const starts = eventsOfType<ToolCallStartEvent>(events, EventType.TOOL_CALL_START);
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallId).toBe("tc-1");
    expect(starts[0].toolCallName).toBe("get_weather");
  });

  it("synthesizes TOOL_CALL_START/ARGS/END when only tool-call arrives (no streaming input)", async () => {
    const nonStreamingTool = {
      get_weather: tool({
        description: "Get weather",
        inputSchema: jsonSchema<{ city: string }>({
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        }),
        execute: async ({ city }: { city: string }) => ({ city, ok: true }),
      }),
    };

    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            // No tool-input-* parts: only the final tool-call arrives.
            {
              type: "tool-call",
              toolCallId: "tc-2",
              toolName: "get_weather",
              input: '{"city":"Paris"}',
            },
            finishToolCalls(),
          ]
        : [streamStart, responseMetadata("s2"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: nonStreamingTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const starts = eventsOfType<ToolCallStartEvent>(events, EventType.TOOL_CALL_START);
    const argsEvents = eventsOfType<ToolCallArgsEvent>(events, EventType.TOOL_CALL_ARGS);
    const endIdx = events.findIndex(
      (e) => e.type === EventType.TOOL_CALL_END && (e as unknown as { toolCallId: string }).toolCallId === "tc-2",
    );

    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallId).toBe("tc-2");
    expect(argsEvents).toHaveLength(1);
    expect(argsEvents[0].delta).toBe('{"city":"Paris"}');
    expect(endIdx).toBeGreaterThan(-1);
  });

  it("TOOL_CALL_START.parentMessageId references the current step's assistant message", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"NYC"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"NYC"}',
            },
            finishToolCalls(),
          ]
        : [streamStart, responseMetadata("s2"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const start = events.find((e) => e.type === EventType.TOOL_CALL_START) as ToolCallStartEvent;
    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const stepAssistant = snapshot.messages.find(
      (m) => m.role === "assistant" && (m as AssistantMessage).toolCalls?.length,
    ) as AssistantMessage;

    expect(start.parentMessageId).toBeDefined();
    expect(start.parentMessageId).toBe(stepAssistant.id);
  });

  it("emits TOOL_CALL_RESULT and pushes a ToolMessage on tool-result", async () => {
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
        : [streamStart, responseMetadata("s2"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc-1");
    expect(results[0].content).toContain("sunny");
    expect(results[0].role).toBe("tool");

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const toolMsg = snapshot.messages.find((m) => m.role === "tool") as ToolMessage | undefined;
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolCallId).toBe("tc-1");
    expect(toolMsg!.content).toContain("sunny");
  });

  it("appends tool calls to the current step's assistantMessage.toolCalls", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"Berlin"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"Berlin"}',
            },
            finishToolCalls(),
          ]
        : [streamStart, responseMetadata("s2"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as MessagesSnapshotEvent;
    const stepAssistant = snapshot.messages.find(
      (m) => m.role === "assistant" && (m as AssistantMessage).toolCalls?.length,
    ) as AssistantMessage;
    expect(stepAssistant.toolCalls).toHaveLength(1);
    expect(stepAssistant.toolCalls![0]).toMatchObject({
      id: "tc-1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"Berlin"}' },
    });
  });

  it("supports two tool calls in the same step (each with its own START/END/RESULT)", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"NYC"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"NYC"}',
            },
            { type: "tool-input-start", id: "tc-2", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-2", delta: '{"city":"Paris"}' },
            { type: "tool-input-end", id: "tc-2" },
            {
              type: "tool-call",
              toolCallId: "tc-2",
              toolName: "get_weather",
              input: '{"city":"Paris"}',
            },
            finishToolCalls(),
          ]
        : [streamStart, responseMetadata("s2"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Two cities",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const starts = eventsOfType<ToolCallStartEvent>(events, EventType.TOOL_CALL_START);
    expect(starts.map((e) => e.toolCallId).sort()).toEqual(["tc-1", "tc-2"]);

    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results.map((e) => e.toolCallId).sort()).toEqual(["tc-1", "tc-2"]);
  });

  it("treats tool-output-denied as a TOOL_CALL_RESULT with content 'denied' and an error field", async () => {
    // tool-output-denied isn't easy to provoke via streamText (it's a static
    // tool path). Drive the handler directly with a minimal async iterable.
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "tool-input-start", id: "tc-1", toolName: "danger" };
      yield { type: "tool-input-end", id: "tc-1" };
      yield {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "danger",
        input: {},
        dynamic: true,
      };
      yield {
        type: "tool-output-denied",
        toolCallId: "tc-1",
        toolName: "danger",
      };
      yield fsFinishStep();
      yield fsFinish();
    }

    const events = await collectEvents(parts());
    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("denied");
    expect(results[0].toolCallId).toBe("tc-1");

    // The persisted ToolMessage carries an `error` so a client can tell a real
    // denial apart from a tool that legitimately returned the string "denied".
    const snap = events.find(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as MessagesSnapshotEvent;
    const toolMsg = snap.messages.find((m) => m.role === "tool") as ToolMessage;
    expect(toolMsg.content).toBe("denied");
    expect(toolMsg.error).toBe("tool output denied");
  });

  it("emits TOOL_CALL_END derived from tool-input-end", async () => {
    const model = makeMockModel((n) =>
      n === 1
        ? [
            streamStart,
            responseMetadata("s1"),
            { type: "tool-input-start", id: "tc-1", toolName: "get_weather" },
            { type: "tool-input-delta", id: "tc-1", delta: '{"city":"NYC"}' },
            { type: "tool-input-end", id: "tc-1" },
            {
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "get_weather",
              input: '{"city":"NYC"}',
            },
            finishToolCalls(),
          ]
        : [streamStart, responseMetadata("s2"), finishStop()],
    );

    const events = await collectEvents(
      streamText({
        model,
        prompt: "Weather?",
        tools: weatherTool,
        stopWhen: stepCountIs(2),
      }).fullStream,
    );

    const ends = events.filter(
      (e) => e.type === EventType.TOOL_CALL_END && (e as unknown as { toolCallId: string }).toolCallId === "tc-1",
    );
    expect(ends).toHaveLength(1);
  });
});

describe("StreamHandler — client-side tool calls stay pending", () => {
  it("does not synthesize a result for a tool defined in input.tools", async () => {
    // Frontend tools are converted without an execute function, so the stream
    // legitimately ends without a tool-result: the AG-UI client executes the
    // call and supplies the result on the next run.
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "tool-input-start", id: "tc-fe", toolName: "change_background" };
      yield { type: "tool-input-delta", id: "tc-fe", delta: '{"color":"blue"}' };
      yield { type: "tool-input-end", id: "tc-fe" };
      yield {
        type: "tool-call",
        toolCallId: "tc-fe",
        toolName: "change_background",
        input: { color: "blue" },
      };
      yield fsFinishStep("tool-calls");
      yield fsFinish(fsUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }), "tool-calls");
    }

    const events = await collectEvents(parts(), {
      tools: [
        {
          name: "change_background",
          description: "Change the page background",
          parameters: { type: "object", properties: { color: { type: "string" } } },
        },
      ],
    });

    expect(eventsOfType(events, EventType.TOOL_CALL_RESULT)).toHaveLength(0);
    const snap = events.find(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as MessagesSnapshotEvent;
    expect(snap.messages.some((m) => m.role === "tool")).toBe(false);
    const assistant = snap.messages.find((m) => m.role === "assistant") as AssistantMessage;
    expect(assistant.toolCalls?.map((tc) => tc.id)).toEqual(["tc-fe"]);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("still synthesizes a result for a tool NOT defined in input.tools", async () => {
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "tool-call", toolCallId: "tc-srv", toolName: "server_only", input: {} };
      yield fsFinish(fsUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }), "tool-calls");
    }

    const events = await collectEvents(parts(), {
      tools: [
        {
          name: "change_background",
          description: "Change the page background",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const results = eventsOfType<ToolCallResultEvent>(events, EventType.TOOL_CALL_RESULT);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("tc-srv");
  });
});

describe("StreamHandler — unterminated tool input", () => {
  it("emits TOOL_CALL_END in the cleanup phase for a tool input left open at stream end", async () => {
    // e.g. @ai-sdk/openai chat-completions: generation truncated by max
    // tokens mid-arguments emits tool-input-start but never tool-input-end.
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      yield { type: "tool-input-start", id: "tc-trunc", toolName: "get_weather" };
      yield { type: "tool-input-delta", id: "tc-trunc", delta: '{"city":"To' };
      yield fsFinish(fsUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }), "length");
    }

    const events = await collectEvents(parts());
    const types = events.map((e) => e.type);
    const endIdx = events.findIndex(
      (e) =>
        e.type === EventType.TOOL_CALL_END &&
        (e as unknown as { toolCallId: string }).toolCallId === "tc-trunc",
    );
    expect(endIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeLessThan(types.indexOf(EventType.RUN_FINISHED));
  });
});

describe("StreamHandler — tool argument serialization", () => {
  it("serializes a string tool-call input as valid JSON arguments", async () => {
    async function* parts(): AsyncIterable<FullStreamPart> {
      yield { type: "start" };
      yield { type: "start-step", request: {}, warnings: [] };
      // Bare tool-call whose parsed input is a JSON string, with no streamed
      // input parts (so ARGS is synthesized from the input value).
      yield { type: "tool-call", toolCallId: "tc-str", toolName: "echo", input: "Tokyo" };
      yield fsFinishStep("tool-calls");
      yield fsFinish(fsUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }), "tool-calls");
    }

    const events = await collectEvents(parts());
    const args = eventsOfType<ToolCallArgsEvent>(events, EventType.TOOL_CALL_ARGS);
    expect(args).toHaveLength(1);
    expect(args[0].delta).toBe('"Tokyo"');
    expect(JSON.parse(args[0].delta)).toBe("Tokyo");

    const snap = events.find(
      (e) => e.type === EventType.MESSAGES_SNAPSHOT,
    ) as MessagesSnapshotEvent;
    const assistant = snap.messages.find((m) => m.role === "assistant") as AssistantMessage;
    expect(assistant.toolCalls?.[0].function.arguments).toBe('"Tokyo"');
  });
});

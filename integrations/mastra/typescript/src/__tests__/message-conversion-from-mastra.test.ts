import type { MastraDBMessage, MastraMessagePart } from "@mastra/core/agent";
import type { AssistantMessage, ToolMessage } from "@ag-ui/client";
import { convertMastraMessagesToAGUI, convertAGUIMessagesToMastra } from "../utils";
import { continuationMessageId, toolResultMessageId } from "../message-ids";

/**
 * `convertMastraMessagesToAGUI` is the inverse of `convertAGUIMessagesToMastra`:
 * it turns the messages Mastra Memory hands back (`memory.recall()` on a local
 * agent, `getMemoryThread().listMessages()` against a server — both
 * `MastraDBMessage[]`) into AG-UI messages, so a thread Mastra already owns can
 * be rehydrated after a reload.
 */

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

function storedMessage(
  id: string,
  role: MastraDBMessage["role"],
  parts: MastraMessagePart[],
  content: Partial<MastraDBMessage["content"]> = {},
): MastraDBMessage {
  return {
    id,
    role,
    createdAt: CREATED_AT,
    threadId: "thread-1",
    content: { format: 2, parts, ...content },
  };
}

function toolInvocationPart(
  overrides: Partial<{
    state: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: unknown;
    errorText: string;
  }> = {},
): MastraMessagePart {
  return {
    type: "tool-invocation",
    toolInvocation: {
      state: "result",
      step: 0,
      toolCallId: "call_1",
      toolName: "getWeather",
      args: { city: "Paris" },
      result: { tempC: 19 },
      ...overrides,
    },
  } as MastraMessagePart;
}

describe("convertMastraMessagesToAGUI", () => {
  it("converts a plain user turn to a string-content user message", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("u1", "user", [{ type: "text", text: "weather in Paris?" }]),
    ]);

    expect(result).toEqual([
      { id: "u1", role: "user", content: "weather in Paris?" },
    ]);
  });

  it("converts a plain assistant turn", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        { type: "step-start" },
        { type: "text", text: "It is sunny." },
      ]),
    ]);

    expect(result).toEqual([
      { id: "a1", role: "assistant", content: "It is sunny." },
    ]);
  });

  it("splits a text -> tool -> text turn into assistant / tool / assistant", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        { type: "step-start" },
        { type: "text", text: "Let me check." },
        toolInvocationPart(),
        { type: "text", text: "It is 19C in Paris." },
      ]),
    ]);

    expect(result).toHaveLength(3);

    const [assistant, tool, continuation] = result as [
      AssistantMessage,
      ToolMessage,
      AssistantMessage,
    ];

    expect(assistant).toEqual({
      id: "a1",
      role: "assistant",
      content: "Let me check.",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "getWeather", arguments: '{"city":"Paris"}' },
        },
      ],
    });
    expect(tool).toEqual({
      id: toolResultMessageId("call_1"),
      role: "tool",
      toolCallId: "call_1",
      content: '{"tempC":19}',
    });
    // The trailing text must NOT ride on the base id, or the client renders it
    // above the tool card it was written after.
    expect(continuation).toEqual({
      id: continuationMessageId("a1"),
      role: "assistant",
      content: "It is 19C in Paris.",
    });
  });

  it("gives each text run after a tool call its own continuation index", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        { type: "text", text: "first" },
        toolInvocationPart({ toolCallId: "call_1" }),
        { type: "text", text: "second" },
        toolInvocationPart({ toolCallId: "call_2" }),
        { type: "text", text: "third" },
      ]),
    ]);

    expect(result.map((m) => m.id)).toEqual([
      "a1",
      toolResultMessageId("call_1"),
      continuationMessageId("a1"),
      toolResultMessageId("call_2"),
      continuationMessageId("a1", 2),
    ]);
  });

  it("keeps parallel tool calls on one assistant message and emits both results", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        { type: "text", text: "checking both" },
        toolInvocationPart({ toolCallId: "call_1", toolName: "getWeather" }),
        toolInvocationPart({ toolCallId: "call_2", toolName: "getTime" }),
      ]),
    ]);

    const [assistant, ...tools] = result;
    expect((assistant as AssistantMessage).toolCalls?.map((c) => c.id)).toEqual([
      "call_1",
      "call_2",
    ]);
    expect(tools.map((m) => (m as ToolMessage).toolCallId)).toEqual([
      "call_1",
      "call_2",
    ]);
  });

  it("emits a tool-call with no tool message while the call is unsettled", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        toolInvocationPart({ state: "call", result: undefined }),
      ]),
    ]);

    expect(result).toHaveLength(1);
    expect((result[0] as AssistantMessage).toolCalls).toHaveLength(1);
  });

  it("carries a failed tool call onto the AG-UI error field", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        toolInvocationPart({
          state: "output-error",
          result: undefined,
          errorText: "upstream 500",
        }),
      ]),
    ]);

    const tool = result.find((m) => m.role === "tool") as ToolMessage;
    expect(tool.error).toBe("upstream 500");
  });

  it("labels a denied tool call instead of reporting it as a success", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        toolInvocationPart({ state: "output-denied", result: undefined }),
      ]),
    ]);

    const tool = result.find((m) => m.role === "tool") as ToolMessage;
    expect(tool.error).toBe("tool call denied");
  });

  it("passes a string tool result through unstringified", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        toolInvocationPart({ result: "19C and sunny" }),
      ]),
    ]);

    const tool = result.find((m) => m.role === "tool") as ToolMessage;
    expect(tool.content).toBe("19C and sunny");
  });

  it("converts a user file part to AG-UI input content", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("u1", "user", [
        { type: "text", text: "what is this?" },
        { type: "file", mimeType: "image/png", data: "aGk=" },
      ]),
    ]);

    expect(result[0]!.content).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "image",
        source: { type: "data", mimeType: "image/png", value: "aGk=" },
      },
    ]);
  });

  it("emits reasoning as its own message before the text it produced", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        { type: "reasoning", reasoning: "thinking hard", details: [] },
        { type: "text", text: "the answer" },
      ]),
    ]);

    expect(result.map((m) => m.role)).toEqual(["reasoning", "assistant"]);
    expect(result[0]!.content).toBe("thinking hard");
    expect(result[0]!.id).toBe("a1-reasoning-1");
    // Reasoning must not consume a continuation index: the assistant text keeps
    // the stored turn id so it still dedups against Mastra storage.
    expect(result[1]!.id).toBe("a1");
  });

  it("keeps one assistant message when reasoning interleaves with text", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        { type: "text", text: "part one " },
        { type: "reasoning", reasoning: "second thoughts", details: [] },
        { type: "text", text: "part two" },
      ]),
    ]);

    // Reasoning leads the segment, and the surrounding text stays ONE assistant
    // message: emitting it inline would either reorder the text or split it
    // across two messages sharing the stored turn id.
    expect(result).toEqual([
      { id: "a1-reasoning-1", role: "reasoning", content: "second thoughts" },
      { id: "a1", role: "assistant", content: "part one part two" },
    ]);
    expect(new Set(result.map((m) => m.id)).size).toBe(result.length);
  });

  it("keeps reasoning that follows a tool call below that call's result", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("a1", "assistant", [
        { type: "text", text: "checking" },
        toolInvocationPart(),
        { type: "reasoning", reasoning: "the result means X", details: [] },
        { type: "text", text: "it is 19C" },
      ]),
    ]);

    // The reasoning was written after the call, so it must not be hoisted above
    // the assistant message that made the call.
    expect(result.map((m) => [m.role, m.id])).toEqual([
      ["assistant", "a1"],
      ["tool", toolResultMessageId("call_1")],
      ["reasoning", "a1-reasoning-1"],
      ["assistant", continuationMessageId("a1")],
    ]);
  });

  it("drops parts with no AG-UI equivalent and skips signal messages", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("s1", "signal", [{ type: "text", text: "internal" }]),
      storedMessage("a1", "assistant", [
        { type: "step-start" },
        {
          type: "source",
          source: { sourceType: "url", id: "s", url: "https://example.com" },
        } as MastraMessagePart,
        { type: "text", text: "answer" },
      ]),
    ]);

    expect(result).toEqual([{ id: "a1", role: "assistant", content: "answer" }]);
  });

  it("skips empty messages instead of emitting blank bubbles", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("u1", "user", []),
      storedMessage("a1", "assistant", [{ type: "step-start" }]),
    ]);

    expect(result).toEqual([]);
  });

  it("converts a system message, falling back to legacy string content", () => {
    const result = convertMastraMessagesToAGUI([
      storedMessage("sys1", "system", [], { content: "be terse" }),
    ]);

    expect(result).toEqual([
      { id: "sys1", role: "system", content: "be terse" },
    ]);
  });

  it("preserves stored ids through a Mastra -> AG-UI -> Mastra round trip", () => {
    const stored = [
      storedMessage("u1", "user", [{ type: "text", text: "hi" }]),
      storedMessage("a1", "assistant", [
        { type: "text", text: "one moment" },
        toolInvocationPart(),
        { type: "text", text: "done" },
      ]),
    ];

    const agui = convertMastraMessagesToAGUI(stored);
    const backToMastra = convertAGUIMessagesToMastra(agui);

    // Every id Mastra actually stored survives the round trip, so re-sending
    // restored history upserts by id rather than creating new rows.
    expect(backToMastra.map((m) => m.id)).toEqual([
      "u1",
      "a1",
      toolResultMessageId("call_1"),
      continuationMessageId("a1"),
    ]);
    // And the tool result resolves back to its original tool name.
    expect(backToMastra[2]!.content).toEqual([
      expect.objectContaining({ toolName: "getWeather", toolCallId: "call_1" }),
    ]);
  });

  it("returns an empty list for an empty thread", () => {
    expect(convertMastraMessagesToAGUI([])).toEqual([]);
  });
});

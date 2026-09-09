import { EventType } from "@ag-ui/core";
import { createEvent } from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKJSProtocolError } from "../index";
import { ADKEventTranslator } from "../event-translator";
import { textEvent } from "./helpers";

describe("ADKEventTranslator", () => {
  it("streams text once when ADK repeats the aggregate final response", () => {
    const translator = new ADKEventTranslator({ count: 0 });
    const events = [
      ...translator.translate(
        textEvent({ id: "p1", text: "Hel", partial: true }),
      ),
      ...translator.translate(
        textEvent({ id: "p2", text: "lo", partial: true }),
      ),
      ...translator.translate(textEvent({ id: "final", text: "Hello" })),
    ];

    expect(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta),
    ).toEqual(["Hel", "lo"]);
    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
  });

  it("translates each ADK part kind to its AG-UI event", () => {
    const translator = new ADKEventTranslator({ count: 0 });
    const thought = textEvent({ id: "thought", text: "check", thought: true });
    thought.content!.parts![0].thoughtSignature = "opaque-signature";
    const state = createEvent({
      id: "state",
      author: "scripted_agent",
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
        thoughtsTokenCount: 1,
        cachedContentTokenCount: 1,
      },
    });
    state.actions.stateDelta = {
      count: 1,
      "a/b": true,
      _ag_ui_context: [],
      "app:shared": "private",
      "user:profile": "private",
      "temp:working": "private",
    };
    const tool = createEvent({
      id: "tool",
      author: "scripted_agent",
      content: {
        role: "model",
        parts: [
          { functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } },
          { executableCode: { language: "PYTHON" as never, code: "print(1)" } },
        ],
      },
    });

    const events = [
      ...translator.translate(thought),
      ...translator.translate(state),
      ...translator.translate(tool),
      ...translator.finish().events,
    ];

    expect(events.map((event) => event.type)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_ENCRYPTED_VALUE,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.STATE_DELTA,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RAW,
    ]);
    const delta = events.find((event) => event.type === EventType.STATE_DELTA);
    expect(delta?.delta).toEqual([
      { op: "replace", path: "/count", value: 1 },
      { op: "add", path: "/a~1b", value: true },
    ]);
    expect(translator.getState()).toEqual({ count: 1, "a/b": true });
    expect(translator.getUsage()).toEqual([
      {
        provider: "google",
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        reasoningTokens: 1,
        cachedInputTokens: 1,
      },
    ]);
  });

  it("waits for the complete call during progressive function-call streaming", () => {
    const translator = new ADKEventTranslator({});
    const partialText = textEvent({
      id: "partial-text",
      text: "Working",
      partial: true,
    });
    const partialCall = createEvent({
      id: "partial-call",
      author: "scripted_agent",
      partial: true,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "call-1",
              name: "lookup",
              args: { partial: "fragment" },
            },
          },
        ],
      },
    });
    const final = createEvent({
      id: "final-call",
      author: "scripted_agent",
      content: {
        role: "model",
        parts: [
          { text: "Working" },
          {
            functionCall: {
              id: "call-1",
              name: "lookup",
              args: { complete: true },
            },
          },
        ],
      },
    });

    const events = [
      ...translator.translate(partialText),
      ...translator.translate(partialCall),
      ...translator.translate(final),
    ];

    expect(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta),
    ).toEqual(["Working"]);
    expect(
      events
        .filter((event) => event.type === EventType.TOOL_CALL_ARGS)
        .map((event) => event.delta),
    ).toEqual(['{"complete":true}']);
  });

  it("raises an ADKJSProtocolError for an ADK error event", () => {
    const translator = new ADKEventTranslator({});
    expect(() =>
      translator.translate(
        createEvent({ errorCode: "MODEL_ERROR", errorMessage: "model failed" }),
      ),
    ).toThrow(ADKJSProtocolError);
  });
});

function branchTextEvent(params: {
  id: string;
  text: string;
  author: string;
  branch: string;
  partial?: boolean;
  thought?: boolean;
}) {
  return createEvent({
    id: params.id,
    author: params.author,
    branch: params.branch,
    partial: params.partial,
    content: {
      role: "model",
      parts: [{ text: params.text, thought: params.thought }],
    },
  });
}

describe("ADKEventTranslator raw events", () => {
  it("attaches rawEvent and emits RAW projections only when asked to", () => {
    const event = createEvent({
      id: "raw-1",
      invocationId: "inv",
      author: "scripted_agent",
      content: { role: "model", parts: [{ text: "hello" }] },
    });
    const quiet = new ADKEventTranslator({}).translate(event);
    expect(quiet.some((e) => e.type === EventType.RAW)).toBe(false);
    expect(quiet.some((e) => "rawEvent" in e)).toBe(false);
    const raw = new ADKEventTranslator({}, true).translate(event);
    expect(raw.filter((e) => e.type === EventType.RAW)).toHaveLength(1);
    expect(
      raw.find((e) => e.type === EventType.TEXT_MESSAGE_START),
    ).toHaveProperty("rawEvent");
    expect(raw.at(-1)).toMatchObject({
      type: EventType.RAW,
      source: "google-adk",
    });
  });
});

describe("ADKEventTranslator parallel branches", () => {
  it("keeps interleaved parallel-branch text in per-author messages", () => {
    const translator = new ADKEventTranslator({});
    const events = [
      ...translator.translate(
        branchTextEvent({
          id: "a1",
          text: "Alpha ",
          author: "agent_a",
          branch: "root.a",
          partial: true,
        }),
      ),
      ...translator.translate(
        branchTextEvent({
          id: "b1",
          text: "Beta ",
          author: "agent_b",
          branch: "root.b",
          partial: true,
        }),
      ),
      ...translator.translate(
        branchTextEvent({
          id: "a2",
          text: "one",
          author: "agent_a",
          branch: "root.a",
          partial: true,
        }),
      ),
      ...translator.translate(
        branchTextEvent({
          id: "b2",
          text: "two",
          author: "agent_b",
          branch: "root.b",
          partial: true,
        }),
      ),
      ...translator.translate(
        branchTextEvent({
          id: "a-final",
          text: "Alpha one",
          author: "agent_a",
          branch: "root.a",
        }),
      ),
      ...translator.translate(
        branchTextEvent({
          id: "b-final",
          text: "Beta two",
          author: "agent_b",
          branch: "root.b",
        }),
      ),
    ];

    const starts = events.filter(
      (event) => event.type === EventType.TEXT_MESSAGE_START,
    );
    expect(starts).toHaveLength(2);
    expect(starts.map((event) => [event.messageId, event.name])).toEqual([
      ["a1", "agent_a"],
      ["b1", "agent_b"],
    ]);

    const contentByMessage = new Map<string, string[]>();
    for (const event of events) {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        const deltas = contentByMessage.get(event.messageId) ?? [];
        deltas.push(event.delta);
        contentByMessage.set(event.messageId, deltas);
      }
    }
    expect(contentByMessage.get("a1")).toEqual(["Alpha ", "one"]);
    expect(contentByMessage.get("b1")).toEqual(["Beta ", "two"]);

    const ends = events.filter(
      (event) => event.type === EventType.TEXT_MESSAGE_END,
    );
    expect(ends.map((event) => event.messageId)).toEqual(["a1", "b1"]);
  });

  it("keeps a streaming message open across another branch's tool call", () => {
    const translator = new ADKEventTranslator({});
    const toolEvent = createEvent({
      id: "b-tool",
      author: "agent_b",
      branch: "root.b",
      content: {
        role: "model",
        parts: [
          { functionCall: { id: "call-b", name: "lookup", args: { q: "x" } } },
        ],
      },
    });
    const events = [
      ...translator.translate(
        branchTextEvent({
          id: "a1",
          text: "Working",
          author: "agent_a",
          branch: "root.a",
          partial: true,
        }),
      ),
      ...translator.translate(toolEvent),
      ...translator.translate(
        branchTextEvent({
          id: "a2",
          text: " on it",
          author: "agent_a",
          branch: "root.a",
          partial: true,
        }),
      ),
      ...translator.translate(
        branchTextEvent({
          id: "a-final",
          text: "Working on it",
          author: "agent_a",
          branch: "root.a",
        }),
      ),
    ];

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    // agent_a's message survives agent_b's tool call untouched: one START,
    // both content deltas, one END.
    const aEvents = events.filter(
      (event) => "messageId" in event && event.messageId === "a1",
    );
    expect(aEvents.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    const toolStart = events.find(
      (event) => event.type === EventType.TOOL_CALL_START,
    );
    expect(toolStart).toMatchObject({
      toolCallId: "call-b",
      parentMessageId: "b-tool",
    });
  });

  it("keeps interleaved reasoning per branch", () => {
    const translator = new ADKEventTranslator({});
    const events = [
      ...translator.translate(
        branchTextEvent({
          id: "a1",
          text: "consider",
          author: "agent_a",
          branch: "root.a",
          partial: true,
          thought: true,
        }),
      ),
      ...translator.translate(
        branchTextEvent({
          id: "b1",
          text: "Hi",
          author: "agent_b",
          branch: "root.b",
          partial: true,
        }),
      ),
      ...translator.translate(
        branchTextEvent({
          id: "a2",
          text: " options",
          author: "agent_a",
          branch: "root.a",
          partial: true,
          thought: true,
        }),
      ),
      ...translator.finish().events,
    ];

    // agent_b's plain text must not close agent_a's reasoning stream.
    const reasoningContent = events.filter(
      (event) => event.type === EventType.REASONING_MESSAGE_CONTENT,
    );
    expect(
      reasoningContent.map((event) => [event.messageId, event.delta]),
    ).toEqual([
      ["a1:reasoning", "consider"],
      ["a1:reasoning", " options"],
    ]);
    expect(
      events.filter((event) => event.type === EventType.REASONING_START),
    ).toHaveLength(1);
    // finish() closes every stream that is still open.
    expect(
      events.filter((event) => event.type === EventType.TEXT_MESSAGE_END),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === EventType.REASONING_END),
    ).toHaveLength(1);
  });
});

describe("ADKEventTranslator usage accounting", () => {
  const usageMetadata = {
    promptTokenCount: 3,
    candidatesTokenCount: 2,
    totalTokenCount: 5,
  };

  it("counts equal-token turns from consecutive loop iterations", () => {
    const translator = new ADKEventTranslator({});
    translator.translate(
      createEvent({
        id: "loop-1",
        author: "looper",
        invocationId: "inv-1",
        usageMetadata,
        finishReason: "STOP" as never,
        content: { role: "model", parts: [{ text: "Iteration one" }] },
      }),
    );
    translator.translate(
      createEvent({
        id: "loop-2",
        author: "looper",
        invocationId: "inv-1",
        usageMetadata,
        finishReason: "STOP" as never,
        content: { role: "model", parts: [{ text: "Iteration two" }] },
      }),
    );

    expect(translator.getUsage()).toEqual([
      {
        provider: "google",
        inputTokens: 6,
        outputTokens: 4,
        totalTokens: 10,
      },
    ]);
  });

  it("still dedupes the split text/function-call copies of one model turn", () => {
    const translator = new ADKEventTranslator({});
    // ADK's non-progressive aggregation yields the accumulated text and the
    // function-call remainder as two events carrying the same usage; only the
    // trailing copy is turn-terminal.
    translator.translate(
      createEvent({
        id: "turn-text",
        author: "agent",
        invocationId: "inv-1",
        usageMetadata,
        content: { role: "model", parts: [{ text: "Answer" }] },
      }),
    );
    translator.translate(
      createEvent({
        id: "turn-call",
        author: "agent",
        invocationId: "inv-1",
        usageMetadata,
        finishReason: "STOP" as never,
        content: {
          role: "model",
          parts: [{ functionCall: { id: "call-1", name: "lookup", args: {} } }],
        },
      }),
    );

    expect(translator.getUsage()).toEqual([
      {
        provider: "google",
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      },
    ]);
  });

  it("dedupes per branch so interleaved parallel turns each count once", () => {
    const translator = new ADKEventTranslator({});
    const turn = (id: string, author: string, branch: string, last: boolean) =>
      createEvent({
        id,
        author,
        branch,
        invocationId: "inv-1",
        usageMetadata,
        ...(last ? { finishReason: "STOP" as never } : {}),
        content: { role: "model", parts: [{ text: `${id} text` }] },
      });
    translator.translate(turn("a-copy1", "agent_a", "root.a", false));
    translator.translate(turn("b-copy1", "agent_b", "root.b", false));
    translator.translate(turn("a-copy2", "agent_a", "root.a", true));
    translator.translate(turn("b-copy2", "agent_b", "root.b", true));

    // Each branch reported the same usage twice (split copies); interleaving
    // must neither double-count a branch nor let branches clobber each other.
    expect(translator.getUsage()).toEqual([
      {
        provider: "google",
        inputTokens: 6,
        outputTokens: 4,
        totalTokens: 10,
      },
    ]);
  });
});

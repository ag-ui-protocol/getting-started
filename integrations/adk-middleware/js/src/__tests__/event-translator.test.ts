import { EventType } from "@ag-ui/core";
import { createEvent } from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKEventError, ADKEventTranslator } from "../index";
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

  it("maps reasoning, state, usage, tools, and raw parts", () => {
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
      ...translator.finish(),
    ];

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_ENCRYPTED_VALUE,
        EventType.STATE_DELTA,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.RAW,
      ]),
    );
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

  it("raises an ADKEventError for an ADK error event", () => {
    const translator = new ADKEventTranslator({});
    expect(() =>
      translator.translate(
        createEvent({ errorCode: "MODEL_ERROR", errorMessage: "model failed" }),
      ),
    ).toThrow(ADKEventError);
  });
});

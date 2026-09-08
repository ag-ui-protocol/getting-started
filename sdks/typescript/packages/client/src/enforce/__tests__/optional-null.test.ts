import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import { decode } from "@ag-ui/proto";
import { enforceOutgoingInput } from "../enforce";

describe("optional null at producer boundaries", () => {
  const input: RunAgentInput = {
    threadId: "t",
    runId: "r",
    messages: [],
    tools: [],
    context: [],
    state: null,
    forwardedProps: null,
    resume: [
      { interruptId: "i", status: "resolved", payload: null, metadata: { preserved: null } },
    ],
  };

  it("omits outgoing optional null fields without mutating input", () => {
    const original = structuredClone(input);
    expect(enforceOutgoingInput(input)).toEqual({
      threadId: "t",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      resume: [{ interruptId: "i", status: "resolved", metadata: { preserved: null } }],
    });
    expect(input).toEqual(original);
  });

  it.each(["sse", "protobuf"])("%s omits optional nulls in nested protocol objects", (encoding) => {
    const event: BaseEvent = {
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "r",
      rawEvent: null,
      input: {
        ...input,
        messages: [{ id: "m", role: "assistant", content: null, name: null }],
        tools: [{ name: "tool", description: "Tool description", parameters: null }],
      },
      metadata: { preserved: null },
    };
    const original = structuredClone(event);
    const encoder = new EventEncoder();
    const result =
      encoding === "sse"
        ? JSON.parse(encoder.encodeSSE(event).slice(6))
        : decode(encoder.encodeProtobuf(event).slice(4));
    expect(result).toEqual({
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "r",
      input: {
        threadId: "t",
        runId: "r",
        messages: [{ id: "m", role: "assistant" }],
        tools: [{ name: "tool", description: "Tool description" }],
        context: [],
        resume: [{ interruptId: "i", status: "resolved", metadata: { preserved: null } }],
      },
      metadata: { preserved: null },
    });
    expect(event).toEqual(original);
    expect(EventSchemas.safeParse(result).success).toBe(true);
  });

  it.each(["sse", "protobuf"])("%s preserves required and nested null data", (encoding) => {
    const encoder = new EventEncoder();
    for (const event of [
      { type: EventType.CUSTOM, name: "x", value: null },
      { type: EventType.STATE_SNAPSHOT, snapshot: null },
      { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/x", value: null }] },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", result: { nested: null } },
    ]) {
      const result =
        encoding === "sse"
          ? JSON.parse(encoder.encodeSSE(event).slice(6))
          : decode(encoder.encodeProtobuf(event).slice(4));
      expect(result).toEqual(event);
    }
  });
});

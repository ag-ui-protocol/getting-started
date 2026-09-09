import { EventType, type AGUIEvent, type RunAgentInput } from "@ag-ui/core";
import {
  Agent,
  BaseTool,
  InMemorySessionService,
  Runner,
  requestInputTool,
  type AppendEventRequest,
  type Event as AdkEvent,
  type RunAsyncToolRequest,
} from "@google/adk";
import { describe, expect, it } from "vitest";

import { ADKJSAgent } from "../agent";
import { ADK_METADATA_KEY } from "../constants";
import { MessageSnapshot } from "../message-snapshot";
import { DeterministicLlm, collect, runInput, verified } from "./helpers";

/** The user says "Begin" so the assertions can count the model's "Hello". */
function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return runInput({
    messages: [{ id: "user-1", role: "user", content: "Begin" }],
    ...overrides,
  });
}

function checkpoint(
  initial: RunAgentInput["messages"],
  events: readonly AGUIEvent[],
): RunAgentInput["messages"] {
  const snapshot = new MessageSnapshot(initial);
  for (const event of events) {
    snapshot.apply(event);
  }
  return snapshot.getMessages();
}

describe("streaming session identity", () => {
  it("keeps a streamed sentence and the tool call that follows it in one assistant message", async () => {
    class AddTool extends BaseTool {
      constructor() {
        super({ name: "add", description: "Add two numbers." });
      }

      override _getDeclaration() {
        return {
          name: this.name,
          description: this.description,
          parametersJsonSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        };
      }

      override async runAsync({ args }: RunAsyncToolRequest): Promise<unknown> {
        const { a, b } = args as { a: number; b: number };
        return { sum: a + b };
      }
    }
    // Gemini streams the sentence in chunks and then sends one aggregate
    // event, under a new id, that carries the sentence and the call together.
    const model = new DeterministicLlm([
      [
        {
          partial: true,
          content: { role: "model", parts: [{ text: "Let me " }] },
        },
        {
          partial: true,
          content: { role: "model", parts: [{ text: "add." }] },
        },
        {
          content: {
            role: "model",
            parts: [
              { text: "Let me add." },
              {
                functionCall: {
                  id: "call-1",
                  name: "add",
                  args: { a: 1, b: 2 },
                },
              },
            ],
          },
        },
      ],
      [{ content: { role: "model", parts: [{ text: "Three." }] } }],
    ]);
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({
          name: "streaming_agent",
          model,
          tools: [new AddTool()],
        }),
      }),
      userId: "user-1",
    });

    const firstInput = input();
    const events = await collect(bridge, firstInput);
    const starts = events.filter(
      (event) => event.type === EventType.TEXT_MESSAGE_START,
    ) as Array<{ messageId: string }>;
    expect(starts).toHaveLength(2);
    expect(
      events.find((event) => event.type === EventType.TOOL_CALL_START),
    ).toMatchObject({ parentMessageId: starts[0]?.messageId });
    expect(
      checkpoint(firstInput.messages, events).filter(
        (message) => message.role === "assistant",
      ),
    ).toMatchObject([
      { content: "Let me add.", toolCalls: [{ id: "call-1" }] },
      { content: "Three." },
    ]);
    await verified(events);
  });

  it("does not restore a streamed assistant checkpoint into ADK twice", async () => {
    const model = new DeterministicLlm([
      [
        {
          partial: true,
          content: { role: "model", parts: [{ text: "Hel" }] },
        },
        {
          partial: true,
          content: { role: "model", parts: [{ text: "lo" }] },
        },
        {
          content: { role: "model", parts: [{ text: "Hello" }] },
        },
      ],
      [{ content: { role: "model", parts: [{ text: "Next" }] } }],
    ]);
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({ name: "streaming_agent", model }),
      }),
      userId: "user-1",
    });
    const firstInput = input();
    const first = await collect(bridge.clone(), firstInput);
    const messages = checkpoint(firstInput.messages, first);

    const second = await collect(
      bridge.clone(),
      input({
        runId: "run-2",
        messages: [
          ...messages,
          { id: "user-2", role: "user", content: "Continue" },
        ],
      }),
    );

    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    const secondRequest = JSON.stringify(model.requests[1]?.contents);
    expect(secondRequest.match(/Hello/g)).toHaveLength(1);
  });

  it("reconciles streamed message ids when the run marker was lost to a crash", async () => {
    // Drops the post-run emitted-message-ids marker, reproducing the persisted
    // state left behind when the process crashes (or the client disconnects)
    // after ADK persisted the final model event but before the coordinator
    // could append the reconciliation marker.
    class MarkerLosingSessionService extends InMemorySessionService {
      loseMarkers = false;

      override async appendEvent({
        session,
        event,
      }: AppendEventRequest): Promise<AdkEvent> {
        if (this.loseMarkers && event.invocationId.startsWith("ag-ui-run-")) {
          return event;
        }
        return super.appendEvent({ session, event });
      }
    }

    const model = new DeterministicLlm([
      [
        {
          partial: true,
          content: { role: "model", parts: [{ text: "Hel" }] },
        },
        {
          partial: true,
          content: { role: "model", parts: [{ text: "lo" }] },
        },
        {
          content: { role: "model", parts: [{ text: "Hello" }] },
        },
      ],
      [{ content: { role: "model", parts: [{ text: "Next" }] } }],
    ]);
    const sessionService = new MarkerLosingSessionService();
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService,
        agent: new Agent({ name: "streaming_agent", model }),
      }),
      userId: "user-1",
    });

    sessionService.loseMarkers = true;
    const firstInput = input();
    const first = await collect(bridge.clone(), firstInput);
    const messages = checkpoint(firstInput.messages, first);
    sessionService.loseMarkers = false;

    const second = await collect(
      bridge.clone(),
      input({
        runId: "run-2",
        messages: [
          ...messages,
          { id: "user-2", role: "user", content: "Continue" },
        ],
      }),
    );

    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    // The streamed assistant message id differs from the persisted aggregate
    // event id; without the marker the message must still be recognized as
    // ADK-originated and not replayed into the model request.
    const secondRequest = JSON.stringify(model.requests[1]?.contents);
    expect(secondRequest.match(/Hello/g)).toHaveLength(1);
  });

  it("resumes after text streamed before an ADK input request", async () => {
    const model = new DeterministicLlm([
      [
        {
          partial: true,
          content: { role: "model", parts: [{ text: "I need a region. " }] },
        },
        {
          content: {
            role: "model",
            parts: [
              { text: "I need a region. " },
              {
                functionCall: {
                  id: "region-request",
                  name: "adk_request_input",
                  args: { message: "Which region?" },
                },
              },
            ],
          },
        },
      ],
      [{ content: { role: "model", parts: [{ text: "Thanks." }] } }],
    ]);
    const bridge = new ADKJSAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({
          name: "interrupting_agent",
          model,
          tools: [requestInputTool],
        }),
      }),
      userId: "user-1",
    });
    const firstInput = input();
    const first = await collect(bridge.clone(), firstInput);
    const finished = first.at(-1);
    expect(finished).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "interrupt" },
    });
    const outcome =
      finished?.type === EventType.RUN_FINISHED ? finished.outcome : undefined;
    if (
      !finished ||
      finished.type !== EventType.RUN_FINISHED ||
      outcome?.type !== "interrupt"
    ) {
      throw new Error("Expected an interrupt outcome.");
    }
    const messages = checkpoint(firstInput.messages, first);

    const resumed = await collect(
      bridge.clone(),
      input({
        runId: "run-2",
        messages,
        resume: [
          {
            interruptId: outcome.interrupts[0]!.id,
            status: "resolved",
            payload: { region: "eu-west-1" },
          },
        ],
      }),
    );

    expect(resumed.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    expect(resumed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "Thanks.",
        }),
      ]),
    );
    expect(model.requests).toHaveLength(2);
  });
});

describe("message checkpoint at an interrupt boundary", () => {
  it("checkpoints a reasoning message and its signature so a resume can restore the thought", () => {
    // Without this an interrupt after a reasoning block resumes with the
    // model's chain of thought (and its Gemini signature) silently dropped.
    const messages = checkpoint(
      [],
      [
        { type: EventType.REASONING_START, messageId: "r1" },
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "r1",
          role: "reasoning",
        },
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "r1",
          delta: "think ",
        },
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "r1",
          delta: "harder",
        },
        { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
        { type: EventType.REASONING_END, messageId: "r1" },
        {
          type: EventType.REASONING_ENCRYPTED_VALUE,
          subtype: "message",
          entityId: "r1",
          encryptedValue: "sig-1",
        },
      ],
    );
    expect(messages).toEqual([
      {
        id: "r1",
        role: "reasoning",
        content: "think harder",
        encryptedValue: "sig-1",
      },
    ]);
  });

  it("synthesizes an assistant parent for a tool call whose message was never emitted", () => {
    // An interleaved sub-agent tool call can arrive without its own text
    // message; dropping it would make the resumed history unable to resolve
    // the tool name for its result.
    const messages = checkpoint(
      [],
      [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-1",
          toolCallName: "lookup",
          parentMessageId: "orphan",
          metadata: { [ADK_METADATA_KEY]: { author: "sub_agent" } },
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call-1",
          delta: '{"q":1}',
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
      ],
    );
    expect(messages).toEqual([
      expect.objectContaining({
        id: "orphan",
        role: "assistant",
        name: "sub_agent",
        toolCalls: [
          expect.objectContaining({
            id: "call-1",
            function: { name: "lookup", arguments: '{"q":1}' },
          }),
        ],
      }),
    ]);
  });

  it("updates rather than duplicates a tool result that is applied twice", () => {
    const result = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "res-1",
      toolCallId: "call-1",
      role: "tool",
    } as const;
    const messages = checkpoint(
      [],
      [
        { ...result, content: "first" },
        { ...result, content: "final" },
      ],
    );
    expect(messages).toEqual([
      { id: "res-1", role: "tool", toolCallId: "call-1", content: "final" },
    ]);
  });

  it("ignores a repeated start and content for a message it never saw", () => {
    // A duplicated TEXT_MESSAGE_START must not create a second message, and
    // content for an unknown id must not be attached to anything.
    const messages = checkpoint(
      [],
      [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "m1",
          role: "assistant",
        },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "m1",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "ghost",
          delta: "lost",
        },
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "r1",
          role: "reasoning",
        },
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "r1",
          role: "reasoning",
        },
        {
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "r1",
          delta: "why",
        },
      ],
    );
    expect(messages).toEqual([
      { id: "m1", role: "assistant", content: "hi" },
      { id: "r1", role: "reasoning", content: "why" },
    ]);
  });

  it("keeps the sub-agent tag on every checkpointed message and drops a client's null tag", () => {
    const messages = checkpoint(
      [{ id: "u1", role: "user", content: "hi", subagentRunId: null } as never],
      [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "m1",
          role: "assistant",
          subagentRunId: "s1",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "sub says",
        },
        {
          type: EventType.TEXT_MESSAGE_END,
          messageId: "m1",
          subagentRunId: "s1",
        },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "c1",
          toolCallName: "lookup",
          parentMessageId: "orphan",
          subagentRunId: "s1",
        },
        {
          type: EventType.TOOL_CALL_END,
          toolCallId: "c1",
          subagentRunId: "s1",
        },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "r1",
          toolCallId: "c1",
          content: "{}",
          role: "tool",
          subagentRunId: "s1",
        },
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: "th1",
          role: "reasoning",
          subagentRunId: "s1",
        },
      ],
    );
    expect(messages[0]).not.toHaveProperty("subagentRunId");
    expect(
      messages
        .slice(1)
        .map((m) => (m as { subagentRunId?: string }).subagentRunId),
    ).toEqual(["s1", "s1", "s1", "s1"]);
    expect(JSON.stringify(messages)).not.toContain("null");
  });

  it("attaches a tool-call signature to the message that owns the call", () => {
    const messages = checkpoint(
      [
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { id: "u1", role: "user", content: "hi" },
      ],
      [
        {
          type: EventType.REASONING_ENCRYPTED_VALUE,
          subtype: "tool-call",
          entityId: "call-1",
          encryptedValue: "sig-call",
        },
        {
          type: EventType.REASONING_ENCRYPTED_VALUE,
          subtype: "tool-call",
          entityId: "call-unknown",
          encryptedValue: "dropped",
        },
      ],
    );
    expect(messages[0]).toMatchObject({
      toolCalls: [{ id: "call-1", encryptedValue: "sig-call" }],
    });
    expect(JSON.stringify(messages)).not.toContain("dropped");
  });
});

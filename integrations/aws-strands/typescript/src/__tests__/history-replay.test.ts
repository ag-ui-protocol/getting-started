/**
 * History reconciliation (replayHistoryIntoStrands). Fixes the "chart loops
 * forever" symptom: without replay, the LLM never sees the client-produced
 * tool result on the next turn and re-fires the same tool.
 *
 * Python parity: adapter mirrors agent.py's _build_strands_history and
 * stream_async(None) flow.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { PROXY_RESULT_PLACEHOLDER } from "../client-proxy-tool";
import {
  collect,
  errorCodes,
  expectCompletedRun,
  historyShape,
  minimalRunInput,
  modelSawShape,
  modelSawTexts,
  modelTurn,
  realStrandsAgent,
  scriptedAgent,
  strandsAgentOverStub,
  threadAgent,
} from "./helpers";

function recordingAgent() {
  const calls: { args: unknown; messages: unknown[] }[] = [];
  const stub = scriptedAgent([], {
    messages: [] as never,
    sessionManager: undefined as never,
    stream: async function* (args: unknown) {
      calls.push({
        args,
        messages: [...(stub as unknown as { messages: unknown[] }).messages],
      });
    } as unknown as import("@strands-agents/sdk").Agent["stream"],
  });
  return { stub, calls };
}

describe("replayHistoryIntoStrands", () => {
  it("rebuilds agent.messages before stream() and calls stream(undefined)", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "hello" },
          { id: "a1", role: "assistant", content: "hi" },
          { id: "u2", role: "user", content: "another" },
        ],
      }),
    );
    expect(calls).toHaveLength(1);
    // stream(undefined) is the signal to Strands: "use my this.messages as-is".
    expect(calls[0]!.args).toBeUndefined();
    expect(calls[0]!.messages).toHaveLength(3);
  });

  it("renders prior tool_calls as toolUse ContentBlocks so the LLM sees them", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do something" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "render_chart", arguments: '{"x":1}' },
              },
            ],
          },
          { id: "t1", role: "tool", content: "ok", toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{
      role: string;
      content: unknown[];
    }>;
    // 3 turns: user, assistant(toolUse), user(toolResult)
    expect(history).toHaveLength(3);
    expect(history[1]!.role).toBe("assistant");
    // Message.fromMessageData converts plain { toolUse: {...} } objects to
    // ToolUseBlock instances — inspect fields on the instance directly.
    const toolUseBlock = history[1]!.content[0] as {
      type: string;
      toolUseId: string;
      name: string;
    };
    expect(toolUseBlock.type).toBe("toolUseBlock");
    expect(toolUseBlock.toolUseId).toBe("tc1");
    expect(toolUseBlock.name).toBe("render_chart");
    expect(history[2]!.role).toBe("user");
    expect((history[2]!.content[0] as { type: string }).type).toBe(
      "toolResultBlock",
    );
  });

  it("decodes JSON tool result content into a JsonBlock so the LLM sees structure", async () => {
    // Frontends (e.g. CopilotKit useHumanInTheLoop's `respond({...})`) JSON-
    // encode structured results before transport. Forwarding the raw string as
    // a TextBlock leaves the model with the original toolUse.input and an
    // opaque text payload — the model then ignores the user's selection and
    // re-lists the original args. Emit `{json: parsed}` so the result wins.
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    const toolResult = JSON.stringify({
      accepted: true,
      steps: [
        { description: "Crack eggs", status: "enabled" },
        { description: "Mix batter", status: "enabled" },
      ],
    });
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "plan brownies" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: {
                  name: "generate_task_steps",
                  arguments: '{"steps":[]}',
                },
              },
            ],
          },
          { id: "t1", role: "tool", content: toolResult, toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{
      role: string;
      content: unknown[];
    }>;
    const toolResultBlock = history[2]!.content[0] as {
      type: string;
      content: Array<{ type: string; text?: string; json?: unknown }>;
    };
    expect(toolResultBlock.type).toBe("toolResultBlock");
    expect(toolResultBlock.content).toHaveLength(1);
    const inner = toolResultBlock.content[0]!;
    expect(inner.type).toBe("jsonBlock");
    expect(inner.json).toEqual({
      accepted: true,
      steps: [
        { description: "Crack eggs", status: "enabled" },
        { description: "Mix batter", status: "enabled" },
      ],
    });
  });

  it("falls back to a TextBlock when tool result content is not JSON", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do x" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "do_x", arguments: "{}" },
              },
            ],
          },
          { id: "t1", role: "tool", content: "plain ack", toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{ content: unknown[] }>;
    const toolResultBlock = history[2]!.content[0] as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(toolResultBlock.content[0]!.type).toBe("textBlock");
    expect(toolResultBlock.content[0]!.text).toBe("plain ack");
  });

  it("is disabled when replayHistoryIntoStrands=false", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub, {
      config: { replayHistoryIntoStrands: false },
    });
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hello" }],
      }),
    );
    // Falls back to the legacy path: stream("hello"), agent.messages empty.
    expect(calls[0]!.args).toBe("hello");
    expect(calls[0]!.messages).toHaveLength(0);
  });

  it("is disabled when the agent has a session manager (Strands owns history)", async () => {
    const { stub, calls } = recordingAgent();
    (stub as { sessionManager: unknown }).sessionManager = {
      // presence is enough — adapter only checks truthiness
    };
    const agent = strandsAgentOverStub(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hello" }],
      }),
    );
    expect(calls[0]!.args).toBe("hello");
    expect(calls[0]!.messages).toHaveLength(0);
  });
  it("carries a client-reported tool failure onto the toolResult status", async () => {
    // AG-UI models the failure as ToolMessage.error; Bedrock models it as
    // toolResult.status. Hardcoding "success" tells the model a failed
    // frontend tool succeeded. Python parity: agent.py's _build_strands_history
    // (#2317).
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do something" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "render_chart", arguments: "{}" },
              },
            ],
          },
          {
            id: "t1",
            role: "tool",
            content: "tool failed: invalid id",
            toolCallId: "tc1",
            error: "invalid id",
          },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{ content: unknown[] }>;
    const block = history[2]!.content[0] as { status: string };
    expect(block.status).toBe("error");
  });

  it("keeps a successful tool result on the success status", async () => {
    const { stub, calls } = recordingAgent();
    const agent = strandsAgentOverStub(stub);
    await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do something" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "render_chart", arguments: "{}" },
              },
            ],
          },
          { id: "t1", role: "tool", content: "ok", toolCallId: "tc1" },
        ],
      }),
    );
    const history = calls[0]!.messages as Array<{ content: unknown[] }>;
    const block = history[2]!.content[0] as { status: string };
    expect(block.status).toBe("success");
  });
});

/**
 * A trailing tool result whose tool nothing can name is fatal on every path.
 *
 * Replay looks like it should be exempt, since it carries the result in its own
 * `toolResult` block addressed by id and needs no name. But the two conditions
 * arrive together: nothing can name the call precisely because the assistant
 * `toolUse` block is absent, so the replayed history would answer no call at
 * all. Exempting it swaps the designed error for whatever the provider says
 * about an orphan `toolResult`, which is worse and no more repairable.
 */
describe("an unnameable trailing tool result", () => {
  /** A delta-only continuation: no assistant turn, no tool declarations. */
  function orphanContinuation(...toolCallIds: string[]): RunAgentInput {
    return minimalRunInput({
      messages: toolCallIds.map((toolCallId, index) => ({
        id: `t${index}`,
        role: "tool",
        toolCallId,
        content: "orphan",
      })) as never,
      tools: [],
    });
  }

  const runErrors = (events: BaseEvent[]): BaseEvent[] =>
    events.filter((e) => e.type === EventType.RUN_ERROR);

  it("fails closed rather than replaying a toolResult no toolUse answers", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")]);

    const events = await collect(
      agent,
      orphanContinuation("an-id-nothing-knows"),
    );

    expect(errorCodes(events)).toEqual(["CONTINUATION_TOOL_NAME_UNRESOLVED"]);
    // The orphan history never reaches a provider, so the turn stays as
    // repairable as it arrived instead of failing under a provider error.
    expect(model.calls).toBe(0);
  });

  it("fails closed when the derived prompt is what reaches the model", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });

    const events = await collect(
      agent,
      orphanContinuation("an-id-nothing-knows"),
    );

    expect(errorCodes(events)).toEqual(["CONTINUATION_TOOL_NAME_UNRESOLVED"]);
    // Failing closed means the greeting that caused the re-fire loop never
    // reaches the model.
    expect(model.calls).toBe(0);
  });

  /**
   * The report above only ever looks at TRAILING results, so a user message
   * after the orphan puts it out of reach: the run is not fatal, and the
   * replayed history is what has to be valid on its own.
   */
  it("drops an orphan the report cannot reach rather than replaying it", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")]);

    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "t0", role: "tool", toolCallId: "ghost-id", content: "orphan" },
          { id: "u2", role: "user", content: "and darker" },
        ] as never,
        tools: [],
      }),
    );

    expectCompletedRun(events);
    // Only the user turn survives. A `toolResult` answering no `toolUse` is a
    // history real providers reject, so replaying it would turn a turn that
    // works into a generic provider failure.
    expect(
      (model.seenMessages[0] ?? []).map((message) => ({
        role: message.role,
        content: (message.content as unknown[]).map((block) => ({
          ...(block as Record<string, unknown>),
        })),
      })),
    ).toEqual([
      { role: "user", content: [{ type: "textBlock", text: "and darker" }] },
    ]);
  });

  it("reports every unnameable id, in the order the client sent them", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });

    const events = await collect(
      agent,
      orphanContinuation("first-id", "second-id"),
    );

    expect(runErrors(events)).toEqual([
      {
        type: EventType.RUN_ERROR,
        code: "CONTINUATION_TOOL_NAME_UNRESOLVED",
        message:
          "Cannot name the tool behind continuation tool result(s) " +
          "first-id, second-id: absent from the input messages and from the " +
          "native session history",
      },
    ]);
  });
});

/**
 * The re-fire loop, on the DEFAULT no-session-manager path.
 *
 * A continuation whose assistant turn the request omits is where the turn's two
 * views of its own tool calls pull apart. The orphan-result guard drops the
 * client's `toolResult`, because the request opens no call for it to answer,
 * while the tool-name lookup resolves the tool anyway off the STORED native
 * history. Let the replay win the decision and it replaces that stored history
 * with the question alone, `stream(undefined)` throws away the prompt that
 * carried the answer, and the model fires the same tool again. Both readings
 * come from one resolved view, and a replay that cannot carry an answer this
 * turn is answering does not win.
 */
describe("a continuation whose assistant turn the request omits", () => {
  const COLOR_TOOL = "set_color";
  const COLOR_CALL = "native-first";
  const USER_TEXT = "make it red";
  const CLIENT_TOOLS = [
    {
      name: COLOR_TOOL,
      description: "Sets a UI color.",
      parameters: {
        type: "object",
        properties: { color: { type: "string" } },
        required: ["color"],
      },
    },
  ] as never;

  /** Turn 1: the model calls the frontend tool, which halts the run. */
  async function handOverToClient() {
    const booted = realStrandsAgent([
      modelTurn.toolUse({
        toolUseId: COLOR_CALL,
        name: COLOR_TOOL,
        input: { color: "red" },
      }),
      modelTurn.text("done"),
    ]);
    const events = await collect(
      booted.agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: USER_TEXT }] as never,
        tools: CLIENT_TOOLS,
      }),
    );
    expectCompletedRun(events, "hand-over turn");
    return booted;
  }

  /**
   * The continuation a client sends when it renders the frontend call as its own
   * UI rather than as an assistant message: the user turn and the answer, with
   * no assistant `toolCalls` between them.
   */
  const continuation = (): RunAgentInput =>
    minimalRunInput({
      runId: "run-2",
      messages: [
        { id: "u1", role: "user", content: USER_TEXT },
        {
          id: "t1",
          role: "tool",
          toolCallId: COLOR_CALL,
          content: "color applied",
        },
      ] as never,
      tools: CLIENT_TOOLS,
    });

  it("says what came back instead of replaying the question alone", async () => {
    const { agent, model } = await handOverToClient();

    const events = await collect(agent, continuation());

    expectCompletedRun(events);
    // The whole picture, not just "the answer is in there somewhere": a replay
    // that wins here hands the model the question and nothing else, which is
    // precisely the re-fire loop.
    expect(modelSawTexts(model, 1)).toEqual([
      USER_TEXT,
      PROXY_RESULT_PLACEHOLDER,
      `${COLOR_TOOL} returned: color applied`,
    ]);
  });

  it("leaves the stored native history holding the call it is answering", async () => {
    const { agent } = await handOverToClient();

    await collect(agent, continuation());

    // Overwriting the stored history with one built from a request that never
    // carried the assistant turn is what loses the call being answered.
    expect(historyShape(threadAgent(agent)!.messages)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["toolUseBlock"] },
      { role: "user", blocks: ["toolResultBlock"] },
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["textBlock"] },
    ]);
  });
});

/**
 * An orphaned tool CALL is replayed no more than an orphaned tool result.
 *
 * Providers reject an unanswered `toolUse` for the identical reason they reject
 * an unanswered `toolResult`, and an abandoned frontend call or a reload
 * mid-round-trip is exactly how a request comes to carry one.
 */
describe("a request carrying a tool call nothing answers", () => {
  const CHART = "render_chart";

  it("replays only the call the request answers", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")]);

    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "do something" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "answered",
                type: "function",
                function: { name: CHART, arguments: "{}" },
              },
              {
                id: "abandoned",
                type: "function",
                function: { name: CHART, arguments: "{}" },
              },
            ],
          },
          { id: "t1", role: "tool", content: "ok", toolCallId: "answered" },
        ] as never,
        tools: [],
      }),
    );

    expectCompletedRun(events);
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["toolUseBlock"] },
      { role: "user", blocks: ["toolResultBlock"] },
    ]);
  });

  /**
   * Both halves of the pair read the SAME ordering rule. A result is offered a
   * home only by a call the request opens BEFORE it, so a request that sends the
   * answer first offers it none; the call it answers has to go the same way, or
   * the replay keeps a `toolUse` whose only result was already dropped.
   */
  it("replays neither half when the answer precedes the call", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")]);

    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "chart it" },
          { id: "t1", role: "tool", content: "ok", toolCallId: "inverted" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "inverted",
                type: "function",
                function: { name: CHART, arguments: "{}" },
              },
            ],
          },
        ] as never,
        tools: [],
      }),
    );

    expectCompletedRun(events);
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["textBlock"] },
    ]);
  });

  it("replays no call at all when the round trip never came back", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")]);

    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          { id: "u1", role: "user", content: "chart it" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "abandoned",
                type: "function",
                function: { name: CHART, arguments: "{}" },
              },
            ],
          },
          { id: "u2", role: "user", content: "actually, never mind" },
        ] as never,
        tools: [],
      }),
    );

    expectCompletedRun(events);
    // The assistant turn keeps its place in the conversation, carrying no call.
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["textBlock"] },
      { role: "user", blocks: ["textBlock"] },
    ]);
  });
});

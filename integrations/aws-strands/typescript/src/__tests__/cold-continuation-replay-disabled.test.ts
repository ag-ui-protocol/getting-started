/**
 * A frontend-tool continuation that arrives on a cold agent with
 * `replayHistoryIntoStrands: false` and no session manager.
 *
 * Cold here means the adapter holds no cached Strands `Agent` for the thread,
 * so it builds one and seeds it from `RunAgentInput.messages`. A continuation
 * routed to a fresh process, or arriving after a restart, looks like this.
 *
 * With replay disabled the seed is the whole history, and its last message is
 * the user-role `toolResult`. The synthetic continuation prompt used to be
 * folded into that turn so the conversation stayed one user turn, and that is
 * the shape this file now exists to keep out. The splitting formatters
 * (openai, litellm, mistral, writer, llamaapi, llamacpp) emit a turn's
 * non-tool content as a user message of its own AHEAD of the tool message its
 * tool results become, so a turn carrying both binds as
 * `assistant(tool_calls) -> user(text) -> tool(result)`. OpenAI answers that
 * with HTTP 400 "An assistant message with 'tool_calls' must be followed by
 * tool messages responding to each 'tool_call_id'", which the bridge reports
 * as a terminal `STRANDS_FORCE_STOP`.
 *
 * The prompt therefore travels as its own turn, which is also what reaches the
 * session store. That leaves two consecutive user messages, which the
 * one-to-one formatters (anthropic, bedrock, gemini) do refuse: a real
 * limitation, pre-existing on every other path through this adapter, and not
 * one this file claims to fix. Repairing it by folding the client's own turn
 * into an older one is what these tests exist to prevent.
 */

import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import {
  type Message as StrandsMessage,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import type { BaseEvent } from "@ag-ui/core";
import {
  ScriptedModel,
  collect,
  errorCodes,
  expectCompletedRun,
  expectToolCallsAnsweredImmediately,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
} from "./helpers";

function continuationInput(threadId: string) {
  return minimalRunInput({
    threadId,
    messages: [
      { id: "u1", role: "user", content: "call the tool" } as never,
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "doIt", arguments: "{}" },
          },
        ],
      } as never,
      // Render-only frontend tools legitimately return nothing.
      { id: "t1", role: "tool", toolCallId: "tc1", content: "" } as never,
    ],
    tools: [
      {
        name: "doIt",
        description: "a frontend tool",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
}

/** The content blocks of one message, as the plain serialized form. */
function blocksOf(message: StrandsMessage): Array<Record<string, unknown>> {
  const data = (
    message as unknown as { toJSON?: () => { content?: unknown[] } }
  ).toJSON?.() ?? { content: (message as { content?: unknown[] }).content };
  return (data.content ?? []) as Array<Record<string, unknown>>;
}

function textsOf(message: StrandsMessage): string[] {
  return blocksOf(message)
    .map((block) => block.text)
    .filter((text): text is string => typeof text === "string");
}

function carriesToolResult(message: StrandsMessage): boolean {
  return blocksOf(message).some((block) => block.toolResult !== undefined);
}

/**
 * The request the real OpenAI Chat Completions adapter builds for `history`.
 *
 * The Strands SDK's OpenAI provider is the formatter under test, not a
 * reimplementation of it: the only thing replaced is the transport, so what
 * comes back is what the bridge would have put on the wire. The fake client is
 * duck-typed to the one call `_streamChat` makes, hence the cast.
 */
async function openAIBoundMessages(
  history: readonly StrandsMessage[],
): Promise<Array<Record<string, unknown>>> {
  const captured: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const client = {
    chat: {
      completions: {
        create: async (request: {
          messages: Array<Record<string, unknown>>;
        }) => {
          captured.push(request);
          return (async function* () {})();
        },
      },
    },
  } as unknown as OpenAI;

  const model = new OpenAIModel({ api: "chat", modelId: "gpt-4o", client });
  for await (const _event of model.stream([...history])) {
    // Drained so the adapter reaches its request build; the fake yields none.
  }
  return captured[0]!.messages;
}

/** Every assistant message with `tool_calls` is followed by its tool messages. */
function openAIAdjacency(
  bound: Array<Record<string, unknown>>,
): "ok" | `broken at [${number}]` {
  for (let index = 0; index < bound.length; index++) {
    const message = bound[index]!;
    const toolCalls = message.tool_calls as unknown[] | undefined;
    if (message.role !== "assistant" || !toolCalls?.length) continue;
    const answers = bound.slice(index + 1, index + 1 + toolCalls.length);
    if (
      answers.length !== toolCalls.length ||
      answers.some((answer) => answer.role !== "tool")
    ) {
      return `broken at [${index}]`;
    }
  }
  return "ok";
}

/**
 * A model that refuses the shape OpenAI refuses.
 *
 * `ScriptedModel` replays turns whatever it is handed, so on its own it cannot
 * tell a run that would have worked from one OpenAI would have answered with a
 * 400. This double runs the real Chat Completions formatter and rejects a
 * broken tool call the way the provider does, which is what makes the terminal
 * event below mean anything: the bridge turns a throw from the model into a
 * `STRANDS_FORCE_STOP` run error, exactly as it turns the provider's own
 * rejection into one.
 *
 * It deliberately does not enforce role alternation. Two consecutive user
 * turns are a shape this adapter has always produced on its ordinary paths,
 * so a double that refused them would be asserting a fix nothing here makes.
 */
class ProviderRuleModel extends ScriptedModel {
  override async *stream(
    messages: StrandsMessage[],
    options?: { toolSpecs?: { name: string }[] },
  ): AsyncIterable<ModelStreamEvent> {
    const bound = await openAIBoundMessages(messages);
    const adjacency = openAIAdjacency(bound);
    if (adjacency !== "ok") {
      throw new Error(
        "An assistant message with 'tool_calls' must be followed by tool " +
          `messages responding to each 'tool_call_id' (${adjacency})`,
      );
    }
    yield* super.stream(messages, options);
  }
}

describe("cold frontend-tool continuation with replay disabled", () => {
  it("keeps the continuation prompt out of the tool-result turn", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });

    const events: BaseEvent[] = [];
    for await (const e of agent.run(continuationInput("cold-1"))) {
      events.push(e);
    }

    expectCompletedRun(events);
    expect(model.seenMessages).toHaveLength(1);

    const history = model.seenMessages[0]!;
    expect(history.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
    ]);

    // The turn that answers the tool call carries the tool result and nothing
    // else; the prompt is the turn after it, which is also the turn the store
    // records.
    const answering = history[2]!;
    expect(carriesToolResult(answering)).toBe(true);
    expect(textsOf(answering)).toEqual([]);
    expect(textsOf(history[3]!)).toEqual([
      "doIt executed successfully with no return value.",
    ]);
    expect(textsOf(history[0]!)).toEqual(["call the tool"]);

    expectToolCallsAnsweredImmediately(history);
  });

  it("binds to a request the real OpenAI formatter accepts", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });

    const events: BaseEvent[] = [];
    for await (const e of agent.run(continuationInput("cold-openai"))) {
      events.push(e);
    }
    expectCompletedRun(events);

    const bound = await openAIBoundMessages(model.seenMessages[0]!);
    expect(bound.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(openAIAdjacency(bound)).toBe("ok");
  });

  it("finishes the run under a model that enforces the provider rules", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
      model: new ProviderRuleModel([modelTurn.text("done")]),
    });

    const events = await collect(agent, continuationInput("cold-rules"));

    expectCompletedRun(events);
    expect(errorCodes(events)).toEqual([]);
  });

  it("never seeds a blank block for an empty tool result", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });

    const events: BaseEvent[] = [];
    for await (const e of agent.run(continuationInput("cold-2"))) {
      events.push(e);
    }
    expectCompletedRun(events);

    // A render-only tool's empty result must reach the provider as the
    // non-empty acknowledgement the replay path already substitutes, not as
    // the blank text block the provider rejects.
    const serialised = JSON.stringify(
      model.seenMessages[0]!.map(
        (m) => (m as unknown as { toJSON?: () => unknown }).toJSON?.() ?? m,
      ),
    );
    expect(serialised).not.toContain('"text":""');
  });
});

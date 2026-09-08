/**
 * A frontend-tool continuation that arrives on a cold agent with
 * `replayHistoryIntoStrands: false` and no session manager.
 *
 * Cold here means the adapter holds no cached Strands `Agent` for the thread,
 * so it builds one and seeds it from `RunAgentInput.messages`. A continuation
 * routed to a fresh process, or arriving after a restart, looks like this.
 *
 * With replay disabled the seed is the whole history, and its last message is
 * the user-role `toolResult`. That leaves the synthetic continuation prompt
 * with nowhere obvious to go, and the two obvious answers are each wrong for
 * one family of providers:
 *
 * - Handing the prompt to `stream()` has Strands append a SECOND user message.
 *   The one-to-one formatters (anthropic, bedrock, gemini) map that to two
 *   consecutive user messages, which those providers reject.
 * - Folding the prompt into the `toolResult` turn has the splitting formatters
 *   (openai, litellm, mistral, writer, llamaapi, llamacpp) emit it as a user
 *   message of its own AHEAD of the tool message, so the bound sequence is
 *   `assistant(tool_calls) -> user(text) -> tool(result)` and OpenAI answers
 *   with HTTP 400, which the bridge reports as a terminal `STRANDS_FORCE_STOP`
 *   run error.
 *
 * So the prompt rides in the question, the latest user turn that carries no
 * tool result. The message count does not change, nothing lands in a turn that
 * answers a tool call, and both rules hold. These tests check the placement,
 * check it against the real OpenAI Chat Completions formatter the Strands SDK
 * ships, and check that a model that enforces the provider rules the way the
 * provider does still lets the run finish.
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
  expectRolesAlternate,
  expectToolCallsAnsweredImmediately,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
} from "./helpers";

/**
 * The messages the model was actually handed, per invocation.
 *
 * Snapshotted, not aliased: the SDK keeps mutating the same array after the
 * call, so holding the reference would report the end-of-run history rather
 * than what the model was given.
 */
function recordModelInput(model: {
  stream: (...a: unknown[]) => unknown;
}): StrandsMessage[][] {
  const seen: StrandsMessage[][] = [];
  const original = model.stream.bind(model);
  model.stream = (...args: unknown[]) => {
    seen.push([...((args[0] ?? []) as StrandsMessage[])]);
    return original(...args);
  };
  return seen;
}

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
 * A model that refuses the shapes the providers refuse.
 *
 * `ScriptedModel` replays turns whatever it is handed, so on its own it cannot
 * tell a run that would have worked from one OpenAI would have answered with a
 * 400. This double applies both provider rules before replaying, which is what
 * makes the terminal-event assertions below mean anything: the bridge turns a
 * throw from the model into a `STRANDS_FORCE_STOP` run error, exactly as it
 * turns the provider's own rejection into one.
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
    const roles = messages.map((message) => message.role);
    for (let index = 1; index < roles.length; index++) {
      if (roles[index] === roles[index - 1]) {
        throw new Error(
          `A conversation must alternate between user and assistant roles ` +
            `(broken at [${index}])`,
        );
      }
    }
    yield* super.stream(messages, options);
  }
}

describe("cold frontend-tool continuation with replay disabled", () => {
  it("keeps the continuation prompt out of the tool-result turn", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });
    const seen = recordModelInput(model as never);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(continuationInput("cold-1"))) {
      events.push(e);
    }

    expectCompletedRun(events);
    expect(seen).toHaveLength(1);

    const history = seen[0]!;
    const roles = history.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);

    // The prompt is in the question, and the turn that answers the tool call
    // carries the tool result and nothing else.
    expect(textsOf(history[0]!)).toEqual([
      "call the tool\n\ndoIt executed successfully with no return value.",
    ]);
    const tail = history[history.length - 1]!;
    expect(carriesToolResult(tail)).toBe(true);
    expect(textsOf(tail)).toEqual([]);

    expectToolCallsAnsweredImmediately(history);
    expectRolesAlternate(history);
  });

  it("binds to a request the real OpenAI formatter accepts", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("done")], {
      config: { replayHistoryIntoStrands: false },
    });
    const seen = recordModelInput(model as never);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(continuationInput("cold-openai"))) {
      events.push(e);
    }
    expectCompletedRun(events);

    const bound = await openAIBoundMessages(seen[0]!);
    expect(bound.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
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
    const seen = recordModelInput(model as never);

    const events: BaseEvent[] = [];
    for await (const e of agent.run(continuationInput("cold-2"))) {
      events.push(e);
    }
    expectCompletedRun(events);

    // A render-only tool's empty result must reach the provider as the
    // non-empty acknowledgement the replay path already substitutes, not as
    // the blank text block the provider rejects.
    const serialised = JSON.stringify(
      seen[0]!.map(
        (m) => (m as unknown as { toJSON?: () => unknown }).toJSON?.() ?? m,
      ),
    );
    expect(serialised).not.toContain('"text":""');
  });
});

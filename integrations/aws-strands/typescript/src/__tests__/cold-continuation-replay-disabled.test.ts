/**
 * A frontend-tool continuation that arrives on a cold agent with
 * `replayHistoryIntoStrands: false` and no session manager.
 *
 * Cold here means the adapter holds no cached Strands `Agent` for the thread,
 * so it builds one and seeds it from `RunAgentInput.messages`. A continuation
 * routed to a fresh process, or arriving after a restart, looks like this.
 *
 * With replay disabled the seed is the whole history, and its last message is
 * the user-role `toolResult`. Handing the synthetic continuation prompt to
 * `stream()` would then have Strands append a SECOND user message, and the
 * provider-bound roles become user -> assistant -> user -> user, which Bedrock
 * refuses for failing role alternation. The continuation has to stay one user
 * turn carrying both the tool result and the prompt.
 */

import { describe, it, expect } from "vitest";
import type { Message as StrandsMessage } from "@strands-agents/sdk";
import type { BaseEvent } from "@ag-ui/core";
import {
  expectCompletedRun,
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

describe("cold frontend-tool continuation with replay disabled", () => {
  it("keeps the continuation in one user turn", async () => {
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

    const roles = seen[0]!.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);

    // The final turn carries the native tool result AND the synthetic prompt,
    // rather than the prompt arriving as a fourth message of its own.
    const last = seen[0]![seen[0]!.length - 1]!;
    const blocks = (last.content ?? []) as unknown[];
    const hasToolResult = blocks.some(
      (b) =>
        (b as { toolResult?: unknown }).toolResult !== undefined ||
        (b as { type?: string }).type === "toolResultBlock",
    );
    const texts = blocks
      .map((b) => (b as { text?: unknown }).text)
      .filter((t): t is string => typeof t === "string");
    expect(hasToolResult).toBe(true);
    expect(texts.join("")).not.toBe("");
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

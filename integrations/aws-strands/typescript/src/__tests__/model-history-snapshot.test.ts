/**
 * Fidelity of the model-facing history a scripted model records.
 *
 * Real-SDK tests assert what the model saw on a given turn by reading
 * `ScriptedModel.seenMessages` through `historyTexts` / `historyShape`. Session
 * reconciliation corrects a tool result by substituting a new block at the same
 * index of a message's `content`, so a recording that merely aliased the
 * message objects `stream()` was handed would turn an earlier turn's record
 * into a record of the correction: an assertion about what the model saw would
 * read post-hoc state and hold anyway.
 *
 * The rewrite below therefore lands on the messages `stream()` was handed.
 * Whether those are the agent's live history or copies of it is the SDK's own
 * choice, and it differs between releases, so asserting identity with the live
 * array would pin the SDK rather than the recorder. The recorder owes the same
 * isolation either way, and the direct-`stream()` case below is handed objects
 * its caller still holds.
 *
 * The readers also discriminate on block `type` and reach the text nested
 * inside a tool-result block, neither of which survives a copy that serializes
 * without rehydrating the block classes. They are imported here rather than
 * reimplemented: a local copy would leave the readers every other suite calls
 * unguarded, which is the one thing this file exists to prevent.
 */

import { describe, expect, it } from "vitest";
import {
  TextBlock,
  ToolResultBlock,
  type Message as StrandsMessage,
} from "@strands-agents/sdk";
import type { RunAgentInput } from "@ag-ui/core";

import {
  collect,
  expectCompletedRun,
  historyShape,
  historyTexts,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  threadAgent,
} from "./helpers";

const TOOL_CALL_ID = "tc1";
const TOOL_RESULT_TEXT = "color applied";
const CORRECTION_TEXT = "corrected after the turn";

/** A continuation whose replayed history reaches the model as a toolResult. */
function continuation(): RunAgentInput {
  return minimalRunInput({
    messages: [
      { id: "u1", role: "user", content: "paint it" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: TOOL_CALL_ID,
            type: "function",
            function: { name: "set_color", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: TOOL_CALL_ID,
        content: TOOL_RESULT_TEXT,
      },
    ],
  });
}

const isToolResult = (block: unknown): boolean =>
  (block as { type?: unknown }).type === "toolResultBlock";

/** Drive one turn and hand back the record and the history behind it. */
async function oneTurn(): Promise<{
  recorded: StrandsMessage[];
  handed: StrandsMessage[];
}> {
  const { agent, model } = realStrandsAgent([modelTurn.text("first")]);

  expectCompletedRun(await collect(agent, continuation()));

  expect(
    threadAgent(agent),
    "the adapter built no per-thread agent",
  ).toBeDefined();
  const handed = model.handedMessages[0];
  const recorded = model.seenMessages[0];
  expect(recorded, "the model recorded no turn").toBeDefined();
  return { recorded: recorded!, handed: handed! };
}

describe("the history a scripted model records", () => {
  it("survives a later in-place rewrite of the content it was handed", async () => {
    const { recorded, handed } = await oneTurn();

    // The replayed tool result reached the model, so the rewrite below lands on
    // an object the model genuinely saw rather than on a bystander.
    const messageIndex = handed.findIndex((message) =>
      message.content.some(isToolResult),
    );
    expect(
      messageIndex,
      "the model was handed no tool result to correct",
    ).toBeGreaterThanOrEqual(0);
    const content = handed[messageIndex]!.content;
    // Exactly what session reconciliation does to a persisted placeholder.
    content[content.findIndex(isToolResult)] = new ToolResultBlock({
      toolUseId: TOOL_CALL_ID,
      status: "success",
      content: [new TextBlock(CORRECTION_TEXT)],
    });

    // Nothing but `seenMessages` being its own copy can keep these two holding
    // now: the rewrite has already changed the array the model was handed, and
    // a record sharing either those messages or their `content` would carry the
    // correction.
    expect(historyTexts(recorded)).toContain(TOOL_RESULT_TEXT);
    expect(historyTexts(recorded)).not.toContain(CORRECTION_TEXT);
  });

  it("rehydrates the block classes its readers discriminate on", async () => {
    const { recorded } = await oneTurn();

    expect(historyShape(recorded)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["toolUseBlock"] },
      { role: "user", blocks: ["toolResultBlock"] },
    ]);
    // The nested text is only reachable while the tool-result block is one.
    expect(historyTexts(recorded)).toEqual(["paint it", TOOL_RESULT_TEXT]);
  });

  it("records a history message the SDK never rebuilt as a class", async () => {
    // A data-hydrated restore leaves plain objects in `messages`, which is the
    // shape the reconciliation recogniser exists to handle. A recorder that
    // insisted on `toJSON()` would throw inside the model for exactly that
    // history, so the path could not be driven end to end at all.
    const { model } = realStrandsAgent([modelTurn.text("first")]);
    const plain = {
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: TOOL_CALL_ID,
            status: "success",
            content: [{ text: TOOL_RESULT_TEXT }],
          },
        },
      ],
    } as unknown as StrandsMessage;

    // Drain the scripted turn; the recording it makes is what is under test.
    for await (const _event of model.stream([plain])) {
      void _event;
    }

    expect(historyShape(model.seenMessages[0]!)).toEqual([
      { role: "user", blocks: ["toolResultBlock"] },
    ]);
    expect(historyTexts(model.seenMessages[0]!)).toEqual([TOOL_RESULT_TEXT]);
  });
});

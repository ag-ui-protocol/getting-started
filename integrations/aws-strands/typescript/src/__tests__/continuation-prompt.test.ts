/**
 * The synthetic continuation prompt: what the model is told after a frontend
 * tool resolves.
 *
 * This prompt is the ONLY channel carrying a client-executed tool's answer to
 * the model on the configurations where history replay does not run (replay
 * calls `stream(undefined)` and the prompt is discarded). Announcing a bare
 * success here silently breaks human-in-the-loop: an approval resolving to
 * `{"approved": false}` would be reported as a successful no-op and the model
 * would proceed as though the human had approved.
 *
 * Python parity: agent.py derives the same lines in its continuation branch.
 */

import { describe, it, expect } from "vitest";
import type { Agent } from "@strands-agents/sdk";
import type { Message, RunAgentInput } from "@ag-ui/core";

import type { StrandsAgentConfig } from "../config";
import {
  collect,
  expectCompletedRun,
  minimalRunInput,
  scriptedAgent,
  strandsAgentOverStub,
} from "./helpers";

/** A stub that records the prompt the adapter hands to `stream()`. */
function promptRecorder() {
  const calls: unknown[] = [];
  const stub = scriptedAgent([], {
    messages: [] as never,
    sessionManager: undefined as never,
    stream: async function* (args: unknown) {
      calls.push(args);
    } as unknown as Agent["stream"],
  });
  return { stub, calls };
}

/** The frontend tool every case here resolves. */
const TOOL = "approve_step";

/**
 * A continuation run: the assistant called `approve_step` as a frontend tool
 * and the client's answer for it is the trailing message.
 */
function continuationInput(
  results: { toolCallId: string; content?: string; error?: string }[],
): RunAgentInput {
  const messages: Message[] = [
    { id: "u1", role: "user", content: "do a thing" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: results.map((r) => ({
        id: r.toolCallId,
        type: "function" as const,
        function: { name: TOOL, arguments: "{}" },
      })),
    },
    ...results.map((r, i) => ({
      id: `t${i}`,
      role: "tool" as const,
      content: r.content ?? "",
      toolCallId: r.toolCallId,
      ...(r.error !== undefined ? { error: r.error } : {}),
    })),
  ];
  return minimalRunInput({
    messages,
    tools: [
      {
        name: TOOL,
        description: "d",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
}

/**
 * Drive one continuation run and return the prompt Strands received, having
 * first pinned that the run actually completed. Without that check a run that
 * died before reaching the model would leave `calls` empty and an assertion
 * on "no bare success string" would hold vacuously.
 */
async function promptFor(
  input: RunAgentInput,
  config: StrandsAgentConfig = { replayHistoryIntoStrands: false },
): Promise<string> {
  const { stub, calls } = promptRecorder();
  const agent = strandsAgentOverStub(stub, { config });
  const events = await collect(agent, input);
  expectCompletedRun(events, "continuation run");
  expect(calls, "adapter never invoked stream()").toHaveLength(1);
  return calls[0] as string;
}

describe("continuation prompt after a frontend tool resolves", () => {
  it("forwards a text result", async () => {
    const prompt = await promptFor(
      continuationInput([{ toolCallId: "tc1", content: "colour set to red" }]),
    );
    expect(prompt).toBe("approve_step returned: colour set to red");
  });

  it("forwards a JSON result verbatim", async () => {
    const body = '{"accepted":true,"steps":[{"description":"Crack eggs"}]}';
    const prompt = await promptFor(
      continuationInput([{ toolCallId: "tc1", content: body }]),
    );
    expect(prompt).toBe(`approve_step returned: ${body}`);
  });

  it("forwards a human-in-the-loop rejection instead of a success", async () => {
    const prompt = await promptFor(
      continuationInput([
        { toolCallId: "tc1", content: '{"approved": false}' },
      ]),
    );
    expect(prompt).toBe('approve_step returned: {"approved": false}');
    // The failure this test exists for: the rejection reported as a no-op.
    expect(prompt).not.toContain("executed successfully");
  });

  it("uses the synthetic acknowledgement only for a genuinely empty result", async () => {
    const prompt = await promptFor(
      continuationInput([{ toolCallId: "tc1", content: "" }]),
    );
    expect(prompt).toBe(
      "approve_step executed successfully with no return value.",
    );
  });

  it("announces a client-reported failure as a failure", async () => {
    const prompt = await promptFor(
      continuationInput([
        { toolCallId: "tc1", content: "", error: "user closed the dialog" },
      ]),
    );
    expect(prompt).toBe("approve_step failed: user closed the dialog");
    expect(prompt).not.toContain("executed successfully");
  });

  it("keeps a failing tool's body alongside its error", async () => {
    const prompt = await promptFor(
      continuationInput([
        { toolCallId: "tc1", content: "partial data", error: "timed out" },
      ]),
    );
    expect(prompt).toBe(
      "approve_step failed: timed out (returned: partial data)",
    );
    expect(prompt).not.toContain("executed successfully");
  });

  it("announces every parallel frontend result, in call order", async () => {
    const prompt = await promptFor(
      continuationInput([
        { toolCallId: "tc1", content: '{"approved": true}' },
        { toolCallId: "tc2", content: "", error: "declined" },
      ]),
    );
    expect(prompt).toBe(
      'approve_step returned: {"approved": true}\napprove_step failed: declined',
    );
  });

  it("also reaches the model when a session manager owns history", async () => {
    // The second live configuration: a wired session manager disables replay,
    // so the prompt is again what carries the result.
    const { stub, calls } = promptRecorder();
    const agent = strandsAgentOverStub(stub);
    // Set after construction: the constructor warns about a template-level
    // session manager, while the replay gate reads the per-thread agent.
    (stub as unknown as { sessionManager: unknown }).sessionManager = {};
    const events = await collect(
      agent,
      continuationInput([
        { toolCallId: "tc1", content: '{"approved": false}' },
      ]),
    );
    expectCompletedRun(events, "session-manager continuation run");
    expect(calls).toEqual(['approve_step returned: {"approved": false}']);
  });
});

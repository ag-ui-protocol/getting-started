import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type RunStartedEvent,
} from "@ag-ui/core";
import { startStepServer, type StepServerHandle } from "../../helpers/step-server";

interface TextDeltaEvent extends BaseEvent {
  delta: string;
}

function collectText(events: BaseEvent[]): string {
  return events
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as TextDeltaEvent).delta)
    .join("");
}

/**
 * HttpAgent does not surface parentRunId on its public runAgent parameters,
 * so for the cross-language branching test we extend it and inject the
 * parentRunId into the wire envelope produced by prepareRunAgentInput. The
 * mirror C# pattern (Step11's SampleClient) achieves the same thing through
 * ChatOptions.RawRepresentationFactory returning a RunAgentInput with
 * ParentRunId set.
 */
class BranchingHttpAgent extends HttpAgent {
  parentRunId?: string;

  protected override prepareRunAgentInput(
    parameters?: Parameters<HttpAgent["prepareRunAgentInput"]>[0],
  ): RunAgentInput {
    const input = super.prepareRunAgentInput(parameters);
    if (this.parentRunId) {
      (input as RunAgentInput & { parentRunId?: string }).parentRunId = this.parentRunId;
    }
    return input;
  }
}

let server: StepServerHandle;

beforeAll(async () => {
  // Step11 demonstrates the AG-UI serialization story: a run can branch
  // from a previous run by setting RunAgentInput.parentRunId. The C#
  // server echoes that field back on the RUN_STARTED event so consumers
  // can build a git-like lineage of runs. The FakeChatClient fallback
  // returns its standard `(fake) You said: "..."` response, which is fine
  // — the cross-language wire surface is the parentRunId echo, not the
  // text content.
  server = await startStepServer({
    step: 11,
    projectName: "Serialization",
    port: 8111,
  });
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

describe("TS HttpAgent -> C# Step11_Serialization.Server", () => {
  it("preserves parentRunId across runs to support branching", async () => {
    const agent = new BranchingHttpAgent({
      url: `${server.baseUrl}/`,
      threadId: "step11-branching",
      agentId: "step11-cross-language",
    });

    // Turn 1: no parent.
    agent.messages = [
      { id: "u1", role: "user", content: "Hello, tell me about serialization" },
    ];
    const turn1: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          turn1.push(event);
        },
      },
    );
    expect(collectText(turn1).length).toBeGreaterThan(0);
    const turn1Started = turn1.find((e) => e.type === EventType.RUN_STARTED) as RunStartedEvent;
    expect(turn1Started).toBeDefined();
    expect(turn1Started.runId).toBeTruthy();

    // Turn 2: branch from turn1's runId.
    agent.parentRunId = turn1Started.runId;
    agent.messages.push({
      id: "u2",
      role: "user",
      content: "Tell me more about event compaction",
    });
    const turn2: BaseEvent[] = [];
    await agent.runAgent(
      {},
      {
        onEvent: ({ event }) => {
          turn2.push(event);
        },
      },
    );

    const turn2Started = turn2.find((e) => e.type === EventType.RUN_STARTED) as RunStartedEvent &
      { parentRunId?: string };
    expect(turn2Started).toBeDefined();
    expect(turn2Started.parentRunId).toBe(turn1Started.runId);
    expect(turn2Started.runId).not.toBe(turn1Started.runId);

    expect(collectText(turn2).length).toBeGreaterThan(0);
  });
});

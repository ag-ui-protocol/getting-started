import { describe, expect, it } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";
import { LangGraphEventTypes } from "./types";

/**
 * End-to-end wiring: drive the real `handleSingleEvent` chunk handler with
 * fake final chunks (carrying `usage_metadata` + `finish_reason`, as LangChain
 * delivers them) and assert `collectRunUsage()` — the exact value spread onto
 * RUN_FINISHED — reflects the aggregated usage.
 */
function makeAgent(): any {
  const agent: any = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });
  agent.activeRun = {
    id: "run-1",
    threadId: "t-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
    usage: [],
  };
  return agent;
}

function finishChunkEvent(usageMetadata: any, provider: string, model: string) {
  return {
    event: LangGraphEventTypes.OnChatModelStream,
    metadata: {
      ls_provider: provider,
      ls_model_name: model,
      "emit-messages": true,
      "emit-tool-calls": true,
    },
    data: {
      chunk: {
        response_metadata: { finish_reason: "stop" },
        tool_call_chunks: [],
        usage_metadata: usageMetadata,
        content: "",
        id: "msg-1",
      },
    },
  };
}

describe("LangGraph usage wiring", () => {
  it("captures single-call usage and surfaces it via collectRunUsage", () => {
    const agent = makeAgent();
    agent.handleSingleEvent(
      finishChunkEvent(
        { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        "anthropic",
        "claude-sonnet-4",
      ),
    );
    const usage = agent.collectRunUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0].provider).toBe("anthropic");
    expect(usage[0].totalTokens).toBe(150);
  });

  it("aggregates multiple calls to the same model", () => {
    const agent = makeAgent();
    for (let i = 0; i < 2; i++) {
      agent.handleSingleEvent(
        finishChunkEvent(
          { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          "openai",
          "gpt-4o",
        ),
      );
    }
    const usage = agent.collectRunUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0].inputTokens).toBe(200);
    expect(usage[0].totalTokens).toBe(240);
  });

  it("returns undefined when no usage was reported", () => {
    const agent = makeAgent();
    expect(agent.collectRunUsage()).toBeUndefined();
  });
});

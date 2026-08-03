import { describe, expect, it, vi } from "vitest";
import { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import { A2AMiddlewareAgent } from "../index";

vi.mock("@a2a-js/sdk/client", () => {
  class A2AClient {
    url: string;

    constructor(url: string) {
      this.url = url;
    }

    getAgentCard = vi.fn(async () => ({
      name: this.url,
      description: `Card for ${this.url}`,
      skills: [],
    }));
  }

  return { A2AClient };
});

class CloneableAgent extends AbstractAgent {
  cloneCount = 0;

  run(_input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>();
  }

  clone() {
    this.cloneCount += 1;
    return Object.assign(super.clone(), {
      cloneCount: this.cloneCount,
    });
  }
}

describe("A2AMiddlewareAgent clone", () => {
  it("preserves config and clones owned mutable containers", async () => {
    const orchestrationAgent = new CloneableAgent({
      description: "orchestrator",
    });
    const agent = new A2AMiddlewareAgent({
      agentUrls: ["http://agent-a.example", "http://agent-b.example"],
      instructions: "Route tasks to remote agents.",
      orchestrationAgent,
      description: "a2a middleware",
    });

    const cloned = agent.clone() as A2AMiddlewareAgent;

    expect(cloned).toBeInstanceOf(A2AMiddlewareAgent);
    expect(cloned).not.toBe(agent);
    expect(cloned.description).toBe(agent.description);
    expect(cloned.instructions).toBe(agent.instructions);
    expect(cloned.agentClients).toEqual(agent.agentClients);
    expect(cloned.agentClients).not.toBe(agent.agentClients);
    expect(cloned.orchestrationAgent).toBeInstanceOf(CloneableAgent);
    expect(cloned.orchestrationAgent).not.toBe(agent.orchestrationAgent);
    expect(orchestrationAgent.cloneCount).toBe(1);

    const originalCards = await agent.agentCards;
    const clonedCards = await cloned.agentCards;

    expect(cloned.agentCards).not.toBe(agent.agentCards);
    expect(clonedCards).toEqual(originalCards);
    expect(clonedCards).not.toBe(originalCards);
  });
});

import { AbstractAgent } from "../agent";
import { HttpAgent } from "../http";
import { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import { EMPTY, Observable } from "rxjs";

class CloneableTestAgent extends AbstractAgent {
  constructor() {
    super({
      agentId: "test-agent",
      description: "Cloneable test agent",
      threadId: "thread-test",
      initialMessages: [
        {
          id: "msg-1",
          role: "user",
          content: "Hello world",
          toolCalls: [],
        } as Message,
      ],
      initialState: { stage: "initial" },
    });
  }

  run(_: RunAgentInput): Observable<BaseEvent> {
    return EMPTY as Observable<BaseEvent>;
  }
}

describe("AbstractAgent cloning", () => {
  it("clones subclass instances with independent state", () => {
    const agent = new CloneableTestAgent();

    const cloned = agent.clone() as CloneableTestAgent;

    expect(cloned).toBeInstanceOf(CloneableTestAgent);
    expect(cloned).not.toBe(agent);
    expect(cloned.agentId).toBe(agent.agentId);
    expect(cloned.threadId).toBe(agent.threadId);
    expect(cloned.messages).toEqual(agent.messages);
    expect(cloned.messages).not.toBe(agent.messages);
    expect(cloned.state).toEqual(agent.state);
    expect(cloned.state).not.toBe(agent.state);
  });
});

describe("HttpAgent cloning", () => {
  it("produces a new HttpAgent with cloned configuration and abort controller", () => {
    const httpAgent = new HttpAgent({
      url: "https://example.com/agent",
      headers: { Authorization: "Bearer token" },
      threadId: "thread-http",
      initialMessages: [
        {
          id: "msg-http",
          role: "assistant",
          content: "response",
          toolCalls: [],
        } as Message,
      ],
      initialState: { status: "ready" },
    });

    httpAgent.abortController.abort("cancelled");

    const cloned = httpAgent.clone() as HttpAgent;

    expect(cloned).toBeInstanceOf(HttpAgent);
    expect(cloned).not.toBe(httpAgent);
    expect(cloned.url).toBe(httpAgent.url);
    expect(cloned.headers).toEqual(httpAgent.headers);
    expect(cloned.headers).not.toBe(httpAgent.headers);
    expect(cloned.messages).toEqual(httpAgent.messages);
    expect(cloned.messages).not.toBe(httpAgent.messages);
    expect(cloned.state).toEqual(httpAgent.state);
    expect(cloned.state).not.toBe(httpAgent.state);
    expect(cloned.abortController).not.toBe(httpAgent.abortController);
    expect(cloned.abortController).toBeInstanceOf(AbortController);
    expect(cloned.abortController.signal.aborted).toBe(true);
    expect(cloned.abortController.signal.reason).toBe("cancelled");
  });
});

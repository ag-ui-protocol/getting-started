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

  it("keeps public methods bound on new and cloned agents", () => {
    const agent = new CloneableTestAgent();

    for (const target of [agent, agent.clone()]) {
      const { subscribe, use, addMessage, addMessages, setMessages, setState } = target;
      const subscription = subscribe({});

      expect(use((input: RunAgentInput, next: AbstractAgent) => next.run(input))).toBe(target);
      addMessage({ id: "msg-2", role: "user", content: "Second" });
      addMessages([{ id: "msg-3", role: "user", content: "Third" }]);
      setMessages([{ id: "msg-4", role: "user", content: "Fourth" }]);
      setState({ stage: "updated" });

      expect(target.messages).toHaveLength(1);
      expect(target.messages[0].id).toBe("msg-4");
      expect(target.state).toEqual({ stage: "updated" });
      subscription.unsubscribe();
    }
  });

  it("binds subclass overrides", () => {
    class OverridingAgent extends CloneableTestAgent {
      calls = 0;

      override addMessage(message: Message) {
        this.calls++;
        super.addMessage(message);
      }
    }

    const agent = new OverridingAgent();
    const { addMessage } = agent;

    addMessage({ id: "msg-2", role: "user", content: "Second" });

    expect(agent.calls).toBe(1);
    expect(agent.messages).toHaveLength(2);
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

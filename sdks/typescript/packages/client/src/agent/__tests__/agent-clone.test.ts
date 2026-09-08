import { AbstractAgent } from "../agent";
import { HttpAgent } from "../http";
import { BaseEvent, Message, RunAgentInput } from "@ag-ui/core";
import { EMPTY, Observable, Subscriber } from "rxjs";
import { EventType, RunStartedEvent } from "@ag-ui/core";

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

/**
 * A clone manages its own active run. Detaching one agent must not detach
 * another agent, including the source from which it was cloned.
 */
describe("a clone's in-flight runs", () => {
  interface Opened {
    owner: AbstractAgent;
    subscriber: Subscriber<BaseEvent>;
    tornDown: boolean;
  }
  /** Module-scoped, because a clone gets none of the source's own fields. */
  let opened: Opened[] = [];

  class HangingAgent extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        const entry: Opened = { owner: this, subscriber, tornDown: false };
        opened.push(entry);
        const started: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        };
        subscriber.next(started);
        return () => {
          entry.tornDown = true;
        };
      });
    }
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function waitForOpen(owner: AbstractAgent): Promise<Opened> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const entry = opened.find((candidate) => candidate.owner === owner);
      if (entry) return entry;
      await tick();
    }
    throw new Error("the run never opened");
  }

  beforeEach(() => {
    opened = [];
  });

  it("detaches on the clone without touching the source, and vice versa", async () => {
    const source = new HangingAgent();
    const cloned = source.clone();

    const sourceRun = source.runAgent({ runId: "clone-source" });
    const sourceEntry = await waitForOpen(source);
    const clonedRun = cloned.runAgent({ runId: "clone-copy" });
    const clonedEntry = await waitForOpen(cloned);

    // Two distinct runs, one per agent.
    expect(sourceEntry).not.toBe(clonedEntry);

    await cloned.detachActiveRun();
    expect(clonedEntry.tornDown).toBe(true);
    expect(sourceEntry.tornDown).toBe(false);
    await clonedRun;

    await source.detachActiveRun();
    expect(sourceEntry.tornDown).toBe(true);
    await sourceRun;
  });

  it("does not inherit the source's active run", async () => {
    const source = new HangingAgent();
    const sourceRun = source.runAgent({ runId: "clone-source-2" });
    const sourceEntry = await waitForOpen(source);

    // Cloning while a run is in flight must not give the clone its handle.
    const cloned = source.clone();
    await cloned.detachActiveRun();

    expect(sourceEntry.tornDown).toBe(false);

    await source.detachActiveRun();
    expect(sourceEntry.tornDown).toBe(true);
    await sourceRun;
  });
});

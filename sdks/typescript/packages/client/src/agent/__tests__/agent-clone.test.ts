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
 * A clone's runs are ITS OWN.
 *
 * `clone()` builds the copy with `Object.create`, which runs no class field
 * initialisers, so every field has to be assigned by hand — `activeRuns`
 * included. Left out, the clone has no set at all and its first run throws on
 * `this.activeRuns.add(...)`; shared with the source, detaching one agent tears
 * down the other's in-flight runs.
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
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as RunStartedEvent);
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
    const cloned = source.clone() as HangingAgent;

    const sourceRun = source.runAgent({ runId: "clone-source" });
    const sourceEntry = await waitForOpen(source);
    const clonedRun = cloned.runAgent({ runId: "clone-copy" });
    const clonedEntry = await waitForOpen(cloned);

    // Two distinct runs, one per agent — not one set shared between them.
    expect(sourceEntry).not.toBe(clonedEntry);

    await cloned.detachActiveRun();
    expect(clonedEntry.tornDown).toBe(true);
    expect(sourceEntry.tornDown).toBe(false);
    await clonedRun;

    await source.detachActiveRun();
    expect(sourceEntry.tornDown).toBe(true);
    await sourceRun;
  });

  it("gives the clone an EMPTY set, not a share of the source's", async () => {
    const source = new HangingAgent();
    const sourceRun = source.runAgent({ runId: "clone-source-2" });
    const sourceEntry = await waitForOpen(source);

    // Cloned WHILE a run is in flight. A shared set would hand that run to the
    // clone, so the clone's detach — which has nothing of its own to detach —
    // would tear down the source's run.
    const cloned = source.clone() as HangingAgent;
    await cloned.detachActiveRun();

    expect(sourceEntry.tornDown).toBe(false);

    await source.detachActiveRun();
    expect(sourceEntry.tornDown).toBe(true);
    await sourceRun;
  });
});

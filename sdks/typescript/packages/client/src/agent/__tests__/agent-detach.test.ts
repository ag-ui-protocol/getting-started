import { Observable, of, Subscriber } from "rxjs";
import { AbstractAgent } from "@/agent";
import {
  BaseEvent,
  EventType,
  MessagesSnapshotEvent,
  RunAgentInput,
  RunFinishedEvent,
  RunStartedEvent,
} from "@ag-ui/core";

/** Emits RUN_STARTED and stays open until detached. */
class HangingAgent extends AbstractAgent {
  public open: Array<Subscriber<BaseEvent>> = [];
  public teardowns = 0;

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.open.push(subscriber);
      const started: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      };
      subscriber.next(started);
      return () => {
        this.teardowns += 1;
      };
    });
  }

  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    return this.run(input);
  }
}

class StartupFailureAgent extends AbstractAgent {
  private attempts = 0;

  run(input: RunAgentInput): Observable<BaseEvent> {
    if (++this.attempts === 1) throw new Error("startup failed");
    const started: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    };
    const finished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    };
    return of(started, finished);
  }
}

async function waitForRuns(agent: HangingAgent, count: number): Promise<void> {
  await vi.waitFor(() => expect(agent.open).toHaveLength(count));
}

describe("single-run detachment", () => {
  it.each(["runAgent", "connectAgent"] as const)(
    "detaches %s before reusing the agent and ignores the old stream",
    async (method) => {
      const agent = new HangingAgent({ debug: false });
      const onRunFinalized = vi.fn();
      const first = agent[method]({ runId: "detach-first" }, { onRunFinalized });
      await waitForRuns(agent, 1);

      await agent.detachActiveRun();
      await first;

      expect(agent.teardowns).toBe(1);
      expect(agent.isRunning).toBe(false);
      expect(onRunFinalized).toHaveBeenCalledTimes(1);

      const second = agent[method]({ runId: "detach-second" });
      await waitForRuns(agent, 2);
      const staleSnapshot: MessagesSnapshotEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "stale", role: "assistant", content: "Must be ignored" }],
      };
      agent.open[0].next(staleSnapshot);
      expect(agent.messages).toEqual([]);
      expect(agent.isRunning).toBe(true);

      await agent.detachActiveRun();
      await second;
      expect(agent.teardowns).toBe(2);
      expect(agent.isRunning).toBe(false);
    },
  );

  it("is a no-op when idle and does not affect a later run", async () => {
    const agent = new HangingAgent({ debug: false });
    await agent.detachActiveRun();
    expect(agent.open).toHaveLength(0);
    expect(agent.teardowns).toBe(0);

    const later = agent.runAgent({ runId: "after-idle-detach" });
    await waitForRuns(agent, 1);
    expect(agent.teardowns).toBe(0);

    await agent.detachActiveRun();
    await later;
    expect(agent.teardowns).toBe(1);
  });

  it("can detach after recovering from a synchronous startup failure", async () => {
    const agent = new StartupFailureAgent({ debug: false });
    await expect(agent.runAgent()).rejects.toThrow("startup failed");
    await expect(agent.runAgent()).resolves.toEqual({ result: undefined, newMessages: [] });
    expect(agent.isRunning).toBe(false);
    await expect(agent.detachActiveRun()).resolves.toBeUndefined();
  });
});

import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import { vi } from "vitest";
import {
  BaseEvent,
  EventType,
  Message,
  RunAgentInput,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  SubagentErrorEvent,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import { AgentSubscriber } from "@/agent/subscriber";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

describe("defaultApplyEvents with subagent lifecycle events", () => {
  it("should invoke onSubagentStartedEvent, onSubagentErrorEvent, and onSubagentFinishedEvent hooks", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const onSubagentStartedEvent = vi.fn();
    const onSubagentFinishedEvent = vi.fn();
    const onSubagentErrorEvent = vi.fn();

    const subscriber: AgentSubscriber = {
      onSubagentStartedEvent,
      onSubagentFinishedEvent,
      onSubagentErrorEvent,
    };

    const agent = createAgent(initialState.messages);
    const result$ = defaultApplyEvents(initialState, events$, agent, [subscriber]);

    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.SUBAGENT_STARTED,
      subagentId: "s1",
      name: "R",
    } as SubagentStartedEvent);
    events$.next({
      type: EventType.SUBAGENT_ERROR,
      subagentId: "s1",
      message: "x",
    } as SubagentErrorEvent);
    events$.next({
      type: EventType.SUBAGENT_FINISHED,
      subagentId: "s1",
    } as SubagentFinishedEvent);

    await new Promise((resolve) => setTimeout(resolve, 10));
    events$.complete();

    await stateUpdatesPromise;

    expect(onSubagentStartedEvent).toHaveBeenCalledTimes(1);
    expect(onSubagentErrorEvent).toHaveBeenCalledTimes(1);
    expect(onSubagentFinishedEvent).toHaveBeenCalledTimes(1);

    expect(onSubagentStartedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: EventType.SUBAGENT_STARTED,
          subagentId: "s1",
          name: "R",
        }),
      }),
    );
    expect(onSubagentErrorEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: EventType.SUBAGENT_ERROR,
          subagentId: "s1",
          message: "x",
        }),
      }),
    );
    expect(onSubagentFinishedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: EventType.SUBAGENT_FINISHED,
          subagentId: "s1",
        }),
      }),
    );
  });
});

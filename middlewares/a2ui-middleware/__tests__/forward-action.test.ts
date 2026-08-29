import { describe, it, expect } from "vitest";
import {
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
} from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";
import {
  A2UIMiddleware,
  LOG_A2UI_EVENT_TOOL_NAME,
  RENDER_A2UI_TOOL_NAME,
} from "../src/index";

/**
 * Forward (LLM-side) action contract: a native `action.event` button click is
 * forwarded by the renderer as `forwardedProps.a2uiAction.userAction`, and the
 * middleware lowers it into synthetic messages the agent's next LLM turn reads.
 * This locks that inbound transform (the deterministic half of the forward
 * round-trip verified end-to-end during OSS-165 v2). See PNI-106 for formalizing
 * this consumption + the v1.0 actionResponse/actionId round-trip.
 */

class CapturingAgent extends AbstractAgent {
  runCalls: RunAgentInput[] = [];
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runCalls.push(input);
    return new Observable((s) => {
      s.next({
        type: EventType.RUN_STARTED,
        runId: input.runId,
        threadId: input.threadId,
      } as BaseEvent);
      s.next({
        type: EventType.RUN_FINISHED,
        runId: input.runId,
        threadId: input.threadId,
      } as BaseEvent);
      s.complete();
    });
  }
}

function makeInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t",
    runId: "r",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
    ...overrides,
  };
}
const collect = (o: Observable<BaseEvent>) => firstValueFrom(o.pipe(toArray()));

describe("A2UIMiddleware — forward action (LLM-side) inbound contract", () => {
  const userAction = {
    name: "book_flight",
    surfaceId: "flights",
    sourceComponentId: "book-btn",
    context: { flightId: "AA123", price: "$412" },
    timestamp: "2026-07-23T10:00:00Z",
  };

  it("lowers a forwarded a2uiAction into a log_a2ui_event call + a human-readable result the agent reads", async () => {
    const mw = new A2UIMiddleware({ injectA2UITool: true });
    const agent = new CapturingAgent();

    await collect(
      mw.run(
        makeInput({
          messages: [
            { id: "u1", role: "user", content: "comparing flights" } as any,
          ],
          forwardedProps: { a2uiAction: { userAction } },
        }),
        agent,
      ),
    );

    const seen = agent.runCalls[0];

    // Structured action is preserved verbatim in the synthetic tool call.
    const toolCall = seen.messages.find(
      (m: any) =>
        m.role === "assistant" &&
        m.toolCalls?.some(
          (tc: any) => tc.function?.name === LOG_A2UI_EVENT_TOOL_NAME,
        ),
    ) as any;
    expect(toolCall).toBeTruthy();
    expect(JSON.parse(toolCall.toolCalls[0].function.arguments)).toMatchObject(
      userAction,
    );

    // Human-readable result the LLM reads, carrying name + context.
    const result = seen.messages.find(
      (m: any) =>
        m.role === "tool" && /User performed action/.test(m.content ?? ""),
    ) as any;
    expect(result).toBeTruthy();
    expect(result.content).toContain("book_flight");
    expect(result.content).toContain("AA123");

    // The agent can respond WITH a new surface on this same turn.
    expect(
      (seen.tools ?? []).some((t: any) => t.name === RENDER_A2UI_TOOL_NAME),
    ).toBe(true);
  });

  it("injects no synthetic action messages when no a2uiAction is forwarded", async () => {
    const mw = new A2UIMiddleware({ injectA2UITool: true });
    const agent = new CapturingAgent();

    await collect(
      mw.run(
        makeInput({
          messages: [{ id: "u1", role: "user", content: "hi" } as any],
        }),
        agent,
      ),
    );

    const seen = agent.runCalls[0];
    expect(
      seen.messages.some(
        (m: any) =>
          m.role === "tool" && /User performed action/.test(m.content ?? ""),
      ),
    ).toBe(false);
  });
});

import { AbstractAgent } from "@/agent";
import { FilterToolCallsMiddleware } from "@/middleware/filter-tool-calls";
import {
  BaseEvent,
  EventType,
  RunAgentInput,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

describe("FilterToolCallsMiddleware", () => {
  class ToolCallingAgent extends AbstractAgent {
    run(input: RunAgentInput): Observable<BaseEvent> {
      return new Observable<BaseEvent>((subscriber) => {
        // Emit RUN_STARTED
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });

        // Emit first tool call (calculator)
        const toolCall1Id = "tool-call-1";
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall1Id,
          toolCallName: "calculator",
          parentMessageId: "message-1",
        } as ToolCallStartEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall1Id,
          delta: '{"operation": "add", "a": 5, "b": 3}',
        } as ToolCallArgsEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: toolCall1Id,
        } as ToolCallEndEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tool-message-1",
          toolCallId: toolCall1Id,
          content: "8",
        } as ToolCallResultEvent);

        // Emit second tool call (weather)
        const toolCall2Id = "tool-call-2";
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall2Id,
          toolCallName: "weather",
          parentMessageId: "message-2",
        } as ToolCallStartEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall2Id,
          delta: '{"city": "New York"}',
        } as ToolCallArgsEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: toolCall2Id,
        } as ToolCallEndEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tool-message-2",
          toolCallId: toolCall2Id,
          content: "Sunny, 72°F",
        } as ToolCallResultEvent);

        // Emit third tool call (search)
        const toolCall3Id = "tool-call-3";
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCall3Id,
          toolCallName: "search",
          parentMessageId: "message-3",
        } as ToolCallStartEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: toolCall3Id,
          delta: '{"query": "TypeScript middleware"}',
        } as ToolCallArgsEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: toolCall3Id,
        } as ToolCallEndEvent);

        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          messageId: "tool-message-3",
          toolCallId: toolCall3Id,
          content: "Results found...",
        } as ToolCallResultEvent);

        // Emit RUN_FINISHED
        subscriber.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        });

        subscriber.complete();
      });
    }
  }

  const input: RunAgentInput = {
    threadId: "test-thread",
    runId: "test-run",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
  };

  it("should filter out disallowed tool calls", async () => {
    const agent = new ToolCallingAgent();
    const middleware = new FilterToolCallsMiddleware({
      disallowedToolCalls: ["calculator", "search"],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Should have RUN_STARTED, weather tool events (4), and RUN_FINISHED
    expect(events.length).toBe(6);

    // Check that we have RUN_STARTED
    expect(events[0].type).toBe(EventType.RUN_STARTED);

    // Check that only weather tool calls are present
    const toolCallStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as ToolCallStartEvent[];
    expect(toolCallStarts.length).toBe(1);
    expect(toolCallStarts[0].toolCallName).toBe("weather");

    // Check that calculator and search are filtered out
    const allToolNames = toolCallStarts.map((e) => e.toolCallName);
    expect(allToolNames).not.toContain("calculator");
    expect(allToolNames).not.toContain("search");

    // Check that we have RUN_FINISHED
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("should allow only allowed tool calls when using allowlist", async () => {
    const agent = new ToolCallingAgent();
    const middleware = new FilterToolCallsMiddleware({
      allowedToolCalls: ["calculator"],
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve) => {
      middleware.run(input, agent).subscribe({
        next: (event) => events.push(event),
        complete: () => resolve(),
      });
    });

    // Should have RUN_STARTED, calculator tool events (4), and RUN_FINISHED
    expect(events.length).toBe(6);

    const toolCallStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as ToolCallStartEvent[];
    expect(toolCallStarts.length).toBe(1);
    expect(toolCallStarts[0].toolCallName).toBe("calculator");
  });
});

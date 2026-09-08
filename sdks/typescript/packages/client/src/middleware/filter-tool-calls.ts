import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import {
  RunAgentInput,
  BaseEvent,
  EventType,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
} from "@ag-ui/core";
import { defer, Observable } from "rxjs";
import { filter } from "rxjs/operators";

type FilterToolCallsConfig =
  | { allowedToolCalls: string[]; disallowedToolCalls?: never }
  | { disallowedToolCalls: string[]; allowedToolCalls?: never };

export class FilterToolCallsMiddleware extends Middleware {
  private readonly allowedTools?: Set<string>;
  private readonly disallowedTools?: Set<string>;

  constructor(config: FilterToolCallsConfig) {
    super();

    // Runtime validation (belt and suspenders approach)
    if (config.allowedToolCalls && config.disallowedToolCalls) {
      throw new Error("Cannot specify both allowedToolCalls and disallowedToolCalls");
    }

    if (!config.allowedToolCalls && !config.disallowedToolCalls) {
      throw new Error("Must specify either allowedToolCalls or disallowedToolCalls");
    }

    if (config.allowedToolCalls) {
      this.allowedTools = new Set(config.allowedToolCalls);
    } else if (config.disallowedToolCalls) {
      this.disallowedTools = new Set(config.disallowedToolCalls);
    }
  }

  /**
   * One middleware instance serves every run, so the set of blocked IDs cannot live on it.
   *
   * A stalled run whose subscription is still open is the case that makes this concrete: with the
   * set on the instance, the next run starting wipes the IDs that were still filtering the stalled
   * run's events, and its `TOOL_CALL_ARGS`, `TOOL_CALL_END` and `TOOL_CALL_RESULT` start coming
   * through for a tool the caller disallowed. Clearing at the end of a run has the same problem
   * from the other direction.
   *
   * `defer` gives each subscription its own set, and `RUN_STARTED` resets it, which is what covers
   * two runs arriving down one subscription: `run()` is called once there, so anything keyed to the
   * call rather than to the event never fires for the second run.
   */
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return defer(() => {
      const blockedToolCallIds = new Set<string>();

      // Use runNext which already includes transformChunks
      return this.runNext(input, next).pipe(
        filter((event) => {
          // A run boundary invalidates any IDs left over from a run that was interrupted before
          // its TOOL_CALL_RESULT arrived, and stops a reused tool call ID being shadowed by one.
          if (event.type === EventType.RUN_STARTED) {
            blockedToolCallIds.clear();
            return true;
          }

          // Handle TOOL_CALL_START events
          if (event.type === EventType.TOOL_CALL_START) {
            const toolCallStartEvent = event as ToolCallStartEvent;
            const shouldFilter = this.shouldFilterTool(toolCallStartEvent.toolCallName);

            if (shouldFilter) {
              // Track this tool call ID as blocked
              blockedToolCallIds.add(toolCallStartEvent.toolCallId);
              return false; // Filter out this event
            }

            return true; // Allow this event
          }

          // Handle TOOL_CALL_ARGS events
          if (event.type === EventType.TOOL_CALL_ARGS) {
            const toolCallArgsEvent = event as ToolCallArgsEvent;
            return !blockedToolCallIds.has(toolCallArgsEvent.toolCallId);
          }

          // Handle TOOL_CALL_END events
          if (event.type === EventType.TOOL_CALL_END) {
            const toolCallEndEvent = event as ToolCallEndEvent;
            return !blockedToolCallIds.has(toolCallEndEvent.toolCallId);
          }

          // Handle TOOL_CALL_RESULT events
          if (event.type === EventType.TOOL_CALL_RESULT) {
            const toolCallResultEvent = event as ToolCallResultEvent;
            const isBlocked = blockedToolCallIds.has(toolCallResultEvent.toolCallId);

            if (isBlocked) {
              // Clean up the blocked ID after the last event
              blockedToolCallIds.delete(toolCallResultEvent.toolCallId);
              return false;
            }

            return true;
          }

          // Allow all other events through
          return true;
        }),
      );
    });
  }

  private shouldFilterTool(toolName: string): boolean {
    if (this.allowedTools) {
      // If using allowed list, filter out tools NOT in the list
      return !this.allowedTools.has(toolName);
    } else if (this.disallowedTools) {
      // If using disallowed list, filter out tools IN the list
      return this.disallowedTools.has(toolName);
    }

    return false;
  }
}

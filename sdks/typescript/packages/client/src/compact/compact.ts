import {
  BaseEvent,
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
} from "@ag-ui/core";
import jsonpatch from "fast-json-patch";
import { structuredClone_ } from "../utils";

/**
 * Compacts streaming events by consolidating multiple deltas into single events.
 * For text messages: multiple content deltas become one concatenated delta.
 * For tool calls: multiple args deltas become one concatenated delta.
 * For state: all STATE_SNAPSHOT and STATE_DELTA events within a run are compacted
 *   into a single STATE_SNAPSHOT representing the final state.
 * Events between related streaming events are reordered to keep streaming events together.
 *
 * @param events - Array of events to compact
 * @returns Compacted array of events
 */
export function compactEvents(events: BaseEvent[]): BaseEvent[] {
  const compacted: BaseEvent[] = [];
  const pendingTextMessages = new Map<
    string,
    {
      start?: TextMessageStartEvent;
      contents: TextMessageContentEvent[];
      end?: TextMessageEndEvent;
      otherEvents: BaseEvent[];
    }
  >();
  const pendingToolCalls = new Map<
    string,
    {
      start?: ToolCallStartEvent;
      args: ToolCallArgsEvent[];
      end?: ToolCallEndEvent;
      otherEvents: BaseEvent[];
    }
  >();

  // State compaction: collects state events, flushed at RUN_STARTED (pre-run/inter-run), RUN_FINISHED/RUN_ERROR (in-run), and at end (trailing)
  let stateEvents: (StateSnapshotEvent | StateDeltaEvent)[] = [];
  // Running state carried across flushState calls so a STATE_DELTA in a
  // later flush (e.g. run 2 without its own STATE_SNAPSHOT) can target
  // paths established by an earlier flush (e.g. run 1's snapshot).
  // Without this seed, the per-flush `state = {}` reset turned valid
  // multi-run streams into OPERATION_PATH_CANNOT_ADD failures. See #1720.
  let runningState: any = {};

  for (const event of events) {
    // Handle text message streaming events
    if (event.type === EventType.TEXT_MESSAGE_START) {
      const startEvent = event as TextMessageStartEvent;
      const messageId = startEvent.messageId;

      if (!pendingTextMessages.has(messageId)) {
        pendingTextMessages.set(messageId, {
          contents: [],
          otherEvents: [],
        });
      }

      const pending = pendingTextMessages.get(messageId)!;
      pending.start = startEvent;
    } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      const contentEvent = event as TextMessageContentEvent;
      const messageId = contentEvent.messageId;

      if (!pendingTextMessages.has(messageId)) {
        pendingTextMessages.set(messageId, {
          contents: [],
          otherEvents: [],
        });
      }

      const pending = pendingTextMessages.get(messageId)!;
      pending.contents.push(contentEvent);
    } else if (event.type === EventType.TEXT_MESSAGE_END) {
      const endEvent = event as TextMessageEndEvent;
      const messageId = endEvent.messageId;

      if (!pendingTextMessages.has(messageId)) {
        pendingTextMessages.set(messageId, {
          contents: [],
          otherEvents: [],
        });
      }

      const pending = pendingTextMessages.get(messageId)!;
      pending.end = endEvent;

      // Flush this message's events
      flushTextMessage(messageId, pending, compacted);
      pendingTextMessages.delete(messageId);
    } else if (event.type === EventType.TOOL_CALL_START) {
      const startEvent = event as ToolCallStartEvent;
      const toolCallId = startEvent.toolCallId;

      if (!pendingToolCalls.has(toolCallId)) {
        pendingToolCalls.set(toolCallId, {
          args: [],
          otherEvents: [],
        });
      }

      const pending = pendingToolCalls.get(toolCallId)!;
      pending.start = startEvent;
    } else if (event.type === EventType.TOOL_CALL_ARGS) {
      const argsEvent = event as ToolCallArgsEvent;
      const toolCallId = argsEvent.toolCallId;

      if (!pendingToolCalls.has(toolCallId)) {
        pendingToolCalls.set(toolCallId, {
          args: [],
          otherEvents: [],
        });
      }

      const pending = pendingToolCalls.get(toolCallId)!;
      pending.args.push(argsEvent);
    } else if (event.type === EventType.TOOL_CALL_END) {
      const endEvent = event as ToolCallEndEvent;
      const toolCallId = endEvent.toolCallId;

      if (!pendingToolCalls.has(toolCallId)) {
        pendingToolCalls.set(toolCallId, {
          args: [],
          otherEvents: [],
        });
      }

      const pending = pendingToolCalls.get(toolCallId)!;
      pending.end = endEvent;

      // Flush this tool call's events
      flushToolCall(toolCallId, pending, compacted);
      pendingToolCalls.delete(toolCallId);
    } else if (event.type === EventType.RUN_STARTED) {
      // Flush any pre-run state events before starting a new run
      runningState = flushState(stateEvents, compacted, runningState);
      stateEvents = [];
      compacted.push(event);
    } else if (
      event.type === EventType.RUN_FINISHED ||
      event.type === EventType.RUN_ERROR
    ) {
      // Flush compacted state into output before the run boundary event
      runningState = flushState(stateEvents, compacted, runningState);
      stateEvents = [];
      compacted.push(event);
    } else if (
      event.type === EventType.STATE_SNAPSHOT ||
      event.type === EventType.STATE_DELTA
    ) {
      // Collect state events for compaction
      stateEvents.push(event as StateSnapshotEvent | StateDeltaEvent);
    } else {
      // For non-streaming events, check if we're in the middle of any streaming sequences
      let addedToBuffer = false;

      // Check text messages
      for (const [messageId, pending] of pendingTextMessages) {
        // If we have a start but no end yet, this event is "in between"
        if (pending.start && !pending.end) {
          pending.otherEvents.push(event);
          addedToBuffer = true;
          break;
        }
      }

      // Check tool calls if not already buffered
      if (!addedToBuffer) {
        for (const [toolCallId, pending] of pendingToolCalls) {
          // If we have a start but no end yet, this event is "in between"
          if (pending.start && !pending.end) {
            pending.otherEvents.push(event);
            addedToBuffer = true;
            break;
          }
        }
      }

      // If not in the middle of any streaming sequence, add directly to compacted
      if (!addedToBuffer) {
        compacted.push(event);
      }
    }
  }

  // Flush any remaining incomplete messages
  for (const [messageId, pending] of pendingTextMessages) {
    flushTextMessage(messageId, pending, compacted);
  }

  // Flush any remaining incomplete tool calls
  for (const [toolCallId, pending] of pendingToolCalls) {
    flushToolCall(toolCallId, pending, compacted);
  }

  // Flush any remaining state events (incomplete run or events outside runs)
  flushState(stateEvents, compacted, runningState);

  return compacted;
}

function flushTextMessage(
  messageId: string,
  pending: {
    start?: TextMessageStartEvent;
    contents: TextMessageContentEvent[];
    end?: TextMessageEndEvent;
    otherEvents: BaseEvent[];
  },
  compacted: BaseEvent[],
): void {
  // Add start event if present
  if (pending.start) {
    compacted.push(pending.start);
  }

  // Compact all content events into one
  if (pending.contents.length > 0) {
    const concatenatedDelta = pending.contents.map((c) => c.delta).join("");

    const compactedContent: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: messageId,
      delta: concatenatedDelta,
    };

    compacted.push(compactedContent);
  }

  // Add end event if present
  if (pending.end) {
    compacted.push(pending.end);
  }

  // Add any events that were in between
  for (const otherEvent of pending.otherEvents) {
    compacted.push(otherEvent);
  }
}

function flushToolCall(
  toolCallId: string,
  pending: {
    start?: ToolCallStartEvent;
    args: ToolCallArgsEvent[];
    end?: ToolCallEndEvent;
    otherEvents: BaseEvent[];
  },
  compacted: BaseEvent[],
): void {
  // Add start event if present
  if (pending.start) {
    compacted.push(pending.start);
  }

  // Compact all args events into one
  if (pending.args.length > 0) {
    const concatenatedArgs = pending.args.map((a) => a.delta).join("");

    const compactedArgs: ToolCallArgsEvent = {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: toolCallId,
      delta: concatenatedArgs,
    };

    compacted.push(compactedArgs);
  }

  // Add end event if present
  if (pending.end) {
    compacted.push(pending.end);
  }

  // Add any events that were in between
  for (const otherEvent of pending.otherEvents) {
    compacted.push(otherEvent);
  }
}

function flushState(
  stateEvents: (StateSnapshotEvent | StateDeltaEvent)[],
  compacted: BaseEvent[],
  initialState: any = {},
): any {
  if (stateEvents.length === 0) {
    // Nothing changed; the prior batch's running state is still current.
    return initialState;
  }

  // Seed from the prior batch instead of `{}`. STATE_SNAPSHOT in this
  // batch still replaces wholesale (existing semantics); STATE_DELTA
  // applies on top of whatever the prior batch produced — so a delta
  // referencing a path established by an earlier flush no longer
  // raises OPERATION_PATH_CANNOT_ADD on a phantom empty document.
  // See issue #1720 for the breakage mode this guards against.
  let state: any = structuredClone_(initialState);

  for (const event of stateEvents) {
    if (event.type === EventType.STATE_SNAPSHOT) {
      state = structuredClone_(event.snapshot);
    } else {
      const result = jsonpatch.applyPatch(state, structuredClone_(event.delta), true, false);
      state = result.newDocument;
    }
  }

  const compactedSnapshot: StateSnapshotEvent = {
    type: EventType.STATE_SNAPSHOT,
    snapshot: state,
  };

  compacted.push(compactedSnapshot);
  return state;
}

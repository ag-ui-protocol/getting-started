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
 * For state: STATE_SNAPSHOT and STATE_DELTA events are applied cumulatively across
 *   the event history and compacted into STATE_SNAPSHOT events at run boundaries.
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
  let state: Record<string, unknown> = {};

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
      state = flushState(stateEvents, state, compacted);
      stateEvents = [];
      compacted.push(event);
    } else if (
      event.type === EventType.RUN_FINISHED ||
      event.type === EventType.RUN_ERROR
    ) {
      // Flush compacted state into output before the run boundary event
      state = flushState(stateEvents, state, compacted);
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
      for (const [, pending] of pendingTextMessages) {
        // If we have a start but no end yet, this event is "in between"
        if (pending.start && !pending.end) {
          pending.otherEvents.push(event);
          addedToBuffer = true;
          break;
        }
      }

      // Check tool calls if not already buffered
      if (!addedToBuffer) {
        for (const [, pending] of pendingToolCalls) {
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
  flushState(stateEvents, state, compacted);

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
  state: Record<string, unknown>,
  compacted: BaseEvent[],
): Record<string, unknown> {
  if (stateEvents.length === 0) {
    return state;
  }

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
    snapshot: structuredClone_(state),
  };

  compacted.push(compactedSnapshot);
  return state;
}

import {
  BaseEvent,
  EventType,
  type Metadata,
  mergeMetadata,
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
 * Folds the metadata of a run of events being replaced by one synthesized
 * event, so compacting a stream does not change the metadata a consumer ends up
 * with. Same last-write-wins, replace-wholesale rule the reducer applies, which
 * is what makes a compacted replay agree with the original stream.
 *
 * Ordering note. Compaction deliberately reorders events to keep each stream's
 * events together: a buffer flushes when its END arrives, and any non-streaming
 * event that arrived mid-stream is emitted after it.
 *
 * That reordering is not semantics-preserving in general, and this predates
 * metadata. A MESSAGES_SNAPSHOT interrupting a text stream is emitted after the
 * stream's own events, so on replay it overwrites what they produced — the
 * appended content as much as the merged metadata.
 *
 * What metadata does not add is any *new* order sensitivity. Every merge
 * destination is unique — each message has its own, and each tool call carries
 * its own rather than folding into the parent it may share — so two events that
 * merge into the same target are never reordered relative to each other.
 * Ordering within a buffer is preserved as well; see `postStartMetadata`, which
 * keeps deltas and replayed starts in arrival order.
 */
function carryStartMetadata<T extends BaseEvent>(previous: T | undefined, next: T): T {
  if (previous === undefined) {
    return next;
  }

  // A start event can be replayed before its end — the HITL re-sync path does
  // this, which is why the reducer's start handling is idempotent. Uncompacted,
  // both starts merge into the message; keep that true after compaction instead
  // of letting the later start silently replace the earlier one's keys.
  const metadata = mergeMetadata(previous.metadata, next.metadata);
  return metadata === undefined ? next : { ...next, metadata };
}

/**
 * Applies a start replayed *after* deltas have been buffered.
 *
 * Its non-metadata fields win — the reducer deliberately renames an existing
 * tool call on such a replay, so dropping them would make a compacted replay
 * disagree. Its metadata does not ride the start, because compaction emits the
 * start ahead of the collapsed delta event; the caller stages that separately so
 * arrival order is preserved.
 */
function replaceStartFields<T extends BaseEvent>(previous: T | undefined, next: T): T {
  const { metadata: _replayMetadata, ...fields } = next as T & { metadata?: Metadata };
  const carried = previous?.metadata;
  return (carried === undefined ? fields : { ...fields, metadata: carried }) as T;
}

function collapseMetadata(events: BaseEvent[]): Metadata | undefined {
  let merged: Metadata | undefined;
  for (const event of events) {
    merged = mergeMetadata(merged, event.metadata);
  }
  return merged;
}

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
      postStartMetadata?: Metadata;
    }
  >();
  const pendingToolCalls = new Map<
    string,
    {
      start?: ToolCallStartEvent;
      args: ToolCallArgsEvent[];
      end?: ToolCallEndEvent;
      otherEvents: BaseEvent[];
      postStartMetadata?: Metadata;
    }
  >();

  // State compaction: collects state events, flushed at RUN_STARTED (pre-run/inter-run), RUN_FINISHED/RUN_ERROR (in-run), and at end (trailing)
  let stateEvents: (StateSnapshotEvent | StateDeltaEvent)[] = [];

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
      if (pending.contents.length === 0) {
        pending.start = carryStartMetadata(pending.start, startEvent);
      } else {
        // Compaction hoists START ahead of the collapsed delta event, so a start
        // replayed after deltas keeps its fields but stages its metadata.
        pending.start = replaceStartFields(pending.start, startEvent);
        pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, startEvent.metadata);
      }
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
      pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, contentEvent.metadata);
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
      if (pending.args.length === 0) {
        pending.start = carryStartMetadata(pending.start, startEvent);
      } else {
        // Same ordering rule as the text case above.
        pending.start = replaceStartFields(pending.start, startEvent);
        pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, startEvent.metadata);
      }
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
      pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, argsEvent.metadata);
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
      flushState(stateEvents, compacted);
      stateEvents = [];
      compacted.push(event);
    } else if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      // Flush compacted state into output before the run boundary event
      flushState(stateEvents, compacted);
      stateEvents = [];
      compacted.push(event);
    } else if (event.type === EventType.STATE_SNAPSHOT || event.type === EventType.STATE_DELTA) {
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
  flushState(stateEvents, compacted);

  return compacted;
}

function flushTextMessage(
  messageId: string,
  pending: {
    start?: TextMessageStartEvent;
    contents: TextMessageContentEvent[];
    end?: TextMessageEndEvent;
    otherEvents: BaseEvent[];
    postStartMetadata?: Metadata;
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

    const collapsedMetadata = pending.postStartMetadata;

    const compactedContent: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: messageId,
      delta: concatenatedDelta,
      ...(collapsedMetadata !== undefined && { metadata: collapsedMetadata }),
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
    postStartMetadata?: Metadata;
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

    const collapsedMetadata = pending.postStartMetadata;

    const compactedArgs: ToolCallArgsEvent = {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: toolCallId,
      delta: concatenatedArgs,
      ...(collapsedMetadata !== undefined && { metadata: collapsedMetadata }),
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

/**
 * Compaction's warnings, behind the same switch as the rest of the package.
 * `SUPPRESS_TRANSFORMATION_WARNINGS` is the one control an operator has over
 * transformation chatter (enforce.ts, transform/proto.ts and the compatibility
 * middlewares all honour it); a warning that ignored it was unsilenceable.
 */
const warnCompact = (message: string): void => {
  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    Boolean(process.env.SUPPRESS_TRANSFORMATION_WARNINGS)
  ) {
    return;
  }
  console.warn(message);
};

function flushState(
  stateEvents: (StateSnapshotEvent | StateDeltaEvent)[],
  compacted: BaseEvent[],
): void {
  if (stateEvents.length === 0) {
    return;
  }

  // A window with no SNAPSHOT in it cannot be collapsed into one. Collapsing
  // `SNAPSHOT + deltas` is sound because the snapshot states the whole
  // document and the deltas refine it. Deltas ALONE are relative to a state
  // this window never saw, so seeding `{}` and calling the result a snapshot
  // manufactures an authoritative claim that everything else was absent —
  // replaying it wipes state the consumer legitimately holds from before the
  // window. Passed through unchanged instead: two deltas are barely worth
  // collapsing anyway, and correctness is not negotiable for the saving.
  // The LAST snapshot, not merely "is there one": everything before it is
  // unobservable by definition, because a snapshot restates the whole document
  // and replaces whatever the deltas ahead of it had built. Folding those
  // deltas anyway applied them to the seeded `{}`, where their paths do not
  // resolve — `applyPatch` validates, so it threw, and the catch below warned
  // about a patch whose failure changed nothing. Right answer, wrong
  // diagnosis. Starting at the last snapshot means the catch only ever fires
  // for a patch that genuinely could not be applied to the state it names.
  //
  // A reverse loop rather than `findLastIndex`: this package targets es2017,
  // and the method is ES2023.
  let lastSnapshot = -1;
  for (let index = stateEvents.length - 1; index >= 0; index--) {
    if (stateEvents[index].type === EventType.STATE_SNAPSHOT) {
      lastSnapshot = index;
      break;
    }
  }
  if (lastSnapshot === -1) {
    compacted.push(...stateEvents);
    return;
  }

  // From here the window DOES contain a snapshot, so it collapses exactly as
  // it always has: seeding `{}` is harmless because the snapshot replaces the
  // document wholesale before anything relative is applied to it.
  let state: Record<string, unknown> = {};

  for (const event of stateEvents.slice(lastSnapshot)) {
    if (event.type === EventType.STATE_SNAPSHOT) {
      state = structuredClone_(event.snapshot);
    } else {
      // Uncaught, a single unappliable patch took down every consumer that
      // compacts a stream — `applyPatch` validates, so it THROWS rather than
      // answering falsy. Warned and skipped, matching the reducer in
      // apply/default.ts, which faces exactly the same failure.
      try {
        state = jsonpatch.applyPatch(state, structuredClone_(event.delta), true, false)
          .newDocument;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        warnCompact(
          `[ag-ui][compact] Failed to apply state patch while compacting:\nCurrent state: ${JSON.stringify(state, null, 2)}\nPatch operations: ${JSON.stringify(event.delta, null, 2)}\nError: ${errorMessage}`,
        );
      }
    }
  }

  const collapsedMetadata = collapseMetadata(stateEvents);

  const compactedSnapshot: StateSnapshotEvent = {
    type: EventType.STATE_SNAPSHOT,
    snapshot: state,
    ...(collapsedMetadata !== undefined && { metadata: collapsedMetadata }),
  };

  compacted.push(compactedSnapshot);
}

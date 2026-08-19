import {
  Middleware,
  AbstractAgent,
  BaseEvent,
  EventType,
  RunAgentInput,
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  ReasoningMessageChunkEvent,
} from "@ag-ui/client";
import { Observable } from "rxjs";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface EventThrottleConfig {
  /** Time-based throttle window in ms (e.g. 16 = ~60fps). */
  readonly intervalMs: number;
  /** Min new TEXT_MESSAGE_CHUNK characters to accumulate before flushing. Default: 0. */
  readonly minChunkSize?: number;
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/**
 * Events that may be safely buffered and coalesced. Everything NOT in this set
 * passes through immediately (flushing any pending buffer first).
 *
 * This is an allowlist so that new event types added to the protocol default to
 * immediate passthrough — the safer failure mode for boundary/lifecycle events.
 */
const BUFFERABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  EventType.TEXT_MESSAGE_CHUNK,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TOOL_CALL_CHUNK,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.MESSAGES_SNAPSHOT,
  EventType.ACTIVITY_SNAPSHOT,
  EventType.ACTIVITY_DELTA,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.RAW,
]);

// ---------------------------------------------------------------------------
// Chunk type guards
// ---------------------------------------------------------------------------

function isTextChunk(event: BaseEvent): event is TextMessageChunkEvent {
  return event.type === EventType.TEXT_MESSAGE_CHUNK;
}

function isToolCallChunk(event: BaseEvent): event is ToolCallChunkEvent {
  return event.type === EventType.TOOL_CALL_CHUNK;
}

function isReasoningChunk(
  event: BaseEvent,
): event is ReasoningMessageChunkEvent {
  return event.type === EventType.REASONING_MESSAGE_CHUNK;
}

/**
 * Fold one chunk's metadata into another's, key by key, last write winning.
 *
 * Deliberately inlined rather than importing `mergeMetadata` from `@ag-ui/client`:
 * this package declares a peer range of `>=0.0.40`, and that export only exists
 * from the release that introduced metadata. Importing it would break every
 * installation on an admitted older client — a missing named export under ESM,
 * or a call to `undefined` under CJS. The rule is a shallow spread, so keeping a
 * local copy costs nothing; `mergeMetadata` in `@ag-ui/core` remains canonical.
 */
function mergeChunkMetadata(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (next === undefined) return previous;
  if (previous === undefined) return { ...next };
  return { ...previous, ...next };
}

/**
 * Return the coalescence key for a chunk event, or null if not coalescable.
 *
 * Chunks are only merged within one subagent lane: coalescing across owners
 * would erase the ownership contradiction the client verifier exists to
 * reject (same entity id, two owners) and silently merge their metadata. An
 * untagged continuation therefore does not coalesce into its tagged opener —
 * it still coalesces with its untagged neighbours, and the chunk transform
 * resolves its owner from the opener downstream.
 *
 * The key is JSON-encoded rather than delimiter-joined: owner and entity ids
 * are unconstrained strings, so any separator could occur inside either
 * component and alias two distinct (owner, id) pairs onto one key. JSON also
 * keeps absent attribution (null) distinct from an explicit empty-string id.
 */
function chunkKey(
  event: BaseEvent,
): string | null {
  const owner = (event as { subagentRunId?: string }).subagentRunId ?? null;
  if (isTextChunk(event)) return event.messageId ? JSON.stringify(["text", owner, event.messageId]) : null;
  if (isToolCallChunk(event)) return event.toolCallId ? JSON.stringify(["tool", owner, event.toolCallId]) : null;
  if (isReasoningChunk(event)) return event.messageId ? JSON.stringify(["reasoning", owner, event.messageId]) : null;
  return null;
}

/** Return the delta string for any chunk event, or null. */
function chunkDelta(event: BaseEvent): string | null {
  if (isTextChunk(event)) return event.delta ?? null;
  if (isToolCallChunk(event)) return event.delta ?? null;
  if (isReasoningChunk(event)) return event.delta ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export class EventThrottleMiddleware extends Middleware {
  private readonly intervalMs: number;
  private readonly minChunkSize: number;
  private readonly isNoop: boolean;

  constructor(config: EventThrottleConfig) {
    super();

    const { intervalMs, minChunkSize } = config;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error(
        `intervalMs must be a non-negative finite number, got ${intervalMs}`,
      );
    }
    if (
      minChunkSize !== undefined &&
      (!Number.isFinite(minChunkSize) || minChunkSize < 0)
    ) {
      throw new Error(
        `minChunkSize must be a non-negative finite number, got ${minChunkSize}`,
      );
    }

    this.intervalMs = intervalMs;
    this.minChunkSize = minChunkSize ?? 0;
    this.isNoop = intervalMs <= 0 && this.minChunkSize <= 0;
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Use next.run() directly instead of this.runNext() because runNext applies
    // transformChunks, which converts chunk events (TEXT_MESSAGE_CHUNK,
    // TOOL_CALL_CHUNK, REASONING_MESSAGE_CHUNK) into expanded START/CONTENT/END
    // sequences. This middleware needs the raw chunk events intact so it can
    // buffer and coalesce them before they reach downstream consumers.
    const events$ = next.run(input);

    if (this.isNoop) {
      return events$;
    }

    const intervalMs = this.intervalMs;
    const minChunkSize = this.minChunkSize;

    return new Observable<BaseEvent>((subscriber) => {
      let buffer: BaseEvent[] = [];
      let lastFlushTime = 0;
      let charsSinceFlush = 0;
      let lastTrackedMessageId: string | null = null;
      let timerId: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        if (buffer.length === 0) return;

        const batch = buffer;
        buffer = [];
        charsSinceFlush = 0;
        lastFlushTime = Date.now();

        // Coalesce consecutive chunk events with the same key (messageId or
        // toolCallId) into a single chunk with combined delta.
        // Non-chunk events and chunks with undefined IDs pass through as-is.
        const coalesced: BaseEvent[] = [];
        for (const event of batch) {
          const key = chunkKey(event);
          if (key !== null) {
            const last = coalesced[coalesced.length - 1];
            const lastKey = last ? chunkKey(last) : null;
            if (last && lastKey === key) {
              // Merge delta into the previous chunk
              const prevDelta = chunkDelta(last) ?? "";
              const curDelta = chunkDelta(event) ?? "";
              const merged = prevDelta + curDelta;
              if (isTextChunk(last)) last.delta = merged;
              else if (isToolCallChunk(last)) last.delta = merged;
              else if (isReasoningChunk(last)) last.delta = merged;

              // Keeping only the first chunk's fields is right for role, name
              // and toolCallName — they appear on the first chunk. Metadata is
              // the opposite: it is designed to arrive last, carrying usage and
              // the finish reason, so it merges key by key with the last write
              // winning, matching the reducer. Dropping it here would swallow a
              // trailing usage-only chunk before transformChunks ever sees it.
              const mergedMetadata = mergeChunkMetadata(
                last.metadata as Record<string, unknown> | undefined,
                event.metadata as Record<string, unknown> | undefined,
              );
              if (mergedMetadata !== undefined) {
                last.metadata = mergedMetadata;
              }
            } else {
              // Push a shallow copy so we don't mutate the original event
              coalesced.push({ ...event } as BaseEvent);
            }
          } else {
            coalesced.push(event);
          }
        }

        for (const event of coalesced) {
          subscriber.next(event);
        }
      };

      const scheduleTrailing = () => {
        if (timerId !== null) return;
        if (intervalMs <= 0) return;
        const elapsed = Date.now() - lastFlushTime;
        const remaining = Math.max(0, intervalMs - elapsed);
        timerId = setTimeout(() => {
          timerId = null;
          try {
            flush();
          } catch (err) {
            buffer = [];
            subscriber.error(err);
          }
        }, remaining);
      };

      const sub = events$.subscribe({
        next: (event) => {
          // Immediate events flush the buffer first, then pass through directly
          if (!BUFFERABLE_EVENT_TYPES.has(event.type)) {
            try {
              flush();
            } catch (err) {
              buffer = [];
              subscriber.error(err);
              return;
            }
            subscriber.next(event);
            // Reset lastFlushTime so the time-based throttle window restarts from this point
            lastFlushTime = Date.now();
            return;
          }

          buffer.push(event);

          // Track character accumulation for text chunk events
          if (isTextChunk(event) && minChunkSize > 0) {
            const messageId = event.messageId ?? null;
            if (messageId !== lastTrackedMessageId) {
              lastTrackedMessageId = messageId;
              charsSinceFlush = 0;
            }
            charsSinceFlush += (event.delta ?? "").length;
          }

          // Check thresholds
          const isLeading = lastFlushTime === 0;
          const timeThresholdMet =
            intervalMs > 0 && Date.now() - lastFlushTime >= intervalMs;
          const chunkThresholdMet =
            minChunkSize > 0 && charsSinceFlush >= minChunkSize;

          if (isLeading || timeThresholdMet || chunkThresholdMet) {
            try {
              flush();
            } catch (err) {
              buffer = [];
              subscriber.error(err);
              return;
            }
          } else {
            scheduleTrailing();
          }
        },
        error: (err) => {
          // Discard buffer on error — delivering partially buffered events
          // could produce incomplete event sequences
          buffer = [];
          if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
          }
          subscriber.error(err);
        },
        complete: () => {
          // Flush remaining on completion
          try {
            flush();
          } catch (err) {
            subscriber.error(err);
            return;
          }
          subscriber.complete();
        },
      });

      // Teardown
      return () => {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        sub.unsubscribe();
      };
    });
  }
}

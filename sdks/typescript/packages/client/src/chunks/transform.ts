import { mergeMap, Observable, finalize } from "rxjs";
import {
  BaseEvent,
  TextMessageChunkEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallChunkEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  ReasoningMessageChunkEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
} from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

interface TextMessageFields {
  messageId: string;
  name?: string;
  subagentRunId?: string;
}

interface ToolCallFields {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
  subagentRunId?: string;
}

interface ReasoningMessageFields {
  messageId: string;
  subagentRunId?: string;
}

/**
 * The stream one lane is currently assembling from chunks. A lane holds at most one,
 * because the chunk shorthand identifies a continuation only by "the same as before".
 */
type PendingStream =
  | { kind: "text"; fields: TextMessageFields }
  | { kind: "tool"; fields: ToolCallFields }
  | { kind: "reasoning"; fields: ReasoningMessageFields };

/** The id a pending stream is keyed by, whichever kind it is. */
const pendingEntityId = (pending: PendingStream): string =>
  pending.kind === "tool" ? pending.fields.toolCallId : pending.fields.messageId;

const missingIdFieldName = (kind: PendingStream["kind"]) =>
  kind === "tool" ? "toolCallId" : "messageId";

/**
 * Spreads a chunk's metadata onto an event synthesized from that chunk.
 *
 * Applied to every event derived from a chunk, never to the synthetic `*_END`
 * that closes the *previous* message — that is what stops a chunk's metadata
 * leaking onto the message it is closing when one chunk ends one message and
 * begins another.
 *
 * A chunk that expands into both a start and a content event stamps the same
 * metadata twice. That is harmless: the merge is last-write-wins per key, so
 * applying an identical object twice is indistinguishable from applying it once,
 * and stamping both is what keeps the metadata attached when only one of the two
 * is emitted.
 */
const withChunkMetadata = <T extends BaseEvent>(event: T, chunk: BaseEvent): T =>
  chunk.metadata === undefined ? event : { ...event, metadata: chunk.metadata };

export const transformChunks =
  (debugLogger?: DebugLoggerInput) =>
  (events$: Observable<BaseEvent>): Observable<BaseEvent> => {
    const log = resolveDebugLogger(debugLogger);

    // One pending stream per LANE, where a lane is the subagent its chunks are attributed
    // to and `undefined` is the parent agent. A single global slot meant only one stream
    // could be mid-assembly per run, so two subagents streaming concurrently destroyed
    // each other: the second chunk's opener closed the first's message, and because
    // continuation chunks omit the id, the first subagent's next chunk then failed
    // outright. Keyed by owner, each lane assembles independently. A run that never
    // attributes anything uses only the `undefined` lane, so its behaviour is unchanged.
    const lanes = new Map<string | undefined, PendingStream>();

    /** Emit the END for whatever `owner` has open, and clear the lane. */
    const closeLane = (owner: string | undefined): BaseEvent[] => {
      const pending = lanes.get(owner);
      if (!pending) return [];
      lanes.delete(owner);

      switch (pending.kind) {
        case "text": {
          const event = {
            type: EventType.TEXT_MESSAGE_END,
            messageId: pending.fields.messageId,
            ...(pending.fields.subagentRunId != null && {
              subagentRunId: pending.fields.subagentRunId,
            }),
          } as TextMessageEndEvent;
          log?.event("TRANSFORM", "TEXT_MESSAGE_END", event, { messageId: event.messageId });
          return [event];
        }
        case "tool": {
          const event = {
            type: EventType.TOOL_CALL_END,
            toolCallId: pending.fields.toolCallId,
            ...(pending.fields.subagentRunId != null && {
              subagentRunId: pending.fields.subagentRunId,
            }),
          } as ToolCallEndEvent;
          log?.event("TRANSFORM", "TOOL_CALL_END", event, { toolCallId: event.toolCallId });
          return [event];
        }
        case "reasoning": {
          const event = {
            type: EventType.REASONING_MESSAGE_END,
            messageId: pending.fields.messageId,
            ...(pending.fields.subagentRunId != null && {
              subagentRunId: pending.fields.subagentRunId,
            }),
          } as ReasoningMessageEndEvent;
          log?.event("TRANSFORM", "REASONING_MESSAGE_END", event, { messageId: event.messageId });
          return [event];
        }
      }
    };

    /**
     * Close every lane, in the order they opened. Used by the run-level events, which
     * describe the run as a whole rather than any one producer within it.
     */
    const closeAllLanes = (): BaseEvent[] =>
      [...lanes.keys()].flatMap((owner) => closeLane(owner));

    /** The lane holding an open stream of `kind` under `entityId`, if any. */
    const laneHolding = (kind: PendingStream["kind"], entityId: string) => {
      for (const [owner, pending] of lanes) {
        if (pending.kind === kind && pendingEntityId(pending) === entityId) return { owner };
      }
      return undefined;
    };

    /**
     * Decide which lane a chunk belongs to. Every chunk carries its own `subagentRunId`,
     * which is what makes per-lane assembly possible at all — but the shorthand lets a
     * continuation omit both the id and the tag, so the lane has to be inferred.
     */
    const resolveLane = (
      kind: PendingStream["kind"],
      entityId: string | undefined,
      tag: string | undefined,
      chunkType: string,
      entityKind: string,
    ): string | undefined => {
      if (entityId !== undefined) {
        // A named id continues wherever it is already open, regardless of who sends it,
        // so the id remains the strongest signal. A tag that disagrees with that lane is
        // the contradiction the continuation-owner rule forbids: rejected here rather
        // than left to verifyEvents, because a chunk carrying attribution but no delta
        // synthesizes nothing, so the disagreement would never reach the verifier.
        const holder = laneHolding(kind, entityId);
        if (holder) {
          if (tag !== undefined && tag !== holder.owner) {
            throw new Error(
              `Cannot continue ${entityKind} '${entityId}': chunk subagentRunId '${tag}' does not match the open stream's subagent '${holder.owner ?? "(the parent agent)"}'.`,
            );
          }
          return holder.owner;
        }
        // An id nobody holds opens a new stream, in the lane its own tag names.
        return tag;
      }

      // Continuation shorthand. A tag names its lane outright.
      if (tag !== undefined) return tag;

      // Untagged means the parent agent, so prefer the parent's own open stream.
      const parentPending = lanes.get(undefined);
      if (parentPending?.kind === kind) return undefined;

      // Otherwise fall back to the sole open stream of this kind, so producers that
      // attribute only the opening chunk keep working. This is not overriding the
      // untagged-means-parent rule above: an id-less chunk can never OPEN a stream
      // (a first chunk must carry its id — the caller throws), so when the parent has
      // no stream of this kind to continue, the sole open stream is the chunk's only
      // possible referent. The alternatives are continuing it or failing a stream
      // that is perfectly legal for an opener-only-tagging producer whose parent
      // happens to have a different-kind stream in flight.
      const candidates = [...lanes.entries()].filter(([, pending]) => pending.kind === kind);
      if (candidates.length === 1) return candidates[0][0];
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous ${chunkType}: it carries neither a ${missingIdFieldName(kind)} nor a subagentRunId, but ${candidates.length} lanes have an open ${entityKind}. Attribute the chunk to the subagent it belongs to.`,
        );
      }
      // No lane has an open stream of this kind, so there is nothing to continue: the
      // caller opens a new stream in the parent lane, or reports the missing id.
      return undefined;
    };

    return events$.pipe(
      mergeMap((event) => {
        switch (event.type) {
          case EventType.TEXT_MESSAGE_START:
          case EventType.TEXT_MESSAGE_CONTENT:
          case EventType.TEXT_MESSAGE_END:
          case EventType.TOOL_CALL_START:
          case EventType.TOOL_CALL_ARGS:
          case EventType.TOOL_CALL_END:
          case EventType.TOOL_CALL_RESULT:
          case EventType.STATE_SNAPSHOT:
          case EventType.STATE_DELTA:
          case EventType.CUSTOM:
          case EventType.STEP_STARTED:
          case EventType.STEP_FINISHED:
          case EventType.THINKING_START:
          case EventType.THINKING_END:
          case EventType.THINKING_TEXT_MESSAGE_START:
          case EventType.THINKING_TEXT_MESSAGE_CONTENT:
          case EventType.THINKING_TEXT_MESSAGE_END:
          case EventType.REASONING_START:
          case EventType.REASONING_MESSAGE_START:
          case EventType.REASONING_MESSAGE_CONTENT:
          case EventType.REASONING_MESSAGE_END:
          case EventType.REASONING_END:
            // An explicit event closes only ITS OWN lane's pending stream. Closing the
            // single global stream meant a parent's TEXT_MESSAGE_START ended a subagent's
            // half-assembled message — the same class of cross-lane damage as closing on
            // an unrelated subagent's terminal. Events that carry no tag read as the
            // parent lane, which is what they are.
            return [...closeLane((event as { subagentRunId?: string | null }).subagentRunId ?? undefined), event];
          // Run-level events describe the run as a whole rather than any one producer
          // within it, so every lane closes — otherwise a subagent's chunk stream would
          // outlive the run that carried it. MESSAGES_SNAPSHOT belongs here too: it
          // restates the entire conversation, and attributes per message rather than
          // carrying one owner of its own.
          case EventType.RUN_STARTED:
          case EventType.RUN_FINISHED:
          case EventType.RUN_ERROR:
          case EventType.MESSAGES_SNAPSHOT:
            return [...closeAllLanes(), event];
          case EventType.RAW:
          case EventType.ACTIVITY_SNAPSHOT:
          case EventType.ACTIVITY_DELTA:
          case EventType.REASONING_ENCRYPTED_VALUE:
          case EventType.SUBAGENT_STARTED:
            return [event];
          // A subagent's terminal event closes any stream still being assembled from
          // chunks. Passing these through untouched left the pending message open, so
          // its synthesized END — which carries the opener's subagentRunId — was emitted
          // later, by the run terminal or the next non-chunk event, i.e. after that
          // subagent had already finished. The verifier tolerates such a tag by
          // design, so this is not about validity: it is that a message this
          // transform synthesized should not be closed on behalf of an owner that
          // has already ended, since a consumer grouping by subagent would attach it
          // to a group it had already marked complete.
          case EventType.SUBAGENT_FINISHED:
          case EventType.SUBAGENT_ERROR: {
            // Its own lane only. A terminal with no id is malformed and must not be read
            // as closing the parent lane — a runtime null reads the same as absent.
            const terminalOwner = (event as { subagentRunId?: string | null }).subagentRunId;
            if (terminalOwner == null) return [event];
            return [...closeLane(terminalOwner), event];
          }
          case EventType.TEXT_MESSAGE_CHUNK: {
            const messageChunkEvent = event as TextMessageChunkEvent;
            const lane = resolveLane(
              "text",
              messageChunkEvent.messageId,
              messageChunkEvent.subagentRunId ?? undefined,
              "TEXT_MESSAGE_CHUNK",
              "text message",
            );
            const open = lanes.get(lane);
            const textMessageResult: BaseEvent[] = [];

            let textMessageFields: TextMessageFields;
            if (
              open?.kind === "text" &&
              // An absent id continues; a present one must be the same message.
              (messageChunkEvent.messageId === undefined ||
                messageChunkEvent.messageId === open.fields.messageId)
            ) {
              textMessageFields = open.fields;
            } else {
              // Whatever else this lane had open ends before the new stream begins.
              textMessageResult.push(...closeLane(lane));

              if (messageChunkEvent.messageId === undefined) {
                throw new Error("First TEXT_MESSAGE_CHUNK must have a messageId");
              }

              textMessageFields = {
                messageId: messageChunkEvent.messageId,
                name: messageChunkEvent.name,
                subagentRunId: messageChunkEvent.subagentRunId,
              };
              lanes.set(lane, { kind: "text", fields: textMessageFields });

              const textMessageStartEvent = withChunkMetadata(
                {
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: messageChunkEvent.messageId,
                  role: messageChunkEvent.role || "assistant",
                  ...(messageChunkEvent.name !== undefined && { name: messageChunkEvent.name }),
                  ...(messageChunkEvent.subagentRunId != null && {
                    subagentRunId: messageChunkEvent.subagentRunId,
                  }),
                } as TextMessageStartEvent,
                messageChunkEvent,
              );

              textMessageResult.push(textMessageStartEvent);

              log?.event("TRANSFORM", "TEXT_MESSAGE_START", textMessageStartEvent, {
                messageId: messageChunkEvent.messageId,
              });
            }

            if (messageChunkEvent.delta !== undefined) {
              const contentOwner = messageChunkEvent.subagentRunId ?? textMessageFields.subagentRunId;
              const textMessageContentEvent = withChunkMetadata(
                {
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: textMessageFields.messageId,
                  delta: messageChunkEvent.delta,
                  // Prefer the INCOMING chunk's tag over the opener's, so a producer that
                  // attributes every chunk sees its own attribution on the output rather
                  // than a value this transform remembered.
                  ...(contentOwner != null && { subagentRunId: contentOwner }),
                } as TextMessageContentEvent,
                messageChunkEvent,
              );

              textMessageResult.push(textMessageContentEvent);

              log?.event("TRANSFORM", "TEXT_MESSAGE_CONTENT", textMessageContentEvent, {
                messageId: textMessageFields.messageId,
              });
            }

            // A continuation chunk carrying only metadata — a final chunk with
            // usage and a finish reason, the case the merge design exists for —
            // synthesizes nothing above. Emit a zero-delta content event so the
            // metadata still reaches the reducer. It cannot ride the synthetic
            // `*_END` instead: `finalize` discards the events it creates, so the
            // last message of a stream would lose it.
            if (textMessageResult.length === 0 && messageChunkEvent.metadata !== undefined) {
              // Attribution follows the same rule as the delta path above: the
              // incoming chunk's tag first, the opener's owner as fallback —
              // a metadata-only continuation is still the lane's event.
              const metadataOwner =
                messageChunkEvent.subagentRunId ?? textMessageFields!.subagentRunId;
              textMessageResult.push({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: textMessageFields!.messageId,
                delta: "",
                metadata: messageChunkEvent.metadata,
                ...(metadataOwner != null && { subagentRunId: metadataOwner }),
              } as TextMessageContentEvent);
            }
            return textMessageResult;
          }
          case EventType.TOOL_CALL_CHUNK: {
            const toolCallChunkEvent = event as ToolCallChunkEvent;
            const lane = resolveLane(
              "tool",
              toolCallChunkEvent.toolCallId,
              toolCallChunkEvent.subagentRunId ?? undefined,
              "TOOL_CALL_CHUNK",
              "tool call",
            );
            const open = lanes.get(lane);
            const toolMessageResult: BaseEvent[] = [];

            let toolCallFields: ToolCallFields;
            if (
              open?.kind === "tool" &&
              (toolCallChunkEvent.toolCallId === undefined ||
                toolCallChunkEvent.toolCallId === open.fields.toolCallId)
            ) {
              toolCallFields = open.fields;
            } else {
              toolMessageResult.push(...closeLane(lane));

              if (toolCallChunkEvent.toolCallId === undefined) {
                throw new Error("First TOOL_CALL_CHUNK must have a toolCallId");
              }
              if (toolCallChunkEvent.toolCallName === undefined) {
                throw new Error("First TOOL_CALL_CHUNK must have a toolCallName");
              }
              toolCallFields = {
                toolCallId: toolCallChunkEvent.toolCallId,
                toolCallName: toolCallChunkEvent.toolCallName,
                parentMessageId: toolCallChunkEvent.parentMessageId,
                subagentRunId: toolCallChunkEvent.subagentRunId,
              };
              lanes.set(lane, { kind: "tool", fields: toolCallFields });

              const toolCallStartEvent = withChunkMetadata(
                {
                  type: EventType.TOOL_CALL_START,
                  toolCallId: toolCallChunkEvent.toolCallId,
                  toolCallName: toolCallChunkEvent.toolCallName,
                  parentMessageId: toolCallChunkEvent.parentMessageId,
                  ...(toolCallChunkEvent.subagentRunId != null && {
                    subagentRunId: toolCallChunkEvent.subagentRunId,
                  }),
                } as ToolCallStartEvent,
                toolCallChunkEvent,
              );

              toolMessageResult.push(toolCallStartEvent);

              log?.event("TRANSFORM", "TOOL_CALL_START", toolCallStartEvent, {
                toolCallId: toolCallChunkEvent.toolCallId,
                toolCallName: toolCallChunkEvent.toolCallName,
              });
            }

            if (toolCallChunkEvent.delta !== undefined) {
              const argsOwner = toolCallChunkEvent.subagentRunId ?? toolCallFields.subagentRunId;
              const toolCallArgsEvent = withChunkMetadata(
                {
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: toolCallFields.toolCallId,
                  delta: toolCallChunkEvent.delta,
                  // Prefer the INCOMING chunk's tag over the opener's, so a producer that
                  // attributes every chunk sees its own attribution on the output rather
                  // than a value this transform remembered.
                  ...(argsOwner != null && { subagentRunId: argsOwner }),
                } as ToolCallArgsEvent,
                toolCallChunkEvent,
              );

              toolMessageResult.push(toolCallArgsEvent);

              log?.event("TRANSFORM", "TOOL_CALL_ARGS", toolCallArgsEvent, {
                toolCallId: toolCallFields.toolCallId,
              });
            }

            // Same as the text case above.
            if (toolMessageResult.length === 0 && toolCallChunkEvent.metadata !== undefined) {
              // Same attribution rule as the args path above.
              const metadataOwner =
                toolCallChunkEvent.subagentRunId ?? toolCallFields!.subagentRunId;
              toolMessageResult.push({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: toolCallFields!.toolCallId,
                delta: "",
                metadata: toolCallChunkEvent.metadata,
                ...(metadataOwner != null && { subagentRunId: metadataOwner }),
              } as ToolCallArgsEvent);
            }
            return toolMessageResult;
          }
          case EventType.REASONING_MESSAGE_CHUNK: {
            const reasoningChunkEvent = event as ReasoningMessageChunkEvent;
            const lane = resolveLane(
              "reasoning",
              reasoningChunkEvent.messageId,
              reasoningChunkEvent.subagentRunId ?? undefined,
              "REASONING_MESSAGE_CHUNK",
              "reasoning message",
            );
            const open = lanes.get(lane);
            const reasoningMessageResult: BaseEvent[] = [];

            let reasoningMessageFields: ReasoningMessageFields;
            if (
              open?.kind === "reasoning" &&
              // `!== undefined`, not truthiness, to match the text and tool branches: an
              // explicitly empty id is a present id that denotes a NEW stream, and
              // treating it as absent left this pointing at the previous message and
              // stamped its content with the new chunk's owner.
              (reasoningChunkEvent.messageId === undefined ||
                reasoningChunkEvent.messageId === open.fields.messageId)
            ) {
              reasoningMessageFields = open.fields;
            } else {
              reasoningMessageResult.push(...closeLane(lane));

              if (reasoningChunkEvent.messageId === undefined) {
                throw new Error("First REASONING_MESSAGE_CHUNK must have a messageId");
              }

              reasoningMessageFields = {
                messageId: reasoningChunkEvent.messageId,
                subagentRunId: reasoningChunkEvent.subagentRunId,
              };
              lanes.set(lane, { kind: "reasoning", fields: reasoningMessageFields });

              const reasoningMessageStartEvent = withChunkMetadata(
                {
                  type: EventType.REASONING_MESSAGE_START,
                  messageId: reasoningChunkEvent.messageId,
                  role: "reasoning",
                  ...(reasoningChunkEvent.subagentRunId != null && {
                    subagentRunId: reasoningChunkEvent.subagentRunId,
                  }),
                } as ReasoningMessageStartEvent,
                reasoningChunkEvent,
              );
              reasoningMessageResult.push(reasoningMessageStartEvent);

              log?.event("TRANSFORM", "REASONING_MESSAGE_START", reasoningMessageStartEvent, {
                messageId: reasoningChunkEvent.messageId,
              });
            }

            if (reasoningChunkEvent.delta !== undefined) {
              const contentOwner =
                reasoningChunkEvent.subagentRunId ?? reasoningMessageFields.subagentRunId;
              const reasoningMessageContentEvent = withChunkMetadata(
                {
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageFields.messageId,
                  delta: reasoningChunkEvent.delta,
                  // Prefer the INCOMING chunk's tag over the opener's, so a producer that
                  // attributes every chunk sees its own attribution on the output rather
                  // than a value this transform remembered.
                  ...(contentOwner != null && { subagentRunId: contentOwner }),
                } as ReasoningMessageContentEvent,
                reasoningChunkEvent,
              );

              reasoningMessageResult.push(reasoningMessageContentEvent);

              log?.event("TRANSFORM", "REASONING_MESSAGE_CONTENT", reasoningMessageContentEvent, {
                messageId: reasoningMessageFields.messageId,
              });
            }

            // Same as the text case above.
            if (reasoningMessageResult.length === 0 && reasoningChunkEvent.metadata !== undefined) {
              // Same attribution rule as the content path above.
              const metadataOwner =
                reasoningChunkEvent.subagentRunId ?? reasoningMessageFields!.subagentRunId;
              reasoningMessageResult.push({
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: reasoningMessageFields!.messageId,
                delta: "",
                metadata: reasoningChunkEvent.metadata,
                ...(metadataOwner != null && { subagentRunId: metadataOwner }),
              } as ReasoningMessageContentEvent);
            }
            return reasoningMessageResult;
          }
        }
        const _exhaustiveCheck: never = event.type;
        return [];
      }),
      finalize(() => {
        // Drops any lane still mid-assembly when the source completes. The END events
        // closeAllLanes() builds are DISCARDED here — finalize runs after the stream has
        // terminated and cannot emit — so this only clears the state, which matters for
        // an operator instance that outlives one subscription. A stream that ends without
        // a run terminal therefore has no synthesized END; the run-level cases above are
        // what actually emit them.
        closeAllLanes();
      }),
    );
  };

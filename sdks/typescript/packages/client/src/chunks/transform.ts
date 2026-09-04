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
import {
  TextMessageChunkEventSchema,
  ToolCallChunkEventSchema,
  ReasoningMessageChunkEventSchema,
} from "@ag-ui/core/schemas";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

interface TextMessageFields {
  messageId: string;
  // The role the opener ESTABLISHED — explicit, or the assistant default the
  // synthesized START carried. Kept so a later chunk that repeats the field
  // can be judged against what the stream already said.
  role: TextMessageStartEvent["role"];
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
 * A continuation chunk MAY repeat a field its opener established, but only with
 * the same value. A conflicting repeat is a malformed known value, and fatal —
 * the same judgment the continuation-owner rule passes on `subagentRunId`.
 * Rejected here rather than left to verifyEvents because the repeated field
 * never survives expansion: the synthesized content event does not carry it,
 * so downstream stages would never see the disagreement.
 */
const requireOpenerAgreement = (
  entityKind: string,
  entityId: string,
  field: string,
  incoming: string | undefined,
  established: string | undefined,
): void => {
  if (incoming !== undefined && incoming !== established) {
    throw new Error(
      `Cannot continue ${entityKind} '${entityId}': chunk ${field} '${incoming}' does not match the open stream's ${field} ${established === undefined ? "(absent)" : `'${established}'`}.`,
    );
  }
};

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

/**
 * As above, plus the chunk's `rawEvent`.
 *
 * A chunk carries one provider payload, and expansion turns it into an opener
 * and a content event. The content event is the one that carries what the
 * producer actually sent, so the payload rides there; the opener is synthesised
 * here and claims no raw event of its own. Dropping it entirely — which is what
 * expansion used to do — silently lost every provider payload a chunked stream
 * carried, while the same stream sent unchunked kept them.
 */
const withChunkOrigin = <T extends BaseEvent>(event: T, chunk: BaseEvent): T => {
  const withMetadata = withChunkMetadata(event, chunk);
  return chunk.rawEvent === undefined
    ? withMetadata
    : { ...withMetadata, rawEvent: chunk.rawEvent };
};

/**
 * The properties each chunk shape actually describes, read once at module load
 * from the generated schema's own field list.
 *
 * DERIVED, not hand-copied. A copied set matches the schema on the day it is
 * written and nothing afterwards keeps it honest: a field added to a chunk in
 * a later protocol revision would arrive here as "unrecognised", ride onto the
 * synthesized event as remainder, and be stripped again by enforcement with a
 * warning naming a property the protocol had just adopted. That is the same
 * silent drift the remainder below exists to prevent, one layer up.
 *
 * Deriving is not the same as running enforcement here, which this stage
 * genuinely cannot do — it runs upstream of enforcement on the middleware
 * path. Nothing is validated or stripped at this line: it reads the list of
 * names the schema declares, once per shape at import time.
 * `@ag-ui/core/schemas` is already a runtime import of this package
 * (enforce/) and zod is already a hard dependency, so this adds no edge.
 */
const describedFields = (schema: { shape: Record<string, unknown> }): ReadonlySet<string> =>
  new Set(Object.keys(schema.shape));

const TEXT_CHUNK_FIELDS = describedFields(TextMessageChunkEventSchema);
const TOOL_CHUNK_FIELDS = describedFields(ToolCallChunkEventSchema);
const REASONING_CHUNK_FIELDS = describedFields(ReasoningMessageChunkEventSchema);

/**
 * Whatever the chunk carries that this stage has no field for — a property
 * from a protocol version newer than this client, or a producer's mistake.
 *
 * Expansion builds the synthesized events field by field, so anything not
 * named above simply vanished. On the plain pipeline that is harmless, because
 * enforcement has already stripped the chunk's unrecognised material and
 * warned about it by the time expansion runs. On the middleware path
 * expansion runs FIRST — `Middleware.runNext` expands inside the chain,
 * because middleware written with `runNext` is written against whole events
 * rather than chunks (a middleware that wants the raw stream calls `next.run`
 * itself, as `CompatibilityBoundary` and `FunctionMiddleware` do) — so there
 * is nothing left for enforcement to find and the material disappeared in
 * silence. The guarantee is that nothing is dropped without a warning, so the
 * remainder rides through instead and enforcement judges it after the chain.
 *
 * Where it rides: the CONTENT event whenever the chunk produces one, for the
 * same reason `rawEvent` does — the content event is what the producer
 * actually sent, the opener is this stage's invention — and never both, which
 * would warn twice about one property. A chunk that produces no content event
 * at all is the remaining case; see `carryRemainderOnOpener` below.
 */
const unrecognisedChunkProperties = (
  chunk: BaseEvent,
  described: ReadonlySet<string>,
): Record<string, unknown> | undefined => {
  let remainder: Record<string, unknown> | undefined;
  for (const key of Object.keys(chunk)) {
    if (described.has(key)) continue;
    (remainder ??= {})[key] = (chunk as unknown as Record<string, unknown>)[key];
  }
  return remainder;
};

/**
 * The opener's share of the same guarantee.
 *
 * "It rides on the CONTENT event" above holds only when there IS one. An
 * OPENING chunk pushes its synthesized `*_START` first, so the empty-result
 * fallback each arm ends with can never fire for it; and a chunk with neither
 * `delta` nor `rawEvent` synthesizes no content event to carry the remainder
 * either. Between the two, an opener-only chunk carrying an unrecognised
 * property expanded into a bare `*_START` and the property was gone — dropped
 * with nothing said, which is exactly what this whole mechanism exists to
 * prevent.
 *
 * So when nothing else took the remainder, it goes onto the last event
 * synthesized for the chunk — the `*_START` — and enforcement, running after
 * the middleware chain, strips it there and names it. Spread FIRST, like every
 * other site: a described field can never be shadowed by something the
 * producer also sent under that name.
 *
 * Spreading first has one cost, and it is announced rather than paid in
 * silence. When the OPENER declares a key the remainder also carries, the
 * opener's value wins and the producer's is overwritten before enforcement can
 * see it. Reachable on one arm today: REASONING_MESSAGE_START declares `role`
 * (set to "reasoning" below) while REASONING_MESSAGE_CHUNK does not declare
 * `role` at all, so a producer's `role` on such a chunk is remainder and
 * collides. The text and tool arms are safe — their opener's keys are a subset
 * of their chunk's.
 *
 * Letting the REMAINDER win instead is not the fix. The synthesized opener's
 * described value is this stage's own, and a producer value in its place would
 * be judged by enforcement — `role: "wizard"` on a REASONING_MESSAGE_START is a
 * malformed known field, so the run would fail behind a shim and succeed
 * without one. Same stream, two verdicts, which is exactly the divergence this
 * file exists to prevent. So the opener keeps its value and the collision is
 * reported, which is what "nothing is dropped without a warning" asks for.
 */
const warnChunkAside = (sentence: string): void => {
  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    Boolean(process.env.SUPPRESS_TRANSFORMATION_WARNINGS)
  ) {
    return;
  }
  console.warn(
    `[ag-ui][transform] ${sentence} Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence.`,
  );
};

const carryRemainderOnOpener = (
  synthesized: BaseEvent[],
  remainder: Record<string, unknown> | undefined,
  alreadyCarried: boolean,
  chunkType: string,
): void => {
  if (remainder === undefined || alreadyCarried || synthesized.length === 0) return;
  const last = synthesized[synthesized.length - 1];

  // `hasOwnProperty`, not `in`. The spread below copies OWN enumerable
  // properties, so the opener's value wins only for keys the opener OWNS —
  // whereas `in` also answers true for everything on Object.prototype, and a
  // producer sending `toString` or `constructor` on a chunk would then be told
  // its value had been dropped when the spread had in fact kept it. A warning
  // has to describe what actually happened.
  const shadowed = Object.keys(remainder).filter((key) =>
    Object.prototype.hasOwnProperty.call(last, key),
  );
  if (shadowed.length > 0) {
    warnChunkAside(
      `A ${chunkType} carried ${shadowed.map((key) => `'${key}'`).join(", ")}, which the synthesized ${String(last.type)} already describes. The synthesized value is kept and the chunk's is dropped — this stage does not judge a described field, so the producer's value cannot be substituted for its own.`,
    );
  }

  synthesized[synthesized.length - 1] = { ...remainder, ...last };
};

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
            // `!== undefined`, not `!= null`, matching every other site in
            // this file: an absent owner is absent, but a null one is a
            // violation the spec names, and dropping it here would hide it
            // from the stage that rejects it (see the note on the opener
            // below).
            ...(pending.fields.subagentRunId !== undefined && {
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
            // `!== undefined`, not `!= null`, matching every other site in
            // this file: an absent owner is absent, but a null one is a
            // violation the spec names, and dropping it here would hide it
            // from the stage that rejects it (see the note on the opener
            // below).
            ...(pending.fields.subagentRunId !== undefined && {
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
            // `!== undefined`, not `!= null`, matching every other site in
            // this file: an absent owner is absent, but a null one is a
            // violation the spec names, and dropping it here would hide it
            // from the stage that rejects it (see the note on the opener
            // below).
            ...(pending.fields.subagentRunId !== undefined && {
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
            const textChunkRemainder = unrecognisedChunkProperties(event, TEXT_CHUNK_FIELDS);
            const lane = resolveLane(
              "text",
              messageChunkEvent.messageId,
              messageChunkEvent.subagentRunId ?? undefined,
              "TEXT_MESSAGE_CHUNK",
              "text message",
            );
            const open = lanes.get(lane);
            const textMessageResult: BaseEvent[] = [];
            // Whether the remainder found a carrier below. Only the two
            // branches that spread it set this; see carryRemainderOnOpener.
            let textRemainderCarried = false;

            let textMessageFields: TextMessageFields;
            if (
              open?.kind === "text" &&
              // An absent id continues; a present one must be the same message.
              (messageChunkEvent.messageId === undefined ||
                messageChunkEvent.messageId === open.fields.messageId)
            ) {
              requireOpenerAgreement(
                "text message",
                open.fields.messageId,
                "role",
                messageChunkEvent.role,
                open.fields.role,
              );
              requireOpenerAgreement(
                "text message",
                open.fields.messageId,
                "name",
                messageChunkEvent.name,
                open.fields.name,
              );
              textMessageFields = open.fields;
            } else {
              // Whatever else this lane had open ends before the new stream begins.
              textMessageResult.push(...closeLane(lane));

              if (messageChunkEvent.messageId === undefined) {
                throw new Error("First TEXT_MESSAGE_CHUNK must have a messageId");
              }

              textMessageFields = {
                messageId: messageChunkEvent.messageId,
                // Absent means assistant, which the spec states normatively
                // and the generated validator deliberately does not apply, so
                // materialising it here is real work nothing else does.
                //
                // ABSENT, though — not merely falsy, and not null. This stage
                // must not depend on enforcement having run first: it has, on
                // the three pipelines in agent.ts, but Middleware.runNext
                // expands INSIDE the middleware chain, upstream of it. So a
                // present-but-wrong role reaching here has not been judged
                // yet, and substituting for it would repair a producer defect
                // that is fatal when the same value is sent unchunked.
                role: messageChunkEvent.role === undefined ? "assistant" : messageChunkEvent.role,
                name: messageChunkEvent.name,
                subagentRunId: messageChunkEvent.subagentRunId,
              };
              lanes.set(lane, { kind: "text", fields: textMessageFields });

              const textMessageStartEvent = withChunkMetadata(
                {
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: messageChunkEvent.messageId,
                  role: textMessageFields.role,
                  ...(messageChunkEvent.name !== undefined && { name: messageChunkEvent.name }),
                  // `!== undefined`, not `!= null`: an absent owner is absent,
                  // but a null one is a violation the spec names, and dropping
                  // it here would hide it from the stage that rejects it.
                  ...(messageChunkEvent.subagentRunId !== undefined && {
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

            // A content event is emitted when the chunk carries a delta OR a
            // provider payload — here and in the two branches below. The
            // synthesized START deliberately claims no rawEvent, so a first
            // chunk carrying rawEvent but no delta needs this event as the
            // payload's carrier, exactly as a continuation does.
            if (messageChunkEvent.delta !== undefined || messageChunkEvent.rawEvent !== undefined) {
              // `!== undefined`, not `??`, on the incoming tag — here and on
              // every continuation path below: a null tag is a violation the
              // spec names, and `??` read it as absence, so a continuation's
              // null fell back to the opener's owner and never reached the
              // stage that rejects it. Preserved, it rides the synthesized
              // event onward, exactly as an opener's null does.
              //
              // WHICH stage rejects it depends on the path, and both do:
              //
              // - Plain pipeline (`enforce -> expand`): ENFORCEMENT rejects,
              //   and it rejects the raw CHUNK before this stage ever runs.
              //   `SubagentRunIdSchema` is `z.string()`, so `null` is a
              //   malformed value on a described field, which enforcement
              //   keeps fatal. Nothing this stage synthesises is involved.
              // - `Middleware.runNext` (`expand` inside the chain, enforce
              //   after it): expansion is handed the raw chunk, so preserving
              //   the null is what lets enforcement — and then VERIFICATION
              //   (verify.ts's "'subagentRunId: null'. The field is optional"
              //   check) — see it at all.
              //
              // Reading it as absence with `??` is what removed it from the
              // second path entirely, which is the divergence this file
              // exists to prevent.
              const contentOwner =
                messageChunkEvent.subagentRunId !== undefined
                  ? messageChunkEvent.subagentRunId
                  : textMessageFields.subagentRunId;
              const textMessageContentEvent = withChunkOrigin(
                {
                  // Spread FIRST so a described field can never be shadowed by
                  // something the producer also sent under that name.
                  ...textChunkRemainder,
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId: textMessageFields.messageId,
                  // `=== undefined`, not `??` — exactly how the opener's `role` is
                  // handled above. The gate that reached this line is itself
                  // `!== undefined`, so a `delta: null` passes it, and `??` then
                  // repaired the malformed value into "". That made the same
                  // producer defect fatal when sent unchunked and invisible when
                  // sent as a chunk behind a middleware. Preserved, it is fatal on
                  // both paths.
                  delta: messageChunkEvent.delta === undefined ? "" : messageChunkEvent.delta,
                  // Prefer the INCOMING chunk's tag over the opener's, so a producer that
                  // attributes every chunk sees its own attribution on the output rather
                  // than a value this transform remembered.
                  ...(contentOwner !== undefined && { subagentRunId: contentOwner }),
                } as TextMessageContentEvent,
                messageChunkEvent,
              );

              textMessageResult.push(textMessageContentEvent);
              textRemainderCarried = true;

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
            //
            // The gate also fires for a chunk carrying only `rawEvent` — a
            // provider payload is content whichever field it rides — and for
            // one carrying only `subagentRunId: null`, whose violation must
            // reach the stage that rejects it rather than vanish with the
            // chunk.
            if (
              textMessageResult.length === 0 &&
              (messageChunkEvent.metadata !== undefined ||
                messageChunkEvent.rawEvent !== undefined ||
                messageChunkEvent.subagentRunId === null ||
                // A continuation carrying ONLY unrecognised material expanded
                // into nothing at all, so there was no event left for
                // enforcement to strip it from and warn about.
                textChunkRemainder !== undefined)
            ) {
              // Attribution follows the same rule as the delta path above: the
              // incoming chunk's tag first, the opener's owner as fallback —
              // a metadata-only continuation is still the lane's event.
              const metadataOwner =
                messageChunkEvent.subagentRunId !== undefined
                  ? messageChunkEvent.subagentRunId
                  : textMessageFields!.subagentRunId;
              textMessageResult.push({
                ...textChunkRemainder,
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: textMessageFields!.messageId,
                delta: "",
                ...(messageChunkEvent.metadata !== undefined && { metadata: messageChunkEvent.metadata }),
                ...(messageChunkEvent.rawEvent !== undefined && {
                  rawEvent: messageChunkEvent.rawEvent,
                }),
                ...(metadataOwner !== undefined && { subagentRunId: metadataOwner }),
              } as TextMessageContentEvent);
              textRemainderCarried = true;
            }

            carryRemainderOnOpener(
              textMessageResult,
              textChunkRemainder,
              textRemainderCarried,
              "TEXT_MESSAGE_CHUNK",
            );
            return textMessageResult;
          }
          case EventType.TOOL_CALL_CHUNK: {
            const toolCallChunkEvent = event as ToolCallChunkEvent;
            const toolChunkRemainder = unrecognisedChunkProperties(event, TOOL_CHUNK_FIELDS);
            const lane = resolveLane(
              "tool",
              toolCallChunkEvent.toolCallId,
              toolCallChunkEvent.subagentRunId ?? undefined,
              "TOOL_CALL_CHUNK",
              "tool call",
            );
            const open = lanes.get(lane);
            const toolMessageResult: BaseEvent[] = [];
            // As in the text arm above.
            let toolRemainderCarried = false;

            let toolCallFields: ToolCallFields;
            if (
              open?.kind === "tool" &&
              (toolCallChunkEvent.toolCallId === undefined ||
                toolCallChunkEvent.toolCallId === open.fields.toolCallId)
            ) {
              requireOpenerAgreement(
                "tool call",
                open.fields.toolCallId,
                "toolCallName",
                toolCallChunkEvent.toolCallName,
                open.fields.toolCallName,
              );
              requireOpenerAgreement(
                "tool call",
                open.fields.toolCallId,
                "parentMessageId",
                toolCallChunkEvent.parentMessageId,
                open.fields.parentMessageId,
              );
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
                  // Conditional, like its siblings: set unconditionally this
                  // wrote an explicit `parentMessageId: undefined` key onto
                  // every synthesized opener, which is a present member with
                  // no value rather than the absent field the schema means.
                  ...(toolCallChunkEvent.parentMessageId !== undefined && {
                    parentMessageId: toolCallChunkEvent.parentMessageId,
                  }),
                  // `!== undefined`, not `!= null`: an absent owner is absent,
                  // but a null one is a violation the spec names, and dropping
                  // it here would hide it from the stage that rejects it.
                  ...(toolCallChunkEvent.subagentRunId !== undefined && {
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

            if (toolCallChunkEvent.delta !== undefined || toolCallChunkEvent.rawEvent !== undefined) {
              const argsOwner =
                toolCallChunkEvent.subagentRunId !== undefined
                  ? toolCallChunkEvent.subagentRunId
                  : toolCallFields.subagentRunId;
              const toolCallArgsEvent = withChunkOrigin(
                {
                  ...toolChunkRemainder,
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId: toolCallFields.toolCallId,
                  // `=== undefined`, not `??` — exactly how the opener's `role` is
                  // handled above. The gate that reached this line is itself
                  // `!== undefined`, so a `delta: null` passes it, and `??` then
                  // repaired the malformed value into "". That made the same
                  // producer defect fatal when sent unchunked and invisible when
                  // sent as a chunk behind a middleware. Preserved, it is fatal on
                  // both paths.
                  delta: toolCallChunkEvent.delta === undefined ? "" : toolCallChunkEvent.delta,
                  // Prefer the INCOMING chunk's tag over the opener's, so a producer that
                  // attributes every chunk sees its own attribution on the output rather
                  // than a value this transform remembered.
                  ...(argsOwner !== undefined && { subagentRunId: argsOwner }),
                } as ToolCallArgsEvent,
                toolCallChunkEvent,
              );

              toolMessageResult.push(toolCallArgsEvent);
              toolRemainderCarried = true;

              log?.event("TRANSFORM", "TOOL_CALL_ARGS", toolCallArgsEvent, {
                toolCallId: toolCallFields.toolCallId,
              });
            }

            // Same as the text case above.
            if (
              toolMessageResult.length === 0 &&
              (toolCallChunkEvent.metadata !== undefined ||
                toolCallChunkEvent.rawEvent !== undefined ||
                toolCallChunkEvent.subagentRunId === null ||
                toolChunkRemainder !== undefined)
            ) {
              // Same attribution rule as the args path above.
              const metadataOwner =
                toolCallChunkEvent.subagentRunId !== undefined
                  ? toolCallChunkEvent.subagentRunId
                  : toolCallFields!.subagentRunId;
              toolMessageResult.push({
                ...toolChunkRemainder,
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: toolCallFields!.toolCallId,
                delta: "",
                ...(toolCallChunkEvent.metadata !== undefined && { metadata: toolCallChunkEvent.metadata }),
                ...(toolCallChunkEvent.rawEvent !== undefined && {
                  rawEvent: toolCallChunkEvent.rawEvent,
                }),
                ...(metadataOwner !== undefined && { subagentRunId: metadataOwner }),
              } as ToolCallArgsEvent);
              toolRemainderCarried = true;
            }

            carryRemainderOnOpener(
              toolMessageResult,
              toolChunkRemainder,
              toolRemainderCarried,
              "TOOL_CALL_CHUNK",
            );
            return toolMessageResult;
          }
          case EventType.REASONING_MESSAGE_CHUNK: {
            const reasoningChunkEvent = event as ReasoningMessageChunkEvent;
            const reasoningChunkRemainder = unrecognisedChunkProperties(event, REASONING_CHUNK_FIELDS);
            const lane = resolveLane(
              "reasoning",
              reasoningChunkEvent.messageId,
              reasoningChunkEvent.subagentRunId ?? undefined,
              "REASONING_MESSAGE_CHUNK",
              "reasoning message",
            );
            const open = lanes.get(lane);
            const reasoningMessageResult: BaseEvent[] = [];
            // As in the text arm above.
            let reasoningRemainderCarried = false;

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
                  // `!== undefined`, not `!= null`: an absent owner is absent,
                  // but a null one is a violation the spec names, and dropping
                  // it here would hide it from the stage that rejects it.
                  ...(reasoningChunkEvent.subagentRunId !== undefined && {
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

            if (reasoningChunkEvent.delta !== undefined || reasoningChunkEvent.rawEvent !== undefined) {
              const contentOwner =
                reasoningChunkEvent.subagentRunId !== undefined
                  ? reasoningChunkEvent.subagentRunId
                  : reasoningMessageFields.subagentRunId;
              const reasoningMessageContentEvent = withChunkOrigin(
                {
                  ...reasoningChunkRemainder,
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageFields.messageId,
                  // `=== undefined`, not `??` — exactly how the opener's `role` is
                  // handled above. The gate that reached this line is itself
                  // `!== undefined`, so a `delta: null` passes it, and `??` then
                  // repaired the malformed value into "". That made the same
                  // producer defect fatal when sent unchunked and invisible when
                  // sent as a chunk behind a middleware. Preserved, it is fatal on
                  // both paths.
                  delta: reasoningChunkEvent.delta === undefined ? "" : reasoningChunkEvent.delta,
                  // Prefer the INCOMING chunk's tag over the opener's, so a producer that
                  // attributes every chunk sees its own attribution on the output rather
                  // than a value this transform remembered.
                  ...(contentOwner !== undefined && { subagentRunId: contentOwner }),
                } as ReasoningMessageContentEvent,
                reasoningChunkEvent,
              );

              reasoningMessageResult.push(reasoningMessageContentEvent);
              reasoningRemainderCarried = true;

              log?.event("TRANSFORM", "REASONING_MESSAGE_CONTENT", reasoningMessageContentEvent, {
                messageId: reasoningMessageFields.messageId,
              });
            }

            // Same as the text case above.
            if (
              reasoningMessageResult.length === 0 &&
              (reasoningChunkEvent.metadata !== undefined ||
                reasoningChunkEvent.rawEvent !== undefined ||
                reasoningChunkEvent.subagentRunId === null ||
                reasoningChunkRemainder !== undefined)
            ) {
              // Same attribution rule as the content path above.
              const metadataOwner =
                reasoningChunkEvent.subagentRunId !== undefined
                  ? reasoningChunkEvent.subagentRunId
                  : reasoningMessageFields!.subagentRunId;
              reasoningMessageResult.push({
                ...reasoningChunkRemainder,
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: reasoningMessageFields!.messageId,
                delta: "",
                ...(reasoningChunkEvent.metadata !== undefined && { metadata: reasoningChunkEvent.metadata }),
                ...(reasoningChunkEvent.rawEvent !== undefined && {
                  rawEvent: reasoningChunkEvent.rawEvent,
                }),
                ...(metadataOwner !== undefined && { subagentRunId: metadataOwner }),
              } as ReasoningMessageContentEvent);
              reasoningRemainderCarried = true;
            }

            carryRemainderOnOpener(
              reasoningMessageResult,
              reasoningChunkRemainder,
              reasoningRemainderCarried,
              "REASONING_MESSAGE_CHUNK",
            );
            return reasoningMessageResult;
          }
        }
        // Not a chunk event: a legacy type a compat middleware still
        // translates, a future one, or simply an event this stage has no
        // assembly to do for. Not this stage's to judge — it passes through
        // untouched and downstream layers decide. Dropping it here would
        // starve the middlewares, and closing lanes would end messages an
        // unrelated event never spoke about.
        const _exhaustiveCheck: never = event.type;
        return [event];
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

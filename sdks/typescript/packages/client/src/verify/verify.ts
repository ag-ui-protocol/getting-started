import { BaseEvent, EventType, AGUIError } from "@ag-ui/core";
import { Observable, throwError, of } from "rxjs";
import { mergeMap } from "rxjs/operators";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

export const verifyEvents =
  (debugLogger?: DebugLoggerInput) =>
  (source$: Observable<BaseEvent>): Observable<BaseEvent> => {
    const log = resolveDebugLogger(debugLogger);
    // Declare variables in closure to maintain state across events.
    // The four sets below hold IDS ONLY: membership answers "is this entity still open?"
    // (for activities, which have no close event, "has it been seen at all?"). Ownership
    // is NOT here — it lives in `owners` below, which is what every attribution check
    // reads, openers included.
    const activeMessages = new Set<string>(); // open text message IDs
    const activeToolCalls = new Set<string>(); // open tool call IDs
    // Activity messages are keyed by their own messageId and continued by
    // ACTIVITY_DELTA, so they need an owner tracked for them just like text messages —
    // see `owners.activity`. This set only records that the activity exists, which is
    // what tells a replacing snapshot from a first one.
    const activeActivities = new Set<string>(); // known activity IDs
    // Reasoning messages are opened by REASONING_START / REASONING_MESSAGE_START and
    // continued by REASONING_MESSAGE_CONTENT/END and REASONING_END, all keyed by the same
    // id — the last ID-keyed entity that had no owner check, so an s2 delta could be
    // appended to the reasoning message minted for s1. REASONING_ENCRYPTED_VALUE also
    // continues a reasoning message, but it is keyed by `entityId` and its `subtype` may
    // route it to a different bucket entirely.
    const activeReasoning = new Set<string>(); // open reasoning IDs
    // Owners, retained for the whole run, in one bucket PER ENTITY KIND. An id is only
    // unique within a kind: a message and a tool call may both be called "x" with no
    // conflict. A single bucket let the tool-call write overwrite the message's owner, so
    // a later encrypted value naming that id was checked against the wrong owner and
    // accepted. .NET already keeps separate maps per kind; this matches it.
    //
    // Retained rather than cleared on close, because a continuation can legitimately
    // arrive after its entity closed -- REASONING_ENCRYPTED_VALUE with subtype
    // "tool-call" after TOOL_CALL_END is the case in point, and nothing requires it to
    // precede the close. Losing the owner there made the mismatch unmatchable and
    // accepted a wrong one. The active* sets above stay purely "is this entity open?".
    type Owner = { subagentRunId?: string };
    const owners = {
      message: new Map<string, Owner>(),
      toolCall: new Map<string, Owner>(),
      activity: new Map<string, Owner>(),
      reasoning: new Map<string, Owner>(),
    };
    let runFinished = false;
    let runError = false; // New flag to track if RUN_ERROR has been sent
    // New flags to track first/last event requirements
    let firstEventReceived = false;
    // Track active steps, keyed by OWNER + name rather than name alone. A step name is
    // only unique within one agent: a subagent routinely runs the same graph shape as its
    // parent, so both legitimately have a step called "tools" open at once (the parent's
    // wraps the delegation, the subagent's is its own inner work). Keying by name alone
    // rejected that valid nesting with `Step "tools" is already active`, while ACCEPTING a
    // STEP_FINISHED that closed the parent's step under the subagent's tag -- the exact
    // shape a design partner reported from a real deepagents run.
    // owner -> stepName -> true. Kept as a NESTED map rather than one joined key:
    // joining the owner and the name with a separator made the parent (no owner) collide
    // with a subagent whose id is the empty string, which is a legal opaque id -- so that
    // subagent could close the parent's step. .NET keys on a (owner, name) tuple and so
    // never had the problem; nesting matches it. A Map distinguishes the `undefined` key
    // from the "" key, which is exactly the distinction that was lost.
    const activeSteps = new Map<string | undefined, Map<string, true>>();
    const stepsFor = (owner: string | undefined) => {
      let m = activeSteps.get(owner);
      if (!m) {
        m = new Map<string, true>();
        activeSteps.set(owner, m);
      }
      return m;
    };
    const anyStepsActive = () => {
      for (const m of activeSteps.values()) if (m.size > 0) return true;
      return false;
    };
    const activeSubagents = new Map<string, boolean>(); // Map of subagent ID -> active status
    // Ids closed by a SUBAGENT_FINISHED / SUBAGENT_ERROR in this run. Needed because
    // "no duplicate SUBAGENT_STARTED for the same subagentRunId" has to hold for the whole
    // run: a subagentRunId is a unique handle for ONE invocation, so tracking only the
    // ACTIVE set made `STARTED(s1), FINISHED(s1), STARTED(s1)` legal and gave a single
    // invocation two starts and two terminals.
    //
    // Deliberately NOT used to reject later events tagged with a closed id. The rule is
    // that a continuation must not DISAGREE with its opener; requiring the tag to name a
    // still-live subagent was explicitly rejected when this was designed, so that
    // attribution-only producers (which tag events but never send SUBAGENT_*) stay
    // valid. Cleared per run, like every other map here.
    const closedSubagents = new Set<string>();
    let activeThinkingStep = false;
    let activeThinkingStepMessage = false;
    let runStarted = false; // Track if a run has started

    // Function to reset state for a new run
    const resetRunState = () => {
      activeMessages.clear();
      activeToolCalls.clear();
      activeActivities.clear();
      activeReasoning.clear();
      owners.message.clear();
      owners.toolCall.clear();
      owners.activity.clear();
      owners.reasoning.clear();
      activeSteps.clear();
      activeSubagents.clear();
      closedSubagents.clear();
      activeThinkingStep = false;
      activeThinkingStepMessage = false;
      runFinished = false;
      runError = false;
      runStarted = true;
    };

    // Subagent attribution consistency: a continuation/close event must not
    // disagree with the subagent that owns its message / tool call (the opener).
    // An absent tag is always allowed (the field is optional, and Phase-1
    // attribution may be used without Phase-2 SUBAGENT_* lifecycle events — so we
    // deliberately do NOT require the tag to reference an "active" subagent here,
    // which would reject valid attribution-only streams).
    const subagentTagError = (
      evType: EventType,
      evSubagentRunId: string | undefined,
      owner: { subagentRunId?: string } | undefined,
      entityKind: string,
      entityId: string,
    ): AGUIError | undefined => {
      if (evSubagentRunId === undefined) return undefined;
      // An opener with no tag means the entity belongs to the PARENT, which is just as
      // much an owner as a subagent is — so a tagged continuation on it is still a
      // disagreement. Comparing only when the recorded owner had an id let
      // `TEXT_MESSAGE_START(m1)` then `TEXT_MESSAGE_CONTENT(m1, subagentRunId: "s1")`
      // through, and the reducer would append a subagent's text to a parent-owned
      // message. `owner` being present at all is what matters; its id being undefined
      // is the parent, not "unknown".
      if (owner && owner.subagentRunId !== evSubagentRunId) {
        return new AGUIError(
          `Cannot send '${evType}': subagentRunId '${evSubagentRunId}' does not match the ${entityKind} '${entityId}' opener's subagent '${owner.subagentRunId ?? "(the parent agent)"}'.`,
        );
      }
      return undefined;
    };

    return source$.pipe(
      // Process each event through our state machine
      mergeMap((event) => {
        const eventType = event.type;

        log?.event("VERIFY", "Event:", event, { type: event.type });

        // Check if run has errored
        if (runError) {
          return throwError(
            () =>
              new AGUIError(
                `Cannot send event type '${eventType}': The run has already errored with 'RUN_ERROR'. No further events can be sent.`,
              ),
          );
        }

        // Check if run has already finished (but allow new RUN_STARTED to start a new run)
        if (
          runFinished &&
          eventType !== EventType.RUN_ERROR &&
          eventType !== EventType.RUN_STARTED
        ) {
          return throwError(
            () =>
              new AGUIError(
                `Cannot send event type '${eventType}': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'.`,
              ),
          );
        }

        // Handle first event requirement and sequential RUN_STARTED
        if (!firstEventReceived) {
          firstEventReceived = true;
          if (eventType !== EventType.RUN_STARTED && eventType !== EventType.RUN_ERROR) {
            return throwError(() => new AGUIError(`First event must be 'RUN_STARTED'`));
          }
        } else if (eventType === EventType.RUN_STARTED) {
          // Allow RUN_STARTED after RUN_FINISHED (new run), but not during an active run
          if (runStarted && !runFinished) {
            return throwError(
              () =>
                new AGUIError(
                  `Cannot send 'RUN_STARTED' while a run is still active. The previous run must be finished with 'RUN_FINISHED' before starting a new run.`,
                ),
            );
          }
          // If we're here, it's either the first RUN_STARTED or a new run after RUN_FINISHED
          if (runFinished) {
            // This is a new run after the previous one finished, reset state
            resetRunState();
          }
        }

        // Validate event based on type and current state
        switch (eventType) {
          // Text message flow
          case EventType.TEXT_MESSAGE_START: {
            const messageId = (event.messageId as string);

            // Check if this message is already in progress
            if (activeMessages.has(messageId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_START' event: A text message with ID '${messageId}' is already in progress. Complete it with 'TEXT_MESSAGE_END' first.`,
                  ),
              );
            }

            // First writer wins, exactly as for the reasoning opener below. Owners are
            // retained for the run, so a message this id already had is still on record
            // after its TEXT_MESSAGE_END -- and a DIFFERENT producer reopening that id is
            // a contradiction, since the reducer appends the second producer's content
            // into the first producer's message. Passing `undefined` as the owner here
            // made the check a no-op and accepted exactly that.
            const existingMessageOwner = owners.message.get(messageId);
            if (existingMessageOwner) {
              const subErr = subagentTagError(
                eventType, (event.subagentRunId as string | undefined), existingMessageOwner, "message", messageId,
              );
              if (subErr) return throwError(() => subErr);
            }
            activeMessages.add(messageId);
            // Only when there is no entry yet: an UNTAGGED reopen agrees with any owner
            // (an absent tag never disagrees), but it must not overwrite an s1 record
            // with `undefined` and hand the message to the parent.
            if (!existingMessageOwner) {
              owners.message.set(messageId, { subagentRunId: (event.subagentRunId as string | undefined) });
            }
            return of(event);
          }

          case EventType.TEXT_MESSAGE_CONTENT: {
            const messageId = (event.messageId as string);

            // Must be in a message with this ID
            if (!activeMessages.has(messageId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID '${messageId}'. Start a text message with 'TEXT_MESSAGE_START' first.`,
                  ),
              );
            }

            const subErr = subagentTagError(
              eventType, (event.subagentRunId as string | undefined), owners.message.get(messageId), "message", messageId,
            );
            if (subErr) return throwError(() => subErr);
            return of(event);
          }

          case EventType.TEXT_MESSAGE_END: {
            const messageId = (event.messageId as string);

            // Must be in a message with this ID
            if (!activeMessages.has(messageId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID '${messageId}'. A 'TEXT_MESSAGE_START' event must be sent first.`,
                  ),
              );
            }

            const subErr = subagentTagError(
              eventType, (event.subagentRunId as string | undefined), owners.message.get(messageId), "message", messageId,
            );
            if (subErr) return throwError(() => subErr);
            // Remove message from active set
            activeMessages.delete(messageId);
            return of(event);
          }

          // Tool call flow
          case EventType.TOOL_CALL_START: {
            const toolCallId = (event.toolCallId as string);

            // Check if this tool call is already in progress
            if (activeToolCalls.has(toolCallId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_START' event: A tool call with ID '${toolCallId}' is already in progress. Complete it with 'TOOL_CALL_END' first.`,
                  ),
              );
            }

            // First writer wins, for the same reason as TEXT_MESSAGE_START above: the
            // retained owner still names whoever opened this id, and a different producer
            // reopening it would have its args appended to the first producer's call.
            const existingToolCallOwner = owners.toolCall.get(toolCallId);
            if (existingToolCallOwner) {
              const subErr = subagentTagError(
                eventType, (event.subagentRunId as string | undefined), existingToolCallOwner, "tool call", toolCallId,
              );
              if (subErr) return throwError(() => subErr);
            }
            activeToolCalls.add(toolCallId);
            if (!existingToolCallOwner) {
              owners.toolCall.set(toolCallId, { subagentRunId: (event.subagentRunId as string | undefined) });
            }
            return of(event);
          }

          case EventType.TOOL_CALL_ARGS: {
            const toolCallId = (event.toolCallId as string);

            // Must be in a tool call with this ID
            if (!activeToolCalls.has(toolCallId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID '${toolCallId}'. Start a tool call with 'TOOL_CALL_START' first.`,
                  ),
              );
            }

            const subErr = subagentTagError(
              eventType, (event.subagentRunId as string | undefined), owners.toolCall.get(toolCallId), "tool call", toolCallId,
            );
            if (subErr) return throwError(() => subErr);
            return of(event);
          }

          case EventType.TOOL_CALL_END: {
            const toolCallId = (event.toolCallId as string);

            // Must be in a tool call with this ID
            if (!activeToolCalls.has(toolCallId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_END' event: No active tool call found with ID '${toolCallId}'. A 'TOOL_CALL_START' event must be sent first.`,
                  ),
              );
            }

            const subErr = subagentTagError(
              eventType, (event.subagentRunId as string | undefined), owners.toolCall.get(toolCallId), "tool call", toolCallId,
            );
            if (subErr) return throwError(() => subErr);
            // Remove tool call from active set
            activeToolCalls.delete(toolCallId);
            return of(event);
          }

          // Step flow
          case EventType.STEP_STARTED: {
            const stepName = (event.stepName as string);
            const stepOwner = (event.subagentRunId as string | undefined);
            if (stepsFor(stepOwner).has(stepName)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Step "${stepName}" is already active for 'STEP_STARTED'${
                      stepOwner !== undefined ? ` in subagent '${stepOwner}'` : ""
                    }`,
                  ),
              );
            }
            stepsFor(stepOwner).set(stepName, true);
            return of(event);
          }

          case EventType.STEP_FINISHED: {
            const stepName = (event.stepName as string);
            const stepOwner = (event.subagentRunId as string | undefined);
            if (!stepsFor(stepOwner).has(stepName)) {
              // A step with this name IS open, but under a different owner. Reported
              // separately because it is a distinct and much more likely mistake than a
              // step that was never started: a producer that stamps its attribution from
              // "whichever subagent is currently active" closes the PARENT's step under a
              // subagent's tag, and closes a SUBAGENT's step untagged once the subagent
              // has been popped. Both were observed in the same real run. The generic
              // "was not started" message sent the reader looking for a missing
              // STEP_STARTED that is in fact right there.
              // Find the owner that DOES hold a step of this name, if any.
              let otherOwner: string | undefined;
              let foundOther = false;
              for (const [owner, names] of activeSteps) {
                if (owner !== stepOwner && names.has(stepName)) {
                  otherOwner = owner;
                  foundOther = true;
                  break;
                }
              }
              if (foundOther) {
                return throwError(
                  () =>
                    new AGUIError(
                      `Cannot send 'STEP_FINISHED' for step "${stepName}" attributed to ${
                        stepOwner !== undefined ? `subagent '${stepOwner}'` : "the parent agent"
                      }: that step is open under ${
                        otherOwner !== undefined ? `subagent '${otherOwner}'` : "the parent agent"
                      }. A step must be finished by whoever started it.`,
                    ),
                );
              }
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'STEP_FINISHED' for step "${stepName}" that was not started`,
                  ),
              );
            }
            stepsFor(stepOwner).delete(stepName);
            return of(event);
          }

          // STATE_SNAPSHOT and STATE_DELTA are attributable, and attribution on them
          // is PROVENANCE, not ownership: it records which subagent produced the
          // update, while the state itself stays run-scoped and is applied
          // run-scoped. That is the same meaning attribution has on the other
          // standalone events (STEP_*, CUSTOM, RAW) — nobody reads an attributed
          // CUSTOM event as the subagent having private custom events.
          //
          // An earlier revision rejected an attributed state event here on the
          // grounds that only the parent owns state. That was a rule this verifier
          // invented: the protocol design lists STATE_SNAPSHOT / STATE_DELTA as
          // carrying attribution, so rejecting them made this client stricter than
          // the protocol and would throw on a conforming producer. Deliberately no
          // check — state events fall through to the generic handling below.

          // Activity messages are opened by ACTIVITY_SNAPSHOT and continued by
          // ACTIVITY_DELTA against the same messageId, so an owner change between
          // the two silently patches an activity attributed to someone else —
          // the same defect the text-message and tool-call checks prevent.
          case EventType.ACTIVITY_SNAPSHOT: {
            const messageId = (event.messageId as string);
            // Only a REPLACING snapshot re-mints the activity and so re-owns it. With
            // replace:false the reducer leaves the existing message alone, so overwriting
            // the tracked owner here would let a following ACTIVITY_DELTA under the new
            // tag patch a message still owned by someone else.
            const isNew = !activeActivities.has(messageId);
            if (isNew || (event.replace as boolean | undefined) !== false) {
              activeActivities.add(messageId);
              owners.activity.set(messageId, { subagentRunId: (event.subagentRunId as string | undefined) });
            }
            return of(event);
          }

          case EventType.REASONING_START:
          case EventType.REASONING_MESSAGE_START: {
            const messageId = (event.messageId as string);
            // First writer records the owner. REASONING_START brackets the outer
            // reasoning and REASONING_MESSAGE_START the inner message, usually under the
            // same id, so whichever arrives first establishes it.
            // A second opener that DISAGREES is a contradiction, not something to
            // silently ignore: the verifier kept the first owner while the reducer mints
            // the message from the second, so content then appended to a message owned by
            // someone else and passed verification.
            const existingReasoningOwner = owners.reasoning.get(messageId);
            if (existingReasoningOwner) {
              const subErr = subagentTagError(
                eventType, (event.subagentRunId as string | undefined), existingReasoningOwner, "reasoning message", messageId,
              );
              if (subErr) return throwError(() => subErr);
            }
            activeReasoning.add(messageId);
            // Only the first writer records the owner, and the owner outlives the close --
            // so an untagged reopen after REASONING_END does not hand the reasoning back
            // to the parent either.
            if (!existingReasoningOwner) {
              owners.reasoning.set(messageId, { subagentRunId: (event.subagentRunId as string | undefined) });
            }
            return of(event);
          }

          case EventType.REASONING_MESSAGE_CONTENT:
          case EventType.REASONING_MESSAGE_END:
          case EventType.REASONING_END: {
            const messageId = (event.messageId as string);
            const subErr = subagentTagError(
              eventType,
              (event.subagentRunId as string | undefined),
              owners.reasoning.get(messageId),
              "reasoning message",
              messageId,
            );
            if (subErr) return throwError(() => subErr);
            // Only REASONING_END closes the reasoning. Clearing at REASONING_MESSAGE_END
            // instead had also dropped the owner, which left the outer close with nothing
            // to compare against, so `REASONING_END(r, s2)` after an s1 message was
            // accepted. What is dropped here is only the OPEN flag —
            // `owners.reasoning` is retained for the rest of the run, so a later
            // REASONING_ENCRYPTED_VALUE naming this id still has an owner to check.
            if (eventType === EventType.REASONING_END) {
              activeReasoning.delete(messageId);
            }
            return of(event);
          }

          case EventType.REASONING_ENCRYPTED_VALUE: {
            // Continues an entity by entityId, and `subtype` says which kind: a
            // "tool-call" encrypted value belongs to a TOOL CALL, so looking only among
            // reasoning owners found none and accepted s2's value against s1's call.
            const entityId = (event.entityId as string);
            const subtype = (event.subtype as string | undefined);
            // The "message" subtype spans BOTH message kinds: a text message opened by
            // TEXT_MESSAGE_START and a reasoning message opened by
            // REASONING_MESSAGE_START. Reading only `owners.message` covered the first and
            // missed the second -- and attaching an encrypted value to a REASONING message
            // is the documented, canonical use of this subtype, so the check silently never
            // fired for the case it exists for. Ids are unique per kind, so at most one of
            // the two buckets holds this id and consulting both cannot pick a wrong owner.
            const owner =
              subtype === "tool-call"
                ? owners.toolCall.get(entityId)
                : subtype === "message"
                  ? (owners.message.get(entityId) ?? owners.reasoning.get(entityId))
                  // Fallback only. The schema defines exactly "tool-call" and "message",
                  // so this branch is unreachable for a schema-valid event; it treats an
                  // unknown subtype as a plain reasoning continuation rather than skipping
                  // the check.
                  : owners.reasoning.get(entityId);
            const kindLabel =
              subtype === "tool-call" ? "tool call" : subtype === "message" ? "message" : "reasoning message";
            const subErr = subagentTagError(
              eventType,
              (event.subagentRunId as string | undefined),
              owner,
              kindLabel,
              entityId,
            );
            if (subErr) return throwError(() => subErr);
            return of(event);
          }

          case EventType.ACTIVITY_DELTA: {
            const messageId = (event.messageId as string);
            const subErr = subagentTagError(
              eventType,
              (event.subagentRunId as string | undefined),
              owners.activity.get(messageId),
              "activity",
              messageId,
            );
            if (subErr) return throwError(() => subErr);
            return of(event);
          }

          // Subagent flow
          case EventType.SUBAGENT_STARTED: {
            // Required on the lifecycle events -- this is the subagent's own identity,
            // not the optional attribution tag other events carry.
            const subagentRunId = (event.subagentRunId as string);
            const parentSubagentRunId = (event.parentSubagentRunId as string | undefined);
            if (activeSubagents.has(subagentRunId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'SUBAGENT_STARTED': subagent '${subagentRunId}' is already active. Finish it with 'SUBAGENT_FINISHED' first.`,
                  ),
              );
            }
            // Reopening a closed id would give one invocation two starts and two
            // terminals. Ids are per-invocation, so a genuinely new delegation
            // brings a new id; reuse within a run is a producer bug.
            if (closedSubagents.has(subagentRunId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'SUBAGENT_STARTED': subagent '${subagentRunId}' has already finished in this run. Subagent IDs are per-invocation and cannot be reused.`,
                  ),
              );
            }
            if (
              parentSubagentRunId !== undefined &&
              !activeSubagents.has(parentSubagentRunId) &&
              !closedSubagents.has(parentSubagentRunId)
            ) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'SUBAGENT_STARTED': parentSubagentRunId '${parentSubagentRunId}' has not been started in this run.`,
                  ),
              );
            }
            activeSubagents.set(subagentRunId, true);
            return of(event);
          }

          case EventType.SUBAGENT_FINISHED:
          case EventType.SUBAGENT_ERROR: {
            // Required here too, for the same reason as SUBAGENT_STARTED above.
            const subagentRunId = (event.subagentRunId as string);
            if (!activeSubagents.has(subagentRunId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send '${eventType}': no active subagent found with ID '${subagentRunId}'. A 'SUBAGENT_STARTED' event must be sent first.`,
                  ),
              );
            }
            activeSubagents.delete(subagentRunId);
            closedSubagents.add(subagentRunId);
            return of(event);
          }

          // Run flow
          case EventType.RUN_STARTED: {
            // We've already validated this above
            runStarted = true;
            return of(event);
          }

          case EventType.RUN_FINISHED: {
            // Can't be the first event (already checked)
            // and can't happen after already being finished (already checked)

            // Check that all steps are finished before run ends
            if (anyStepsActive()) {
              const parts: string[] = [];
              for (const [owner, names] of activeSteps) {
                for (const name of names.keys()) {
                  parts.push(owner !== undefined ? `${name} (subagent '${owner}')` : name);
                }
              }
              const unfinishedSteps = parts.join(", ");
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'RUN_FINISHED' while steps are still active: ${unfinishedSteps}`,
                  ),
              );
            }

            // Check that all messages are finished before run ends
            if (activeMessages.size > 0) {
              const unfinishedMessages = Array.from(activeMessages.keys()).join(", ");
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'RUN_FINISHED' while text messages are still active: ${unfinishedMessages}`,
                  ),
              );
            }

            // Check that all tool calls are finished before run ends
            if (activeToolCalls.size > 0) {
              const unfinishedToolCalls = Array.from(activeToolCalls.keys()).join(", ");
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'RUN_FINISHED' while tool calls are still active: ${unfinishedToolCalls}`,
                  ),
              );
            }

            // Check that all subagents are finished before run ends
            if (activeSubagents.size > 0) {
              const unfinishedSubagents = Array.from(activeSubagents.keys()).join(", ");
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'RUN_FINISHED' while subagents are still active: ${unfinishedSubagents}`,
                  ),
              );
            }

            runFinished = true;
            return of(event);
          }

          case EventType.RUN_ERROR: {
            // RUN_ERROR can happen at any time
            runError = true; // Set flag to prevent any further events
            return of(event);
          }

          case EventType.CUSTOM: {
            return of(event);
          }

          // Text message flow
          case EventType.THINKING_TEXT_MESSAGE_START: {
            if (!activeThinkingStep) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking step is not in progress. Create one with 'THINKING_START' first.`,
                  ),
              );
            }
            // Can't start a message if one is already in progress
            if (activeThinkingStepMessage) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking message is already in progress. Complete it with 'THINKING_TEXT_MESSAGE_END' first.`,
                  ),
              );
            }

            activeThinkingStepMessage = true;
            return of(event);
          }

          case EventType.THINKING_TEXT_MESSAGE_CONTENT: {
            // Must be in a message and IDs must match
            if (!activeThinkingStepMessage) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'THINKING_TEXT_MESSAGE_CONTENT' event: No active thinking message found. Start a message with 'THINKING_TEXT_MESSAGE_START' first.`,
                  ),
              );
            }

            return of(event);
          }

          case EventType.THINKING_TEXT_MESSAGE_END: {
            // Must be in a message and IDs must match
            if (!activeThinkingStepMessage) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'THINKING_TEXT_MESSAGE_END' event: No active thinking message found. A 'THINKING_TEXT_MESSAGE_START' event must be sent first.`,
                  ),
              );
            }

            // Reset message state
            activeThinkingStepMessage = false;
            return of(event);
          }

          case EventType.THINKING_START: {
            if (activeThinkingStep) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'THINKING_START' event: A thinking step is already in progress. End it with 'THINKING_END' first.`,
                  ),
              );
            }

            activeThinkingStep = true;
            return of(event);
          }

          case EventType.THINKING_END: {
            // Must be in a message and IDs must match
            if (!activeThinkingStep) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'THINKING_END' event: No active thinking step found. A 'THINKING_START' event must be sent first.`,
                  ),
              );
            }

            // Reset message state
            activeThinkingStep = false;
            return of(event);
          }

          default: {
            return of(event);
          }
        }
      }),
    );
  };

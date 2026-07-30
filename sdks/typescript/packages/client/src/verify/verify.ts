import { BaseEvent, EventType, AGUIError } from "@ag-ui/core";
import { Observable, throwError, of } from "rxjs";
import { mergeMap } from "rxjs/operators";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

export const verifyEvents =
  (debugLogger?: DebugLoggerInput) =>
  (source$: Observable<BaseEvent>): Observable<BaseEvent> => {
    const log = resolveDebugLogger(debugLogger);
    // Declare variables in closure to maintain state across events
    // Value carries the owning subagentId (if any) so continuation/close events
    // can be checked for attribution consistency.
    let activeMessages = new Map<string, { subagentId?: string }>(); // message ID -> owner
    let activeToolCalls = new Map<string, { subagentId?: string }>(); // tool call ID -> owner
    let runFinished = false;
    let runError = false; // New flag to track if RUN_ERROR has been sent
    // New flags to track first/last event requirements
    let firstEventReceived = false;
    // Track active steps
    let activeSteps = new Map<string, boolean>(); // Map of step name -> active status
    let activeSubagents = new Map<string, boolean>(); // Map of subagent ID -> active status
    let activeThinkingStep = false;
    let activeThinkingStepMessage = false;
    let runStarted = false; // Track if a run has started

    // Function to reset state for a new run
    const resetRunState = () => {
      activeMessages.clear();
      activeToolCalls.clear();
      activeSteps.clear();
      activeSubagents.clear();
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
      evSubagentId: string | undefined,
      owner: { subagentId?: string } | undefined,
      entityKind: string,
      entityId: string,
    ): AGUIError | undefined => {
      if (evSubagentId === undefined) return undefined;
      if (
        owner &&
        owner.subagentId !== undefined &&
        owner.subagentId !== evSubagentId
      ) {
        return new AGUIError(
          `Cannot send '${evType}': subagentId '${evSubagentId}' does not match the ${entityKind} '${entityId}' opener's subagent '${owner.subagentId}'.`,
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
            const messageId = (event as any).messageId;

            // Check if this message is already in progress
            if (activeMessages.has(messageId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_START' event: A text message with ID '${messageId}' is already in progress. Complete it with 'TEXT_MESSAGE_END' first.`,
                  ),
              );
            }

            {
              const subErr = subagentTagError(
                eventType, (event as any).subagentId, undefined, "message", messageId,
              );
              if (subErr) return throwError(() => subErr);
            }
            activeMessages.set(messageId, { subagentId: (event as any).subagentId });
            return of(event);
          }

          case EventType.TEXT_MESSAGE_CONTENT: {
            const messageId = (event as any).messageId;

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
              eventType, (event as any).subagentId, activeMessages.get(messageId), "message", messageId,
            );
            if (subErr) return throwError(() => subErr);
            return of(event);
          }

          case EventType.TEXT_MESSAGE_END: {
            const messageId = (event as any).messageId;

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
              eventType, (event as any).subagentId, activeMessages.get(messageId), "message", messageId,
            );
            if (subErr) return throwError(() => subErr);
            // Remove message from active set
            activeMessages.delete(messageId);
            return of(event);
          }

          // Tool call flow
          case EventType.TOOL_CALL_START: {
            const toolCallId = (event as any).toolCallId;

            // Check if this tool call is already in progress
            if (activeToolCalls.has(toolCallId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_START' event: A tool call with ID '${toolCallId}' is already in progress. Complete it with 'TOOL_CALL_END' first.`,
                  ),
              );
            }

            {
              const subErr = subagentTagError(
                eventType, (event as any).subagentId, undefined, "tool call", toolCallId,
              );
              if (subErr) return throwError(() => subErr);
            }
            activeToolCalls.set(toolCallId, { subagentId: (event as any).subagentId });
            return of(event);
          }

          case EventType.TOOL_CALL_ARGS: {
            const toolCallId = (event as any).toolCallId;

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
              eventType, (event as any).subagentId, activeToolCalls.get(toolCallId), "tool call", toolCallId,
            );
            if (subErr) return throwError(() => subErr);
            return of(event);
          }

          case EventType.TOOL_CALL_END: {
            const toolCallId = (event as any).toolCallId;

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
              eventType, (event as any).subagentId, activeToolCalls.get(toolCallId), "tool call", toolCallId,
            );
            if (subErr) return throwError(() => subErr);
            // Remove tool call from active set
            activeToolCalls.delete(toolCallId);
            return of(event);
          }

          // Step flow
          case EventType.STEP_STARTED: {
            const stepName = (event as any).stepName;
            if (activeSteps.has(stepName)) {
              return throwError(
                () => new AGUIError(`Step "${stepName}" is already active for 'STEP_STARTED'`),
              );
            }
            activeSteps.set(stepName, true);
            return of(event);
          }

          case EventType.STEP_FINISHED: {
            const stepName = (event as any).stepName;
            if (!activeSteps.has(stepName)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'STEP_FINISHED' for step "${stepName}" that was not started`,
                  ),
              );
            }
            activeSteps.delete(stepName);
            return of(event);
          }

          // Subagent flow
          case EventType.SUBAGENT_STARTED: {
            const subagentId = (event as any).subagentId;
            const parentSubagentId = (event as any).parentSubagentId;
            if (activeSubagents.has(subagentId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'SUBAGENT_STARTED': subagent '${subagentId}' is already active. Finish it with 'SUBAGENT_FINISHED' first.`,
                  ),
              );
            }
            if (parentSubagentId !== undefined && !activeSubagents.has(parentSubagentId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'SUBAGENT_STARTED': parentSubagentId '${parentSubagentId}' has not been started.`,
                  ),
              );
            }
            activeSubagents.set(subagentId, true);
            return of(event);
          }

          case EventType.SUBAGENT_FINISHED:
          case EventType.SUBAGENT_ERROR: {
            const subagentId = (event as any).subagentId;
            if (!activeSubagents.has(subagentId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send '${eventType}': no active subagent found with ID '${subagentId}'. A 'SUBAGENT_STARTED' event must be sent first.`,
                  ),
              );
            }
            activeSubagents.delete(subagentId);
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
            if (activeSteps.size > 0) {
              const unfinishedSteps = Array.from(activeSteps.keys()).join(", ");
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

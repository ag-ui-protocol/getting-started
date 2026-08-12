import { BaseEvent, EventType, AGUIError } from "@ag-ui/core";
import { Observable, throwError, of } from "rxjs";
import { mergeMap } from "rxjs/operators";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

export const verifyEvents =
  (debugLogger?: DebugLoggerInput) =>
  (source$: Observable<BaseEvent>): Observable<BaseEvent> => {
    const log = resolveDebugLogger(debugLogger);
    // Declare variables in closure to maintain state across events
    const activeMessages = new Map<string, boolean>(); // Map of message ID -> active status
    const activeToolCalls = new Map<string, boolean>(); // Map of tool call ID -> active status
    let runFinished = false;
    let runError = false; // New flag to track if RUN_ERROR has been sent
    // New flags to track first/last event requirements
    let firstEventReceived = false;
    // Track active steps
    const activeSteps = new Map<string, boolean>(); // Map of step name -> active status
    let activeThinkingStep = false;
    let activeThinkingStepMessage = false;
    let runStarted = false; // Track if a run has started

    // Function to reset state for a new run
    const resetRunState = () => {
      activeMessages.clear();
      activeToolCalls.clear();
      activeSteps.clear();
      activeThinkingStep = false;
      activeThinkingStepMessage = false;
      runFinished = false;
      runError = false;
      runStarted = true;
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
            const messageId = event.messageId as string;

            // Check if this message is already in progress
            if (activeMessages.has(messageId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_START' event: A text message with ID '${messageId}' is already in progress. Complete it with 'TEXT_MESSAGE_END' first.`,
                  ),
              );
            }

            activeMessages.set(messageId, true);
            return of(event);
          }

          case EventType.TEXT_MESSAGE_CONTENT: {
            const messageId = event.messageId as string;

            // Must be in a message with this ID
            if (!activeMessages.has(messageId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID '${messageId}'. Start a text message with 'TEXT_MESSAGE_START' first.`,
                  ),
              );
            }

            return of(event);
          }

          case EventType.TEXT_MESSAGE_END: {
            const messageId = event.messageId as string;

            // Must be in a message with this ID
            if (!activeMessages.has(messageId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID '${messageId}'. A 'TEXT_MESSAGE_START' event must be sent first.`,
                  ),
              );
            }

            // Remove message from active set
            activeMessages.delete(messageId);
            return of(event);
          }

          // Tool call flow
          case EventType.TOOL_CALL_START: {
            const toolCallId = event.toolCallId as string;

            // Check if this tool call is already in progress
            if (activeToolCalls.has(toolCallId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_START' event: A tool call with ID '${toolCallId}' is already in progress. Complete it with 'TOOL_CALL_END' first.`,
                  ),
              );
            }

            activeToolCalls.set(toolCallId, true);
            return of(event);
          }

          case EventType.TOOL_CALL_ARGS: {
            const toolCallId = event.toolCallId as string;

            // Must be in a tool call with this ID
            if (!activeToolCalls.has(toolCallId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID '${toolCallId}'. Start a tool call with 'TOOL_CALL_START' first.`,
                  ),
              );
            }

            return of(event);
          }

          case EventType.TOOL_CALL_END: {
            const toolCallId = event.toolCallId as string;

            // Must be in a tool call with this ID
            if (!activeToolCalls.has(toolCallId)) {
              return throwError(
                () =>
                  new AGUIError(
                    `Cannot send 'TOOL_CALL_END' event: No active tool call found with ID '${toolCallId}'. A 'TOOL_CALL_START' event must be sent first.`,
                  ),
              );
            }

            // Remove tool call from active set
            activeToolCalls.delete(toolCallId);
            return of(event);
          }

          // Step flow
          case EventType.STEP_STARTED: {
            const stepName = event.stepName as string;
            if (activeSteps.has(stepName)) {
              return throwError(
                () => new AGUIError(`Step "${stepName}" is already active for 'STEP_STARTED'`),
              );
            }
            activeSteps.set(stepName, true);
            return of(event);
          }

          case EventType.STEP_FINISHED: {
            const stepName = event.stepName as string;
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

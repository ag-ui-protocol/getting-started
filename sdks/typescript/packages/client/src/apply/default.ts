import type { AbstractAgent } from "@/agent/agent";
import {
  type AgentStateMutation,
  type AgentSubscriber,
  runSubscribersWithMutation,
} from "@/agent/subscriber";
import {
  type ActivityDeltaEvent,
  type ActivityMessage,
  type ActivitySnapshotEvent,
  type AssistantMessage,
  type BaseEvent,
  type CustomEvent,
  EventType,
  type Message,
  type MessagesSnapshotEvent,
  type Metadata,
  mergeMetadata,
  type RawEvent,
  type ReasoningEncryptedValueEvent,
  type ReasoningEndEvent,
  type ReasoningMessage,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type ReasoningStartEvent,
  type RunAgentInput,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type StateDeltaEvent,
  type StateSnapshotEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCall,
  type ToolCallStartEvent,
  type ToolMessage,
} from "@ag-ui/core";
import jsonpatch from "fast-json-patch";
import { EMPTY, of } from "rxjs";
import type { Observable } from "rxjs";
import { concatMap, defaultIfEmpty, mergeAll } from "rxjs/operators";
import untruncateJson from "untruncate-json";
import { structuredClone_ } from "../utils";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

/**
 * Resolves (or creates) the assistant message that a tool call should attach to.
 *
 * Resolution order:
 * 1. `parentMessageId` matches an existing assistant message — return it.
 * 2. `parentMessageId` matches a non-assistant message (collision) — create new, keyed by `toolCallId`.
 * 3. `parentMessageId` not found — create new, keyed by `parentMessageId`.
 * 4. No `parentMessageId` — create new, keyed by `toolCallId`.
 */
function resolveOrCreateAssistantMessage(
  messages: Message[],
  parentMessageId: string | undefined,
  toolCallId: string,
): AssistantMessage {
  if (parentMessageId) {
    const existing = messages.find((m) => m.id === parentMessageId);
    if (existing?.role === "assistant") {
      return existing as AssistantMessage;
    }

    if (existing) {
      console.warn(
        `TOOL_CALL_START: parentMessageId '${parentMessageId}' matches a '${existing.role}' message, ` +
          `not assistant — falling back to toolCallId`,
      );
    }

    const created: AssistantMessage = {
      id: existing ? toolCallId : parentMessageId,
      role: "assistant",
      toolCalls: [],
    };
    messages.push(created);
    return created;
  }

  const created: AssistantMessage = { id: toolCallId, role: "assistant", toolCalls: [] };
  messages.push(created);
  return created;
}

/**
 * Folds an event's metadata into the thing that event builds, key by key, with
 * the last write winning.
 *
 * The target is a message, or a tool call for the TOOL_CALL_* events — a tool
 * call is not a message, and several can share one parent assistant message, so
 * folding theirs into that parent would make the result depend on their relative
 * order. Metadata on a run-, step- or state-level event belongs to that event
 * and never reaches either.
 *
 * Values are cloned so the event payload can't alias into the message array and
 * be mutated later through the caller's copy of the event.
 *
 * Returns whether anything changed, so callers only emit a mutation when it did.
 *
 * Known limitation, deliberately not fixed here. Handlers resolve their target
 * before running subscribers, so a subscriber that returns a replacement
 * `messages` array leaves that reference pointing into the discarded one and
 * this write is lost. Review has raised it repeatedly; it is not fixed because
 * the cure is worse than the disease. Re-resolving by id costs an O(n) scan on
 * TEXT_MESSAGE_CONTENT, which fires per streamed token, to fix a case that needs
 * a subscriber replacing the array from that specific hook — and the same
 * staleness already loses the content append on `main`, so it is a pre-existing
 * reducer issue rather than a metadata one. Fixing it belongs in its own change,
 * conditional on `mutation.messages !== undefined` so the hot path pays nothing.
 */
function applyEventMetadata(
  target: { metadata?: Metadata } | undefined,
  event: BaseEvent,
): boolean {
  if (!target || event.metadata === undefined) {
    return false;
  }
  target.metadata = mergeMetadata(target.metadata, structuredClone_(event.metadata));
  return true;
}

export const defaultApplyEvents = (
  input: RunAgentInput,
  events$: Observable<BaseEvent>,
  agent: AbstractAgent,
  subscribers: AgentSubscriber[],
  debugLogger?: DebugLoggerInput,
): Observable<AgentStateMutation> => {
  const log = resolveDebugLogger(debugLogger);
  let messages = structuredClone_(agent.messages);
  let state = structuredClone_(input.state);
  let currentMutation: AgentStateMutation = {};

  const applyMutation = (mutation: AgentStateMutation) => {
    if (mutation.messages !== undefined) {
      messages = mutation.messages;
      currentMutation.messages = mutation.messages;
    }
    if (mutation.state !== undefined) {
      state = mutation.state;
      currentMutation.state = mutation.state;
    }
  };

  const emitUpdates = () => {
    const result = structuredClone_(currentMutation) as AgentStateMutation;
    currentMutation = {};
    if (result.messages !== undefined || result.state !== undefined) {
      return of(result);
    }
    return EMPTY;
  };

  return events$.pipe(
    concatMap(async (event) => {
      const mutation = await runSubscribersWithMutation(
        subscribers,
        messages,
        state,
        (subscriber, messages, state) =>
          subscriber.onEvent?.({ event, agent, input, messages, state }),
      );
      applyMutation(mutation);

      if (mutation.stopPropagation === true) {
        log?.event("APPLY", "Event dropped:", event, {
          type: event.type,
          reason: "stopPropagation by subscriber",
        });
      } else {
        log?.event("APPLY", "Event applied:", event, {
          type: event.type,
          subscribers: subscribers.length,
        });
      }

      if (mutation.stopPropagation === true) {
        return emitUpdates();
      }

      switch (event.type) {
        case EventType.TEXT_MESSAGE_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageStartEvent?.({
                event: event as TextMessageStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messageId, role = "assistant", name } = event as TextMessageStartEvent;

            // Check if a message with this ID already exists (e.g., created by TOOL_CALL_START
            // with the same parentMessageId)
            const existingMessage = messages.find((m) => m.id === messageId);
            let targetMessage = existingMessage;

            if (!targetMessage) {
              // Create a new message using properties from the event
              // Text messages can be developer, system, assistant, or user (not tool)
              const newMessage: Message = {
                id: messageId,
                role: role,
                content: "",
                ...(name !== undefined && { name }),
              };

              // Add the new message to the messages array
              messages.push(newMessage);
              targetMessage = newMessage;
            }
            // If message already exists, we don't need to create a new one
            // The TEXT_MESSAGE_CONTENT events will update the existing message's content

            const metadataChanged = applyEventMetadata(targetMessage, event);
            if (!existingMessage || metadataChanged) {
              applyMutation({ messages });
            }
          }
          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_CONTENT: {
          const { messageId, delta } = event as TextMessageContentEvent;

          // Find the target message by ID
          const targetMessage = messages.find((m) => m.id === messageId);
          if (!targetMessage) {
            console.warn(`TEXT_MESSAGE_CONTENT: No message found with ID '${messageId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageContentEvent?.({
                event: event as TextMessageContentEvent,
                messages,
                state,
                agent,
                input,
                textMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            // Append content to the correct message by ID
            const existingContent =
              typeof targetMessage.content === "string" ? targetMessage.content : "";
            targetMessage.content = `${existingContent}${delta}`;
            applyEventMetadata(targetMessage, event);
            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_END: {
          const { messageId } = event as TextMessageEndEvent;

          // Find the target message by ID
          const targetMessage = messages.find((m) => m.id === messageId);
          if (!targetMessage) {
            console.warn(`TEXT_MESSAGE_END: No message found with ID '${messageId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageEndEvent?.({
                event: event as TextMessageEndEvent,
                messages,
                state,
                agent,
                input,
                textMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          // Merge before onNewMessage so subscribers see the completed message.
          // An end event is where late-known values — token usage, finish
          // reason — typically arrive.
          if (mutation.stopPropagation !== true && applyEventMetadata(targetMessage, event)) {
            applyMutation({ messages });
          }

          await Promise.all(
            subscribers.map((subscriber) => {
              subscriber.onNewMessage?.({
                message: targetMessage,
                messages,
                state,
                agent,
                input,
              });
            }),
          );

          return emitUpdates();
        }

        case EventType.TOOL_CALL_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onToolCallStartEvent?.({
                event: event as ToolCallStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { toolCallId, toolCallName, parentMessageId } = event as ToolCallStartEvent;

            // Applying a start event must be idempotent. The same start can
            // reach this reducer twice — a tool call already carried in
            // `agent.messages` from an earlier run and then replayed by the
            // backend (the HITL path does this when the run re-syncs after
            // `respond()`), or one stream re-delivered over two transports.
            // Appending unconditionally would leave the assistant message
            // holding the id twice, and the second copy stays empty because
            // TOOL_CALL_ARGS resolves to the first match. That malformed
            // message is then what travels back to the provider on the next
            // turn. Resolve the existing entry the same way TOOL_CALL_ARGS
            // does, and do it before resolveOrCreateAssistantMessage so a
            // replay can't append a stray empty assistant message either.
            const ownerMessage = messages.find((m) =>
              (m as AssistantMessage).toolCalls?.some((tc) => tc.id === toolCallId),
            ) as AssistantMessage | undefined;
            const existingToolCall = ownerMessage?.toolCalls?.find((tc) => tc.id === toolCallId);

            if (existingToolCall) {
              // Update the existing entry instead of pushing a second one, and
              // leave `arguments` untouched — a start event carries none, so
              // the copy already in state holds the only streamed args.
              const renamed = existingToolCall.function.name !== toolCallName;
              if (renamed) {
                console.warn(
                  `TOOL_CALL_START: tool call '${toolCallId}' already exists with name ` +
                    `'${existingToolCall.function.name}' — updating it to '${toolCallName}'`,
                );
                existingToolCall.function.name = toolCallName;
              }

              if (applyEventMetadata(existingToolCall, event) || renamed) {
                applyMutation({ messages });
              }

              return emitUpdates();
            }

            const targetMessage = resolveOrCreateAssistantMessage(
              messages,
              parentMessageId,
              toolCallId,
            );

            targetMessage.toolCalls ??= [];

            // Add the new tool call
            const newToolCall: ToolCall = {
              id: toolCallId,
              type: "function",
              function: {
                name: toolCallName,
                arguments: "",
              },
            };
            targetMessage.toolCalls.push(newToolCall);

            applyEventMetadata(newToolCall, event);

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TOOL_CALL_ARGS: {
          const { toolCallId, delta } = event as ToolCallArgsEvent;

          // Find the message containing this tool call
          const targetMessage = messages.find((m) =>
            (m as AssistantMessage).toolCalls?.some((tc) => tc.id === toolCallId),
          ) as AssistantMessage;

          if (!targetMessage) {
            console.warn(
              `TOOL_CALL_ARGS: No message found containing tool call with ID '${toolCallId}'`,
            );
            return emitUpdates();
          }

          // Find the specific tool call
          const targetToolCall = targetMessage.toolCalls?.find((tc) => tc.id === toolCallId);
          if (!targetToolCall) {
            console.warn(`TOOL_CALL_ARGS: No tool call found with ID '${toolCallId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) => {
              const toolCallBuffer = targetToolCall.function.arguments;
              const toolCallName = targetToolCall.function.name;
              let partialToolCallArgs = {};
              try {
                // Parse from toolCallBuffer only (before current delta is applied)
                partialToolCallArgs = untruncateJson(toolCallBuffer);
              } catch (_error) {
                // Streaming args are mid-flight and frequently unparseable;
                // fall through with the last good partial object.
              }

              return subscriber.onToolCallArgsEvent?.({
                event: event as ToolCallArgsEvent,
                messages,
                state,
                agent,
                input,
                toolCallBuffer,
                toolCallName,
                partialToolCallArgs,
              });
            },
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            // Append the arguments to the correct tool call by ID
            targetToolCall.function.arguments += delta;
            applyEventMetadata(targetToolCall, event);
            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TOOL_CALL_END: {
          const { toolCallId } = event as ToolCallEndEvent;

          // Find the message containing this tool call
          const targetMessage = messages.find((m) =>
            (m as AssistantMessage).toolCalls?.some((tc) => tc.id === toolCallId),
          ) as AssistantMessage;

          if (!targetMessage) {
            console.warn(
              `TOOL_CALL_END: No message found containing tool call with ID '${toolCallId}'`,
            );
            return emitUpdates();
          }

          // Find the specific tool call
          const targetToolCall = targetMessage.toolCalls?.find((tc) => tc.id === toolCallId);
          if (!targetToolCall) {
            console.warn(`TOOL_CALL_END: No tool call found with ID '${toolCallId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) => {
              const toolCallArgsString = targetToolCall.function.arguments;
              const toolCallName = targetToolCall.function.name;
              let toolCallArgs = {};
              try {
                toolCallArgs = JSON.parse(toolCallArgsString);
              } catch (_error) {
                // A malformed final payload must not abort the run; downstream
                // sees the empty object.
              }
              return subscriber.onToolCallEndEvent?.({
                event: event as ToolCallEndEvent,
                messages,
                state,
                agent,
                input,
                toolCallName,
                toolCallArgs,
              });
            },
          );
          applyMutation(mutation);

          // Merge before onNewToolCall, for the same reason as TEXT_MESSAGE_END:
          // an end event carries the values only known once the call is closed.
          if (mutation.stopPropagation !== true && applyEventMetadata(targetToolCall, event)) {
            applyMutation({ messages });
          }

          await Promise.all(
            subscribers.map((subscriber) => {
              subscriber.onNewToolCall?.({
                toolCall: targetToolCall,
                messages,
                state,
                agent,
                input,
              });
            }),
          );

          return emitUpdates();
        }

        case EventType.TOOL_CALL_RESULT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onToolCallResultEvent?.({
                event: event as ToolCallResultEvent,
                messages,
                state,
                agent,
                input,
              }),
          );

          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messageId, toolCallId, content, role } = event as ToolCallResultEvent;

            const toolMessage: ToolMessage = {
              id: messageId,
              toolCallId,
              role: role || "tool",
              content: content,
            };

            applyEventMetadata(toolMessage, event);

            // Place the tool result immediately after the assistant message that
            // issued the matching tool call — not at the end. A result event can
            // arrive after a trailing assistant text message (e.g. a
            // chat -> tool -> chat loop streams the follow-up text before the
            // result is recorded). Appending would leave the history as
            // assistant(tool_call) -> text -> tool, which violates the provider
            // contract that an assistant tool_call is immediately followed by its
            // tool result and surfaces downstream as a 400. Skip past any tool
            // results already recorded for the same assistant so parallel results
            // keep their order. Fall back to append when no owner is found.
            const ownerIndex = messages.findIndex(
              (m) =>
                m.role === "assistant" &&
                (m as AssistantMessage).toolCalls?.some((tc) => tc.id === toolCallId),
            );
            if (ownerIndex === -1) {
              messages.push(toolMessage);
            } else {
              let insertAt = ownerIndex + 1;
              while (insertAt < messages.length && messages[insertAt].role === "tool") {
                insertAt++;
              }
              messages.splice(insertAt, 0, toolMessage);
            }

            await Promise.all(
              subscribers.map((subscriber) => {
                subscriber.onNewMessage?.({
                  message: toolMessage,
                  messages,
                  state,
                  agent,
                  input,
                });
              }),
            );

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.STATE_SNAPSHOT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStateSnapshotEvent?.({
                event: event as StateSnapshotEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { snapshot } = event as StateSnapshotEvent;

            // Replace state with the literal snapshot
            state = snapshot;

            applyMutation({ state });
          }

          return emitUpdates();
        }

        case EventType.STATE_DELTA: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStateDeltaEvent?.({
                event: event as StateDeltaEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { delta } = event as StateDeltaEvent;

            try {
              // Apply the JSON Patch operations to the current state without mutating the original
              const result = jsonpatch.applyPatch(state, delta, true, false);
              state = result.newDocument;
              applyMutation({ state });
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.warn(
                `Failed to apply state patch:\nCurrent state: ${JSON.stringify(state, null, 2)}\nPatch operations: ${JSON.stringify(delta, null, 2)}\nError: ${errorMessage}`,
              );
              // If patch failed, only emit updates if there were subscriber mutations
              // This prevents emitting updates when both patch fails AND no subscriber mutations
            }
          }

          return emitUpdates();
        }

        case EventType.MESSAGES_SNAPSHOT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onMessagesSnapshotEvent?.({
                event: event as MessagesSnapshotEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messages: newMessages } = event as MessagesSnapshotEvent;

            // Edit-based merge: update existing messages with snapshot data while
            // preserving client-only messages the backend leaves out of the
            // snapshot.
            const snapshotMap = new Map(newMessages.map((m) => [m.id, m]));

            // `activity` messages are only sometimes client-only. They never
            // travel back to the backend — `prepareRunAgentInput` strips them
            // from RunAgentInput — so a backend that does not track them cannot
            // put them in the snapshot, and the local copies must be preserved.
            // But a backend that does track them re-delivers the whole set it
            // owns. Since a MESSAGES_SNAPSHOT is a snapshot of every message,
            // once it carries any activity the backend is declaring the complete
            // activity set, and one it leaves out has been removed — preserving
            // it would make the local copy undeletable. So when the snapshot
            // itself carries activity, treat it as the source of truth for
            // activity messages and apply the normal replace semantics.
            //
            // `reasoning` messages are only sometimes client-only. Most backends
            // never include reasoning in the snapshot (it exists purely as
            // streamed REASONING_* events), so dropping local reasoning here
            // would lose it. But a backend that round-trips reasoning (e.g.
            // LangGraph re-deriving it from checkpointed content blocks)
            // re-delivers the streamed reasoning under its own canonical id —
            // message ids are generally NOT stable between streamed events and
            // the snapshot. Preserving the streamed copy next to the snapshot
            // copy would render the same reasoning twice. So when the snapshot
            // itself carries reasoning, treat it as the source of truth for
            // reasoning messages too and apply the normal replace semantics.
            const snapshotHasActivity = newMessages.some((m) => m.role === "activity");
            const snapshotHasReasoning = newMessages.some((m) => m.role === "reasoning");
            const isPreservedClientOnly = (m: Message) =>
              (m.role === "activity" && !snapshotHasActivity) ||
              (m.role === "reasoning" && !snapshotHasReasoning);

            // Step 1 + 2: Keep preserved client-only messages as-is, keep
            // messages present in the snapshot (replaced with snapshot version),
            // drop everything else.
            messages = messages
              .filter((m) => isPreservedClientOnly(m) || snapshotMap.has(m.id))
              .map((m) => (isPreservedClientOnly(m) ? m : snapshotMap.get(m.id)!));

            // Step 3: Append messages from the snapshot that we don't have yet.
            const existingIds = new Set(messages.map((m) => m.id));
            for (const snapshotMsg of newMessages) {
              if (!existingIds.has(snapshotMsg.id)) {
                messages.push(snapshotMsg);
              }
            }

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.ACTIVITY_SNAPSHOT: {
          const activityEvent = event as ActivitySnapshotEvent;
          const existingIndex = messages.findIndex((m) => m.id === activityEvent.messageId);
          const existingMessage = existingIndex >= 0 ? messages[existingIndex] : undefined;
          const existingActivityMessage =
            existingMessage?.role === "activity" ? (existingMessage as ActivityMessage) : undefined;
          const replace = activityEvent.replace ?? true;

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onActivitySnapshotEvent?.({
                event: activityEvent,
                messages,
                state,
                agent,
                input,
                activityMessage: existingActivityMessage,
                existingMessage,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const activityMessage: ActivityMessage = {
              id: activityEvent.messageId,
              role: "activity",
              activityType: activityEvent.activityType,
              content: structuredClone_(activityEvent.content),
            };

            let createdMessage: ActivityMessage | undefined;
            let mergeTarget: Message | undefined;

            if (existingIndex === -1) {
              messages.push(activityMessage);
              createdMessage = activityMessage;
              mergeTarget = activityMessage;
            } else if (existingActivityMessage) {
              if (replace) {
                // Spread carries the accumulated metadata across the replace —
                // a snapshot replaces content, not the metadata built up so far.
                messages[existingIndex] = {
                  ...existingActivityMessage,
                  activityType: activityEvent.activityType,
                  content: structuredClone_(activityEvent.content),
                };
              }
              mergeTarget = messages[existingIndex];
            } else if (replace) {
              messages[existingIndex] = activityMessage;
              createdMessage = activityMessage;
              mergeTarget = activityMessage;
            }

            applyEventMetadata(mergeTarget, activityEvent);

            applyMutation({ messages });

            if (createdMessage) {
              await Promise.all(
                subscribers.map((subscriber) =>
                  subscriber.onNewMessage?.({
                    message: createdMessage,
                    messages,
                    state,
                    agent,
                    input,
                  }),
                ),
              );
            }
          }

          return emitUpdates();
        }

        case EventType.ACTIVITY_DELTA: {
          const activityEvent = event as ActivityDeltaEvent;
          const existingIndex = messages.findIndex((m) => m.id === activityEvent.messageId);
          if (existingIndex === -1) {
            return emitUpdates();
          }

          const existingMessage = messages[existingIndex];
          if (existingMessage.role !== "activity") {
            console.warn(
              `ACTIVITY_DELTA: Message '${activityEvent.messageId}' is not an activity message`,
            );
            return emitUpdates();
          }

          const existingActivityMessage = existingMessage as ActivityMessage;

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onActivityDeltaEvent?.({
                event: activityEvent,
                messages,
                state,
                agent,
                input,
                activityMessage: existingActivityMessage,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            try {
              // Metadata does not depend on the patch succeeding — a stale path
              // should not cost the message its usage or trace keys — so merge
              // it before attempting the patch and emit it either way.
              if (applyEventMetadata(existingActivityMessage, activityEvent)) {
                applyMutation({ messages });
              }

              const baseContent = structuredClone_(existingActivityMessage.content ?? {});

              const result = jsonpatch.applyPatch(
                baseContent,
                activityEvent.patch ?? [],
                true,
                false,
              );
              const updatedContent = result.newDocument as ActivityMessage["content"];

              // The spread carries the metadata merged above.
              messages[existingIndex] = {
                ...existingActivityMessage,
                content: structuredClone_(updatedContent),
                activityType: activityEvent.activityType,
              };

              applyMutation({ messages });
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.warn(
                `Failed to apply activity patch for '${activityEvent.messageId}': ${errorMessage}`,
              );
            }
          }

          return emitUpdates();
        }

        case EventType.RAW: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRawEvent?.({
                event: event as RawEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.CUSTOM: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onCustomEvent?.({
                event: event as CustomEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.RUN_STARTED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunStartedEvent?.({
                event: event as RunStartedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          // Handle input.messages if present and stopPropagation is not set
          if (mutation.stopPropagation !== true) {
            const runStartedEvent = event as RunStartedEvent;

            // Check if the event contains input with messages
            if (runStartedEvent.input?.messages) {
              // Add messages that aren't already present (checked by ID)
              for (const message of runStartedEvent.input.messages) {
                const existingMessage = messages.find((m) => m.id === message.id);
                if (!existingMessage) {
                  messages.push(message);
                }
              }

              // Apply mutation to emit the updated messages
              applyMutation({ messages });
            }
          }

          return emitUpdates();
        }

        case EventType.RUN_FINISHED: {
          const e = event as RunFinishedEvent;
          const finishedParams =
            e.outcome?.type === "interrupt"
              ? ({
                  event: e,
                  outcome: "interrupt" as const,
                  interrupts: e.outcome.interrupts,
                } as const)
              : ({ event: e, outcome: "success" as const, result: e.result } as const);
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunFinishedEvent?.({
                ...finishedParams,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          // Update pending interrupts AFTER subscribers run, and only if no
          // subscriber suppressed the event — matches the lifecycle pattern
          // used by every other case in this switch. Defensive-copy the
          // interrupt list so consumers that hold the original event payload
          // can't mutate the agent's tracked state through array aliasing.
          if (mutation.stopPropagation !== true) {
            agent.pendingInterrupts =
              finishedParams.outcome === "interrupt" ? [...finishedParams.interrupts] : [];
          }

          return emitUpdates();
        }

        case EventType.RUN_ERROR: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunErrorEvent?.({
                event: event as RunErrorEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.STEP_STARTED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStepStartedEvent?.({
                event: event as StepStartedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.STEP_FINISHED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStepFinishedEvent?.({
                event: event as StepFinishedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_CHUNK: {
          throw new Error("TEXT_MESSAGE_CHUNK must be tranformed before being applied");
        }

        case EventType.TOOL_CALL_CHUNK: {
          throw new Error("TOOL_CALL_CHUNK must be tranformed before being applied");
        }

        case EventType.THINKING_START: {
          return emitUpdates();
        }

        case EventType.THINKING_END: {
          return emitUpdates();
        }

        case EventType.THINKING_TEXT_MESSAGE_START: {
          return emitUpdates();
        }

        case EventType.THINKING_TEXT_MESSAGE_CONTENT: {
          return emitUpdates();
        }

        case EventType.THINKING_TEXT_MESSAGE_END: {
          return emitUpdates();
        }

        case EventType.REASONING_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningStartEvent?.({
                event: event as ReasoningStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }

        case EventType.REASONING_MESSAGE_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningMessageStartEvent?.({
                event: event as ReasoningMessageStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messageId } = event as ReasoningMessageStartEvent;
            const existingMessage = messages.find((m) => m.id === messageId);
            let targetMessage = existingMessage;

            if (!targetMessage) {
              const newMessage: ReasoningMessage = {
                id: messageId,
                role: "reasoning",
                content: "",
              };
              messages.push(newMessage);
              targetMessage = newMessage;
            }

            const metadataChanged = applyEventMetadata(targetMessage, event);
            if (!existingMessage || metadataChanged) {
              applyMutation({ messages });
            }
          }
          return emitUpdates();
        }

        case EventType.REASONING_MESSAGE_CONTENT: {
          const { messageId, delta } = event as ReasoningMessageContentEvent;

          const targetMessage = messages.find((m) => m.id === messageId);
          if (!targetMessage) {
            console.warn(`REASONING_MESSAGE_CONTENT: No message found with ID '${messageId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningMessageContentEvent?.({
                event: event as ReasoningMessageContentEvent,
                messages,
                state,
                agent,
                input,
                reasoningMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const existingContent =
              typeof targetMessage.content === "string" ? targetMessage.content : "";
            targetMessage.content = `${existingContent}${delta}`;
            applyEventMetadata(targetMessage, event);
            applyMutation({ messages });
          }
          return emitUpdates();
        }

        case EventType.REASONING_MESSAGE_END: {
          const { messageId } = event as ReasoningMessageEndEvent;

          const targetMessage = messages.find((m) => m.id === messageId);
          if (!targetMessage) {
            console.warn(`REASONING_MESSAGE_END: No message found with ID '${messageId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningMessageEndEvent?.({
                event: event as ReasoningMessageEndEvent,
                messages,
                state,
                agent,
                input,
                reasoningMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true && applyEventMetadata(targetMessage, event)) {
            applyMutation({ messages });
          }

          await Promise.all(
            subscribers.map((subscriber) => {
              subscriber.onNewMessage?.({
                message: targetMessage,
                messages,
                state,
                agent,
                input,
              });
            }),
          );

          return emitUpdates();
        }

        case EventType.REASONING_MESSAGE_CHUNK: {
          throw new Error("REASONING_MESSAGE_CHUNK must be transformed before being applied");
        }

        case EventType.REASONING_END: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningEndEvent?.({
                event: event as ReasoningEndEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }

        // REASONING_ENCRYPTED_VALUE attaches an encrypted blob to an entity that
        // already exists; it does not build one, so its metadata stays on the
        // event, like REASONING_START and REASONING_END. That also keeps the
        // compaction invariant intact: `compactEvents` buffers an event arriving
        // mid-stream and flushes it *after* the END it originally preceded, so
        // merging its metadata into the same entity would make a compacted
        // replay disagree with the original stream.
        case EventType.REASONING_ENCRYPTED_VALUE: {
          const { subtype, entityId, encryptedValue } = event as ReasoningEncryptedValueEvent;
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningEncryptedValueEvent?.({
                event: event as ReasoningEncryptedValueEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          if (mutation.stopPropagation !== true) {
            let entityUpdated = false;
            if (subtype === "tool-call") {
              // Find tool call by entityId and set encryptedValue
              for (const message of messages) {
                if (message.role === "assistant" && message.toolCalls) {
                  const toolCall = message.toolCalls.find((tc) => tc.id === entityId);
                  if (toolCall) {
                    toolCall.encryptedValue = encryptedValue;
                    entityUpdated = true;
                    break;
                  }
                }
              }
            } else {
              // subtype is "message"
              // Find message by entityId and set encryptedValue
              const message = messages.find((m) => m.id === entityId);
              // Activity messages do not have encryptedValue
              if (message?.role !== "activity" && message) {
                message.encryptedValue = encryptedValue;
                entityUpdated = true;
              }
            }
            if (entityUpdated) {
              currentMutation.messages = messages;
            }
          }
          return emitUpdates();
        }
      }

      // This makes TypeScript check that the switch is exhaustive
      // If a new EventType is added, this will cause a compile error
      const _exhaustiveCheck: never = event.type;
      return emitUpdates();
    }),
    mergeAll(),
    // Only use defaultIfEmpty when there are subscribers to avoid emitting empty updates
    // when patches fail and there are no subscribers (like in state patching test)
    subscribers.length > 0 ? defaultIfEmpty({} as AgentStateMutation) : <T>(stream: T) => stream,
  );
};

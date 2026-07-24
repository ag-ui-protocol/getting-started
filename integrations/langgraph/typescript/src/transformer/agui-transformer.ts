/**
 * AG-UI StreamTransformer.
 *
 * Wired into a graph at compile time via `streamTransformers: [aguiTransformer]`.
 * Exposes a named `agui` channel reached by SDK clients via
 * `thread.extensions.agui`. Translates langgraph `ProtocolEvent`s into AG-UI
 * events across every family: lifecycle (RUN_*, STEP_*), messages (TEXT_*,
 * TOOL_CALL_*, REASONING_*), state (STATE_SNAPSHOT / MESSAGES_SNAPSHOT),
 * tasks (CUSTOM `OnInterrupt`), and custom (ManuallyEmit* + generic
 * passthrough). RUN_STARTED / RUN_FINISHED are owned by `agent.ts`; this
 * factory pushes everything in between.
 */

import {
  StreamChannel,
  type ProtocolEvent,
  type StreamTransformer,
} from "@langchain/langgraph";
import { langchainMessagesToAgui } from "../utils";
import {
  CustomEventNames,
  LangGraphEventTypes,
  ProcessedEvents,
  State,
} from "../types";
import { EventType } from "@ag-ui/core";

/**
 * Factory returning the transformer instance. Each run gets a fresh remote
 * `agui` channel; SDK clients consume via `thread.extensions.agui`.
 */
export const aguiTransformer = (): StreamTransformer<{
  agui: StreamChannel<ProcessedEvents>;
}> => {
  const aguiChannel = StreamChannel.remote<ProcessedEvents>("agui");
  let initialized = false;
  // Set once a terminal RUN_ERROR has been pushed (root `failed`
  // lifecycle). AG-UI grammar forbids ANY event after RUN_ERROR, so
  // every subsequent push — including finalize()'s block/step closes —
  // is suppressed once this flips.
  let runErrored = false;

  // Per-message tracking for text streaming. Keyed by content-block index so
  // multi-block messages (e.g. text + tool call in one assistant turn) don't
  // collide on a single shared id.
  const textBlockMessageIds = new Map<number, string>();
  // Per-tool-call tracking. Keyed by content-block index. Each tool call
  // occupies one block; the chunk's id may be null until later updates so we
  // also remember the assigned toolCallId here. `argsSoFar` carries the
  // cumulative `args` string the engine has reported — block-delta carries
  // the FULL accumulated value each time, not an incremental piece, so we
  // diff against this to derive the delta AG-UI expects.
  // `started` tracks whether TOOL_CALL_START has been emitted yet. When a
  // tool block opens without a name (the name only arrives on a later
  // block-delta), we defer the START so it never goes out with a knowingly
  // empty toolCallName, and buffer `argsSoFar` until we can flush it.
  const toolBlocks = new Map<
    number,
    {
      toolCallId: string;
      toolCallName: string;
      argsSoFar: string;
      started: boolean;
      parentMessageId?: string;
    }
  >();
  let activeMessageId: string | undefined;
  // Whether the bare `activeMessageId` has already been handed to a text
  // content-block in the current message. The first text block keeps the
  // bare id so the streamed message reconciles with the MESSAGES_SNAPSHOT
  // copy emitted under the same id; any additional text blocks in the same
  // message get a distinct suffixed id so we never emit two
  // TEXT_MESSAGE_START for one id. Reset at each message boundary.
  let bareTextIdAssigned = false;

  // Per-reasoning-block tracking. Keyed by content-block index. The
  // standardized v3 format (per langgraph streaming-cookbook) emits
  // reasoning content blocks with `type: "reasoning"` and an optional
  // initial `reasoning` string on start; deltas use
  // `type: "reasoning-delta"` with a `reasoning` field. Encrypted
  // material from Anthropic surfaces as `redacted_thinking` blocks
  // (with `data`) or as a `signature` field on a reasoning block.
  const reasoningBlocks = new Map<
    number,
    { messageId: string; messageStarted: boolean }
  >();

  // Per-run set of interrupt ids already converted into CUSTOM
  // `OnInterrupt` pushes. Each `tasks` event carrying interrupts can
  // fire multiple times during the run (input + result frames); dedup
  // by interrupt id so the client only renders one prompt.
  const emittedInterruptIds = new Set<string>();

  // Active graph-node steps keyed by full namespace path → stepName.
  // The companion `activeStepNames` enforces AG-UI's name-uniqueness
  // contract: at most one STEP_STARTED per stepName at a time. Inner
  // subgraph nodes whose stripped head name collides with an already
  // active step (e.g. an outer `experiences_agent` plus its inner
  // graph also rooted under `experiences_agent`) are ignored so the
  // outer STEP_FINISHED stays balanced.
  const activeSteps = new Map<string, string>();
  const activeStepNames = new Set<string>();

  const push = (ev: ProcessedEvents) => {
    // Nothing may follow a terminal RUN_ERROR. Drop late pushes so a
    // block/step close (or any stray trailing event) can never trail it.
    if (runErrored) return;
    aguiChannel.push(ev);
  };

  const isRootNamespace = (ns: readonly string[]) => ns.length === 0;

  // Allocate the message id for a text content-block. See `bareTextIdAssigned`.
  const allocateTextMessageId = (index: number): string => {
    if (!bareTextIdAssigned) {
      bareTextIdAssigned = true;
      return activeMessageId as string;
    }
    return `${activeMessageId}:t:${index}`;
  };

  // Emit TOOL_CALL_START for a deferred tool block exactly once, flushing any
  // args buffered while we waited for the name. Idempotent: safe to call from
  // both the name-arrival path and every close path (so a tool that never got
  // a name still produces a balanced START/END pair before its END).
  const ensureToolStarted = (tool: {
    toolCallId: string;
    toolCallName: string;
    argsSoFar: string;
    started: boolean;
    parentMessageId?: string;
  }) => {
    if (tool.started) return;
    tool.started = true;
    push({
      type: EventType.TOOL_CALL_START,
      toolCallId: tool.toolCallId,
      toolCallName: tool.toolCallName,
      parentMessageId: tool.parentMessageId,
    });
    if (tool.argsSoFar.length > 0) {
      push({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: tool.toolCallId,
        delta: tool.argsSoFar,
      });
    }
  };

  // Close every open message-scoped block (text / tool / reasoning), emitting
  // the matching END events so the stream stays balanced, then clear the
  // trackers. Shared by finalize() (run end), message-finish, and
  // message-error so none of them can leave a dangling START. Steps are
  // run-scoped, not message-scoped, so they are NOT closed here.
  const closeOpenMessageBlocks = () => {
    for (const [index, messageId] of textBlockMessageIds) {
      push({ type: EventType.TEXT_MESSAGE_END, messageId });
      textBlockMessageIds.delete(index);
    }
    for (const [index, tool] of toolBlocks) {
      ensureToolStarted(tool);
      push({ type: EventType.TOOL_CALL_END, toolCallId: tool.toolCallId });
      toolBlocks.delete(index);
    }
    for (const [index, r] of reasoningBlocks) {
      if (r.messageStarted)
        push({ type: EventType.REASONING_MESSAGE_END, messageId: r.messageId });
      push({ type: EventType.REASONING_END, messageId: r.messageId });
      reasoningBlocks.delete(index);
    }
  };

  // Close every run-scoped step still open, emitting the matching
  // STEP_FINISHED. Shared by finalize() (run end) and the root `failed`
  // path so a run that errors mid-step stays balanced with the close
  // preceding the terminal RUN_ERROR.
  const closeOpenSteps = () => {
    for (const [nsKey, stepName] of activeSteps) {
      push({ type: EventType.STEP_FINISHED, stepName });
      activeSteps.delete(nsKey);
      activeStepNames.delete(stepName);
    }
  };

  // Defer snapshot emission until the run reaches a stable point. Each
  // Pregel step (including transient sub-steps inside copilotkitMiddleware
  // that intercept then restore tool calls) emits its own `values` event;
  // pushing a MESSAGES_SNAPSHOT for each one ships the in-between dip where
  // the assistant message has lost its tool calls. Mirrors the legacy
  // agent's behaviour, which only reads the canonical persisted state at
  // run end.
  let latestState: State | null = null;
  let lastMessagesSnapshotHash = "";
  let lastStateSnapshotHash = "";
  // Reasoning ids already surfaced from message additional_kwargs (below), so
  // repeated flushes don't re-emit the same reasoning summary.
  const emittedReasoningIds = new Set<string>();
  // Set when a `messages`-channel reasoning content block streamed (the path
  // above). When reasoning already streamed we must NOT also surface it from
  // additional_kwargs, or the same summary would render twice.
  let sawStreamingReasoning = false;

  // OpenAI Responses reasoning rides on the assistant message's
  // `additional_kwargs.reasoning` ({ id, summary: [{ text }], ... }) rather
  // than as a `messages`-channel content block, so the streaming reasoning
  // path above never sees it. Surface any such summary as a REASONING entity
  // once the full message is known (flushSnapshots).
  const emitMessageReasoning = (messages: any[]) => {
    if (sawStreamingReasoning) return;
    for (const msg of messages ?? []) {
      const reasoning = msg?.additional_kwargs?.reasoning;
      const id = reasoning?.id;
      if (!id || emittedReasoningIds.has(id)) continue;
      const summary = reasoning?.summary;
      if (!Array.isArray(summary) || summary.length === 0) continue;
      const text = summary
        .map((p: any) => (p && typeof p.text === "string" ? p.text : ""))
        .join("");
      if (!text) continue;
      emittedReasoningIds.add(id);
      const messageId = String(id);
      push({ type: EventType.REASONING_START, messageId });
      push({
        type: EventType.REASONING_MESSAGE_START,
        messageId,
        role: "reasoning",
      });
      push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: text });
      push({ type: EventType.REASONING_MESSAGE_END, messageId });
      push({ type: EventType.REASONING_END, messageId });
    }
  };

  const cacheState = (state: State) => {
    if (!state || typeof state !== "object") return;
    // Shallow-merge instead of replace. Subsequent root `values` events
    // may carry only the keys that just changed (e.g. an interrupt
    // update without `messages` rebroadcast); replacing wholesale would
    // drop the unchanged keys and ship an empty MESSAGES_SNAPSHOT,
    // which CopilotKit treats as "no messages" and resets the UI.
    latestState = { ...(latestState ?? {}), ...state };
  };

  const flushSnapshots = () => {
    if (!latestState) return;
    const state = latestState;

    const { messages: _m, ...stateOnly } = state;
    const stateHash = JSON.stringify(stateOnly);
    if (stateHash !== lastStateSnapshotHash) {
      lastStateSnapshotHash = stateHash;
      push({ type: EventType.STATE_SNAPSHOT, snapshot: stateOnly });
    }

    const lcMessages = state.messages ?? [];
    // Surface reasoning summaries carried on message additional_kwargs before
    // the snapshot, so consumers see the REASONING entity for this message.
    emitMessageReasoning(lcMessages);
    const aguiMessages = langchainMessagesToAgui(lcMessages);
    const msgHash = JSON.stringify(aguiMessages);
    if (msgHash !== lastMessagesSnapshotHash) {
      lastMessagesSnapshotHash = msgHash;
      push({ type: EventType.MESSAGES_SNAPSHOT, messages: aguiMessages });
    }
  };

  return {
    init() {
      initialized = true;
      return { agui: aguiChannel };
    },

    finalize() {
      // A root `failed` already closed blocks/steps and emitted the
      // terminal RUN_ERROR; nothing may follow it, so skip entirely.
      if (runErrored) return;
      // Lifecycle (RUN_*) is owned by agent.ts. Here we only close any
      // text/tool/reasoning blocks that didn't receive their
      // `content-block-finish` before the run ended, so AG-UI verify
      // doesn't reject the terminal event downstream.
      closeOpenMessageBlocks();
      closeOpenSteps();
    },

    process(event: ProtocolEvent): boolean {
      // Mux wires the channel only after init() returns. Pushes before then
      // are dropped on the wire. Skip until init has completed.
      if (!initialized) return true;

      switch (event.method) {
        case "lifecycle": {
          const status = (event.params.data as { event?: string } | undefined)
            ?.event;

          // Non-root lifecycle events bracket individual graph nodes.
          // Translate them to AG-UI STEP_STARTED / STEP_FINISHED so
          // consumers can show progress on multi-node graphs. The
          // namespace head is `nodeName:uuid` — strip the uuid for a
          // readable step name. AG-UI verify enforces a single active
          // step per stepName, so we dedup by stepName and remember
          // which namespace opened it; only that namespace's close
          // emits STEP_FINISHED. Nested subgraph lifecycles whose
          // stripped head name matches an already-active step (e.g.
          // a subgraph node and an inner node both rooted under
          // `experiences_agent`) are ignored — both ends would
          // otherwise unbalance the pair.
          if (!isRootNamespace(event.params.namespace)) {
            const head = event.params.namespace[0];
            const nsKey = event.params.namespace.join("|");
            const stepName = typeof head === "string" ? head.split(":")[0] : "";
            if (!stepName) break;
            if (status === "started") {
              if (!activeStepNames.has(stepName)) {
                activeStepNames.add(stepName);
                activeSteps.set(nsKey, stepName);
                push({ type: EventType.STEP_STARTED, stepName });
              }
            } else if (
              status === "completed" ||
              status === "failed" ||
              status === "interrupted"
            ) {
              const tracked = activeSteps.get(nsKey);
              if (tracked) {
                activeSteps.delete(nsKey);
                activeStepNames.delete(tracked);
                push({ type: EventType.STEP_FINISHED, stepName: tracked });
              }
              // Lock in state at every node/subgraph boundary. A
              // subgraph (or any node) can mutate state across many
              // intermediate `values` events; flushing here ships a
              // single coherent STATE_SNAPSHOT + MESSAGES_SNAPSHOT at
              // the point its contribution is committed to the parent
              // checkpoint. Snapshot push is hash-deduped, so flushing
              // at every boundary is cheap when nothing changed.
              if (status === "completed") flushSnapshots();
            }
            break;
          }

          // Lifecycle bracketing (RUN_STARTED / RUN_FINISHED) is owned by
          // agent.ts. Here we only forward fatal failures so the client can
          // surface the underlying message instead of a generic
          // INCOMPLETE_STREAM error.
          if (status === "completed" || status === "interrupted") {
            // Stable point: the run is paused (interrupted) or done
            // (completed). The state we cached from the last `values`
            // event reflects the canonical shape at this boundary.
            // Flush snapshots so consumers see updated state at both
            // run end and interrupt — HITL graphs land here on every
            // interrupt() call.
            flushSnapshots();
          } else if (status === "failed") {
            const message = (
              event.params.data as { error?: string } | undefined
            )?.error;
            // Close any open text/tool/reasoning blocks and steps FIRST so
            // their END events precede the terminal RUN_ERROR. AG-UI grammar
            // forbids events after RUN_ERROR; deferring these to finalize()
            // (as before) trailed the END events behind it. Mirrors the
            // message-error path's close-open-blocks-before-terminal ordering.
            closeOpenMessageBlocks();
            closeOpenSteps();
            push({
              type: EventType.RUN_ERROR,
              message: message ?? "Unknown error",
            });
            // Latch so finalize() and any stray trailing push are suppressed.
            runErrored = true;
          }
          break;
        }

        case "input.requested": {
          // The graph hit an interrupt(...) call. Forward as AG-UI
          // CUSTOM `OnInterrupt`, matching the legacy contract so dojo
          // (and other clients) can render the same prompt UI they
          // already drive off the legacy translation.
          const data = event.params?.data as
            | { interrupt_id?: string; payload?: unknown }
            | undefined;
          if (!data) break;
          // Dedup by interrupt id, mirroring the `tasks` path: the same
          // interrupt can be re-broadcast (input + result frames) and the
          // client should only render one prompt. Only ids we've seen are
          // skipped; frames without an id fall through (can't dedup).
          if (data.interrupt_id) {
            if (emittedInterruptIds.has(data.interrupt_id)) break;
            emittedInterruptIds.add(data.interrupt_id);
          }
          // `JSON.stringify(undefined)` returns the value `undefined`, not a
          // string, but AG-UI CUSTOM requires a string value. Coerce, mapping
          // a bare/undefined payload to the string "null".
          const value =
            typeof data.payload === "string"
              ? data.payload
              : JSON.stringify(data.payload ?? null);
          push({
            type: EventType.CUSTOM,
            name: LangGraphEventTypes.OnInterrupt,
            value,
          } as ProcessedEvents);
          break;
        }

        case "messages": {
          const data = event.params.data as
            | {
                event: string;
                role?: string;
                id?: string;
                index?: number;
                content?: { type?: string };
                delta?: { type?: string; text?: string };
              }
            | undefined;
          if (!data) break;

          switch (data.event) {
            case "message-start": {
              // The protocol declares `role` on MessageStartData but the
              // langgraph dev server omits it in practice. Use any
              // message-start as the signal to bind activeMessageId; the
              // downstream content-block-start filter (type === "text")
              // ensures we only emit text events for AI text blocks.
              if (!data.id) break;
              activeMessageId = data.id;
              bareTextIdAssigned = false;
              break;
            }

            case "content-block-start": {
              if (data.index == null) break;
              const blockType = data.content?.type;
              if (blockType === "text") {
                if (!activeMessageId) break;
                const textId = allocateTextMessageId(data.index);
                textBlockMessageIds.set(data.index, textId);
                push({
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: textId,
                  role: "assistant",
                });
              } else if (
                blockType === "reasoning" ||
                blockType === "thinking"
              ) {
                // Standardized v3 format ("reasoning") plus the older
                // langchain-anthropic alias ("thinking"). Treat the
                // content block as a single reasoning entity scoped to
                // the current message + this content-block index.
                if (!activeMessageId) break;
                sawStreamingReasoning = true;
                const reasoningId = `${activeMessageId}:r:${data.index}`;
                reasoningBlocks.set(data.index, {
                  messageId: reasoningId,
                  messageStarted: false,
                });
                push({
                  type: EventType.REASONING_START,
                  messageId: reasoningId,
                });
                const block = data.content as
                  | {
                      reasoning?: string;
                      thinking?: string;
                      signature?: string;
                    }
                  | undefined;
                const initial = block?.reasoning ?? block?.thinking ?? "";
                if (initial.length > 0) {
                  push({
                    type: EventType.REASONING_MESSAGE_START,
                    messageId: reasoningId,
                    role: "reasoning",
                  });
                  reasoningBlocks.get(data.index)!.messageStarted = true;
                  push({
                    type: EventType.REASONING_MESSAGE_CONTENT,
                    messageId: reasoningId,
                    delta: initial,
                  });
                }
                if (block?.signature) {
                  push({
                    type: EventType.REASONING_ENCRYPTED_VALUE,
                    subtype: "message",
                    entityId: reasoningId,
                    encryptedValue: block.signature,
                  } as ProcessedEvents);
                }
              } else if (blockType === "redacted_thinking") {
                // Anthropic redacted_thinking carries opaque encrypted
                // chain-of-thought. Surface as a standalone
                // REASONING_ENCRYPTED_VALUE without opening a
                // visible reasoning message.
                const block = data.content as { data?: string } | undefined;
                if (activeMessageId && block?.data) {
                  push({
                    type: EventType.REASONING_ENCRYPTED_VALUE,
                    subtype: "message",
                    entityId: activeMessageId,
                    encryptedValue: block.data,
                  } as ProcessedEvents);
                }
              } else if (
                blockType === "tool_call_chunk" ||
                blockType === "tool_call"
              ) {
                const block = data.content as
                  | {
                      id?: string | null;
                      name?: string | null;
                      args?: string | null;
                    }
                  | undefined;
                const toolCallId = block?.id ?? `tc-${data.index}`;
                const toolCallName = block?.name ?? "";
                const initialArgs =
                  typeof block?.args === "string" ? block.args : "";
                const tool = {
                  toolCallId,
                  toolCallName,
                  argsSoFar: initialArgs,
                  started: false,
                  parentMessageId: activeMessageId,
                };
                toolBlocks.set(data.index, tool);
                // Only emit TOOL_CALL_START now if we already have the name.
                // When the name is absent it may arrive on a later
                // block-delta; defer the START (and buffer initialArgs) so it
                // never goes out with an empty toolCallName. ensureToolStarted
                // flushes the buffered args when it fires.
                if (toolCallName) ensureToolStarted(tool);
              }
              break;
            }

            case "content-block-delta": {
              if (data.index == null) break;
              const deltaType = data.delta?.type;
              if (deltaType === "text-delta") {
                // Server may emit text deltas at a content-block index
                // already occupied by another type (e.g. reasoning at
                // idx=0, then text deltas at idx=0 with no preceding
                // text content-block-start). Treat that as an implicit
                // open: mint a TEXT_MESSAGE_START on first delta. End
                // is taken care of on message-finish (or finalize).
                let messageId = textBlockMessageIds.get(data.index);
                if (!messageId && activeMessageId) {
                  messageId = allocateTextMessageId(data.index);
                  textBlockMessageIds.set(data.index, messageId);
                  push({
                    type: EventType.TEXT_MESSAGE_START,
                    messageId,
                    role: "assistant",
                  });
                }
                if (!messageId) break;
                push({
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId,
                  delta: data.delta?.text ?? "",
                });
              } else if (
                deltaType === "reasoning-delta" ||
                deltaType === "thinking-delta"
              ) {
                // Standardized v3 reasoning delta + older Anthropic
                // thinking-delta alias.
                const r = reasoningBlocks.get(data.index);
                if (!r) break;
                const delta = data.delta as
                  | { reasoning?: string; thinking?: string }
                  | undefined;
                const text = delta?.reasoning ?? delta?.thinking ?? "";
                if (text.length === 0) break;
                if (!r.messageStarted) {
                  push({
                    type: EventType.REASONING_MESSAGE_START,
                    messageId: r.messageId,
                    role: "reasoning",
                  });
                  r.messageStarted = true;
                }
                push({
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: r.messageId,
                  delta: text,
                });
              } else if (deltaType === "block-delta") {
                // BlockDelta carries shallow-merge fields. For tool calls
                // `args` is the FULL cumulative JSON string, not an
                // incremental piece. AG-UI's TOOL_CALL_ARGS expects a delta,
                // so compute it by stripping the prefix we have already sent.
                const tool = toolBlocks.get(data.index);
                if (!tool) break;
                const fields = (
                  data.delta as
                    | { fields?: { args?: string; name?: string } }
                    | undefined
                )?.fields;
                if (fields?.name && !tool.toolCallName) {
                  tool.toolCallName = fields.name;
                }
                // If START was deferred pending a name and we now have one,
                // emit it (which also flushes the buffered args) before
                // streaming any further args this frame.
                if (!tool.started && tool.toolCallName) {
                  ensureToolStarted(tool);
                }
                if (typeof fields?.args === "string") {
                  const cumulative = fields.args;
                  if (!tool.started) {
                    // Still no name, so START hasn't gone out. Just buffer the
                    // full cumulative; ensureToolStarted will flush it as one
                    // delta once the name arrives (or at close, worst case).
                    tool.argsSoFar = cumulative;
                  } else if (cumulative.startsWith(tool.argsSoFar)) {
                    const delta = cumulative.slice(tool.argsSoFar.length);
                    tool.argsSoFar = cumulative;
                    if (delta.length > 0) {
                      push({
                        type: EventType.TOOL_CALL_ARGS,
                        toolCallId: tool.toolCallId,
                        delta,
                      });
                    }
                  } else {
                    // Engine replaced the buffer in place (arg correction),
                    // so the new value is NOT an extension of what we already
                    // streamed. TOOL_CALL_ARGS is append-only with no
                    // retraction, so re-sending the full new string would give
                    // a delta-concatenating consumer `oldBuffer + newFull`.
                    // Instead emit only the part beyond the longest common
                    // prefix, so we never re-send the shared head. The already
                    // streamed divergent tail can't be retracted here; the
                    // authoritative args are re-delivered in the end-of-run
                    // MESSAGES_SNAPSHOT.
                    let common = 0;
                    const max = Math.min(
                      tool.argsSoFar.length,
                      cumulative.length,
                    );
                    while (
                      common < max &&
                      tool.argsSoFar[common] === cumulative[common]
                    ) {
                      common++;
                    }
                    const delta = cumulative.slice(common);
                    tool.argsSoFar = cumulative;
                    if (delta.length > 0) {
                      push({
                        type: EventType.TOOL_CALL_ARGS,
                        toolCallId: tool.toolCallId,
                        delta,
                      });
                    }
                  }
                }
              }
              break;
            }

            case "content-block-finish": {
              if (data.index == null) break;
              // Dispatch by the FINISHING block's type rather than by
              // tracker-presence. Text and reasoning can share an
              // index (server emits text deltas at the same idx as a
              // reasoning block), so we can't infer the finish target
              // from "first map that has this index".
              const finishType = (data as any)?.content?.type;
              if (finishType === "text") {
                const messageId = textBlockMessageIds.get(data.index);
                if (messageId) {
                  push({ type: EventType.TEXT_MESSAGE_END, messageId });
                  textBlockMessageIds.delete(data.index);
                }
              } else if (
                finishType === "reasoning" ||
                finishType === "thinking"
              ) {
                const r = reasoningBlocks.get(data.index);
                if (r) {
                  if (r.messageStarted) {
                    push({
                      type: EventType.REASONING_MESSAGE_END,
                      messageId: r.messageId,
                    });
                  }
                  push({
                    type: EventType.REASONING_END,
                    messageId: r.messageId,
                  });
                  reasoningBlocks.delete(data.index);
                }
              } else if (
                finishType === "tool_call_chunk" ||
                finishType === "tool_call"
              ) {
                const tool = toolBlocks.get(data.index);
                if (tool) {
                  // Flush a deferred START (name may never have arrived) so
                  // the END has a matching START.
                  ensureToolStarted(tool);
                  push({
                    type: EventType.TOOL_CALL_END,
                    toolCallId: tool.toolCallId,
                  });
                  toolBlocks.delete(data.index);
                }
              }
              break;
            }

            case "message-finish": {
              // Close every block still open on this message. The server can
              // omit `content-block-finish` for implicitly-opened text blocks
              // (text deltas reusing a reasoning block's index) and, in
              // practice, for tool/reasoning blocks too; leaving a tool/
              // reasoning entry in its map would let the next message's block
              // at the same index overwrite it, so TOOL_CALL_START /
              // REASONING_START would never get their END. Flush them all.
              closeOpenMessageBlocks();
              activeMessageId = undefined;
              bareTextIdAssigned = false;
              break;
            }

            case "message-error": {
              // Same as message-finish: the message is done (abnormally), so
              // close every open block first. Clearing the maps without
              // emitting the END events would leave dangling
              // TEXT_MESSAGE_START / TOOL_CALL_START / REASONING_START that
              // finalize() can no longer close, unbalancing the stream.
              closeOpenMessageBlocks();
              activeMessageId = undefined;
              bareTextIdAssigned = false;
              break;
            }
          }
          break;
        }

        case "values": {
          // Cache only — actual snapshot emission happens at root
          // lifecycle.completed. This skips the transient
          // copilotkitMiddleware "intercept then restore" dip where the
          // assistant message briefly loses its tool calls.
          if (!isRootNamespace(event.params.namespace)) break;
          cacheState(event.params.data);
          break;
        }

        case "tasks": {
          // v3 protocol surfaces interrupt() calls as `tasks` events
          // with an `interrupts: [...]` field on the task result —
          // NOT as `input.requested` lifecycle events. The root
          // lifecycle still terminates with `completed`. Scan tasks
          // for interrupt entries and emit AG-UI CUSTOM `OnInterrupt`.
          const data = event.params?.data as
            | {
                id?: string;
                name?: string;
                interrupts?: Array<{ id?: string; value?: unknown }>;
              }
            | undefined;
          if (!data?.interrupts?.length) break;
          for (const it of data.interrupts) {
            if (!it?.id) continue;
            if (emittedInterruptIds.has(it.id)) continue;
            emittedInterruptIds.add(it.id);
            // See the input.requested path: coerce to a string so a bare
            // interrupt (no value) emits "null" rather than the value
            // `undefined`, which AG-UI CUSTOM rejects.
            const value =
              typeof it.value === "string"
                ? it.value
                : JSON.stringify(it.value ?? null);
            push({
              type: EventType.CUSTOM,
              name: LangGraphEventTypes.OnInterrupt,
              value,
            } as ProcessedEvents);
          }
          break;
        }

        case "custom": {
          // Graph nodes can dispatch custom events to drive UI side
          // channels (CopilotKit ManuallyEmit* helpers, app-specific
          // notifications, etc.). v3 routes them through the generic
          // `custom` channel with `data: { name, payload }`. The legacy
          // translator expanded the three well-known ManuallyEmit*
          // names into their concrete AG-UI events and passed through
          // everything else as `CUSTOM`. Mirror that contract here.
          const data = event.params?.data as
            | { name?: string; payload?: any }
            | undefined;
          if (!data?.name) break;
          const name = data.name;
          const payload = data.payload;

          if (name === CustomEventNames.ManuallyEmitMessage) {
            const messageId = payload?.message_id;
            const message = payload?.message;
            if (messageId && typeof message === "string") {
              push({
                type: EventType.TEXT_MESSAGE_START,
                messageId,
                role: "assistant",
              });
              push({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId,
                delta: message,
              });
              push({ type: EventType.TEXT_MESSAGE_END, messageId });
            }
            break;
          }

          if (name === CustomEventNames.ManuallyEmitToolCall) {
            const toolCallId = payload?.id;
            const toolCallName = payload?.name;
            const args = payload?.args;
            if (toolCallId && toolCallName) {
              push({
                type: EventType.TOOL_CALL_START,
                toolCallId,
                toolCallName,
                parentMessageId: toolCallId,
              });
              if (typeof args === "string" && args.length > 0) {
                push({
                  type: EventType.TOOL_CALL_ARGS,
                  toolCallId,
                  delta: args,
                });
              }
              push({ type: EventType.TOOL_CALL_END, toolCallId });
            }
            break;
          }

          if (name === CustomEventNames.ManuallyEmitState) {
            // Manually-emitted state is the source of truth for the
            // following snapshot. Merge into our cache so the next
            // root-terminal flush carries the updated values, AND
            // ship an immediate STATE_SNAPSHOT so consumers can react
            // before the run ends (matches legacy behaviour).
            if (payload && typeof payload === "object") {
              cacheState(payload as State);
              const { messages: _m, ...stateOnly } = payload as any;
              // Record the emitted snapshot's hash so the root-terminal
              // flushSnapshots() dedups an identical auto-snapshot instead of
              // re-emitting it. Without this the hash stays stale and the
              // completed-flush ships a duplicate STATE_SNAPSHOT. Mirrors
              // flushSnapshots' own hash bookkeeping.
              lastStateSnapshotHash = JSON.stringify(stateOnly);
              push({ type: EventType.STATE_SNAPSHOT, snapshot: stateOnly });
            }
            // Falls through to the generic CUSTOM passthrough below
            // so application listeners that key off the event name
            // still get it.
          }

          // Generic passthrough: forward the event verbatim as CUSTOM.
          push({
            type: EventType.CUSTOM,
            name,
            value: payload,
          } as ProcessedEvents);
          break;
        }

        // checkpoints, updates, input — handled in subsequent phases.
        // Drop through.
        default:
          break;
      }

      return true;
    },
  };
};

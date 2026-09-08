/**
 * Request-scoped model context for the AWS Strands bridge.
 *
 * `RunAgentInput.context` is what the application knew at the moment the user
 * asked: the selected record, the locale, whatever `useCopilotReadable`
 * published. The bridge already hands it to tools and hooks through
 * `buildContextExtras` and to the A2UI subagent through `planA2UIInjection`,
 * but nothing put it in front of the model itself, so context the app
 * injected was invisible to the LLM. This module renders it as one text block
 * and shows that block to the model for exactly one call, never persisting
 * it. It is the counterpart of the Python bridge's `_format_agui_context`,
 * `_MODEL_CONTEXT_BLOCK` and `_TransientModelContextHook`, and every
 * observable choice below (block wording, placement, restore) is kept in step
 * with that side so both bridges send the same prompt for the same input.
 *
 * Two constraints shape the design:
 *
 * 1. The block is request-scoped, and two threads can be in flight in one
 *    process, so nothing module-level and mutable may carry it. Python uses a
 *    `ContextVar`; the direct Node analogue is `AsyncLocalStorage`, which
 *    follows the async continuation chain rather than the module. The store
 *    is set around each pull of the Strands stream, exactly as Python's
 *    `_stream_with_model_context` sets and resets its token around each
 *    `__anext__`, so every continuation the SDK schedules while serving that
 *    pull (the model call, the hooks around it) inherits the run's block and
 *    nothing outside the pull does.
 *
 * 2. The block must reach the model without reaching the durable
 *    conversation: not `agent.messages` after the call, not a
 *    `MESSAGES_SNAPSHOT`, not the session store. So it is spliced into
 *    `agent.messages` from a `BeforeModelCallEvent` hook and spliced back out
 *    from the paired `AfterModelCallEvent` hook, with the run-loop teardown as
 *    a second restore for the cancellation path where the after-hook never
 *    fires. The mutation is recorded per agent in a `WeakMap`, the TS
 *    counterpart of the marker attribute Python sets on the agent instance.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  AfterModelCallEvent,
  BeforeModelCallEvent,
  Message as StrandsMessage,
  TextBlock,
} from "@strands-agents/sdk";
import { splitA2UISchemaContext } from "@ag-ui/a2ui-toolkit";

/** One `RunAgentInput.context` entry, flattened to the two fields the block reads. */
export interface AguiContextEntry {
  description: unknown;
  value: unknown;
}

/**
 * First line of the block, matched literally by the Python bridge's tests and
 * by anyone diffing the two bridges' prompts. Changing it is a parity change.
 */
export const MODEL_CONTEXT_HEADER = "Context provided by the application:";

/**
 * Upper bound on orchestrator nesting the hook installer will descend, the
 * same cap as Python's `_MAX_MULTIAGENT_NESTING`. A `Graph` can hold a
 * `Graph`, and a cycle built by hand would otherwise recurse without end.
 */
export const MAX_MULTIAGENT_NESTING = 10;

/**
 * Flatten wire context into `{description, value}` pairs, defaulting both to
 * `""`, as Python's `_normalize_agui_context` does for the dict shape the
 * wire carries. A field that is present but `null` stays `null` so the block
 * renders it the way `json.dumps(None)` would.
 */
export function normalizeAguiContext(context: unknown): AguiContextEntry[] {
  if (!Array.isArray(context)) return [];
  const normalized: AguiContextEntry[] = [];
  for (const entry of context) {
    const record =
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    normalized.push({
      description: "description" in record ? record.description : "",
      value: "value" in record ? record.value : "",
    });
  }
  return normalized;
}

/**
 * Render context as the text block the model sees, byte for byte what the
 * Python bridge's `_format_agui_context` renders: one `- description: value`
 * line per entry (`- value` when the description is blank), non-string values
 * JSON-serialized, and `""` when nothing is left to say.
 *
 * The A2UI component-schema entry is excluded through the shared toolkit's
 * `splitA2UISchemaContext`, so both bridges agree on which entry that is: it
 * feeds the `generate_a2ui` path and would only bloat the prompt here.
 *
 * `JSON.stringify` and `json.dumps` agree on strings, integers, booleans and
 * `null`, which is what a lax caller can realistically send in a field the
 * wire types as a string. They disagree on the shapes the wire never carries:
 * objects and arrays (`json.dumps` puts a space after `,` and `:`), integral
 * floats (`1.0` against `1`) and non-ASCII text (`json.dumps` escapes it).
 * Those are left to differ rather than papered over with a Python emulation.
 */
export function formatAguiContext(context: AguiContextEntry[]): string {
  const [, regularContext] = splitA2UISchemaContext(
    context as unknown as Array<Record<string, unknown>>,
  );
  const lines: string[] = [];
  for (const entry of regularContext) {
    const rawDescription = entry.description;
    const description =
      rawDescription === null || rawDescription === undefined
        ? ""
        : String(rawDescription).trim();
    const value = entry.value;
    const valueText =
      typeof value === "string"
        ? value
        : JSON.stringify(value === undefined ? "" : value);
    lines.push(
      description ? `- ${description}: ${valueText}` : `- ${valueText}`,
    );
  }
  if (lines.length === 0) return "";
  return `${MODEL_CONTEXT_HEADER}\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Request-scoped carrier
// ---------------------------------------------------------------------------

/**
 * The block for the run currently pulling the Strands stream, or `undefined`
 * outside any pull. Read only by the before-model-call hook below.
 */
const modelContextBlock = new AsyncLocalStorage<string>();

/**
 * Pull one event from a Strands stream with `contextBlock` in scope.
 *
 * This is the TS `_stream_with_model_context`: the store is entered for the
 * duration of one `next()` and left again before the event is handed back to
 * the run loop, so the block is visible to the SDK while it serves the pull
 * and to nothing that runs between pulls. Both run loops pull through here.
 * An empty block skips the store entirely so a run with no context costs
 * nothing and, more to the point, cannot see a block another run set.
 */
export function pullWithModelContext<T, R>(
  iterator: AsyncIterator<T, R>,
  contextBlock: string,
): Promise<IteratorResult<T, R>> {
  // Entered even for an empty block. Returning `iterator.next()` bare would
  // leave whatever store is already in scope, so a run nested inside another
  // run's continuation would read the outer run's context as its own.
  return modelContextBlock.run(contextBlock, () => iterator.next());
}

// ---------------------------------------------------------------------------
// Model-call-only injection
// ---------------------------------------------------------------------------

/**
 * What the before-hook did to `agent.messages`, so the after-hook and the
 * teardown can undo exactly that. `insert` added a whole user message at
 * `index`; `prepend` added one text block to the front of the question turn's
 * `content`. Both hold the inserted object so the restore removes by identity
 * rather than by position, in case the SDK moved things meanwhile.
 */
type ContextMutation =
  | {
      kind: "insert";
      messages: unknown[];
      index: number;
      inserted: StrandsMessage;
    }
  | { kind: "prepend"; content: unknown[]; inserted: TextBlock };

/** Agents that already carry the hook pair, so a re-run installs nothing. */
const hookedAgents = new WeakSet<object>();

/** The in-flight mutation per agent; absent between model calls. */
const mutations = new WeakMap<object, ContextMutation>();

type MessagesOwner = { messages?: unknown };

/**
 * Whether a content block names a tool call or its answer.
 *
 * Seeded history reaches the agent as ContentBlock instances, which carry a
 * `type` discriminant; the plain-object form carries the key itself. Both
 * shapes occur, and the run loop's own tail check reads them the same way.
 *
 * Key presence, not a defined value: a block naming a call with nothing useful
 * in it is still that kind of block, which is what Python's
 * `_carries_tool_result` decides too. Placement and the outline both read
 * through these, so they cannot disagree about a block's kind.
 */
function isToolResultBlock(block: unknown): boolean {
  if (block === null || typeof block !== "object") return false;
  const record = block as { type?: unknown };
  return "toolResult" in record || record.type === "toolResultBlock";
}

/** The `toolResult` payload, normalized across the two block shapes. */
function toolResultPayload(block: unknown): unknown {
  const record = block as {
    type?: unknown;
    toolUseId?: unknown;
    toolResult?: unknown;
  };
  return record.type === "toolResultBlock"
    ? { toolUseId: record.toolUseId }
    : record.toolResult;
}

/** Whether a content block opens a tool call. Counterpart of the above. */
function isToolUseBlock(block: unknown): boolean {
  if (block === null || typeof block !== "object") return false;
  const record = block as { type?: unknown };
  return "toolUse" in record || record.type === "toolUseBlock";
}

/** The `toolUse` payload, normalized across the two block shapes. */
function toolUsePayload(block: unknown): unknown {
  const record = block as {
    type?: unknown;
    toolUseId?: unknown;
    toolUse?: unknown;
  };
  return record.type === "toolUseBlock"
    ? { toolUseId: record.toolUseId }
    : record.toolUse;
}

/** The call id a `toolUse` or `toolResult` block names. */
function blockCallId(named: unknown): string {
  if (named !== null && typeof named === "object") {
    return String((named as { toolUseId?: unknown }).toolUseId);
  }
  return String(named);
}

/** A block's kind, from the instance discriminant or the wrapped-data key. */
function blockKindOf(block: unknown): string {
  const record = block as { type?: unknown } | null;
  if (typeof record?.type === "string")
    return record.type.replace(/Block$/, "");
  if (record !== null && typeof record === "object") {
    const [key] = Object.keys(record);
    if (key) return key;
  }
  return "?";
}

/**
 * One-line sanitized outline of the history a model call was handed.
 *
 * Text, tool inputs and tool results are dropped, so the line is safe to log:
 * it carries only what decides whether a provider accepts the request, which
 * is the roles, the block kinds and the tool ids that have to sit adjacent.
 *
 * The sequence is the OpenAI-compatible expansion, where a turn's non-tool
 * content becomes its own message ahead of the tool results it appends. That
 * is deliberately the only view here: a 400 over tool-call adjacency is about
 * this sequence, and reading it says directly whether each assistant call is
 * followed by its own answers. Whether a request would also satisfy the
 * block-level formatters' role alternation is a different question over a
 * different sequence, and the suites answer it against the real provider
 * bodies rather than against a second rendering nobody can index reliably.
 */
export function describeModelBoundHistory(messages: unknown): string {
  if (!Array.isArray(messages)) return "unrecorded";
  const labels: string[] = [];
  for (const message of messages) {
    const record = message as { role?: unknown; content?: unknown } | null;
    if (record === null || typeof record !== "object") {
      labels.push("?");
      continue;
    }
    const role = typeof record.role === "string" ? record.role : "?";
    const blocks = Array.isArray(record.content) ? record.content : [];
    const toolCallIds: string[] = [];
    const resultIds: string[] = [];
    const blockKinds: string[] = [];
    for (const block of blocks) {
      // The same reads `isToolResultBlock` and `toolUseOf` apply, so placement
      // and this line cannot disagree about what kind of block this is.
      if (isToolUseBlock(block)) {
        toolCallIds.push(blockCallId(toolUsePayload(block)));
      } else if (isToolResultBlock(block)) {
        resultIds.push(blockCallId(toolResultPayload(block)));
      } else {
        blockKinds.push(blockKindOf(block));
      }
    }
    if (
      blockKinds.length > 0 ||
      (toolCallIds.length === 0 && resultIds.length === 0)
    ) {
      let label = `${role}[${blockKinds.join("+")}]`;
      if (toolCallIds.length > 0) {
        label = `${label}(tool_calls=${toolCallIds.join(",")})`;
      }
      labels.push(label);
    } else if (toolCallIds.length > 0) {
      labels.push(`${role}(tool_calls=${toolCallIds.join(",")})`);
    }
    for (const callId of resultIds) labels.push(`tool(${callId})`);
  }
  return labels.join(" -> ");
}

/**
 * The outline of the last context-carrying model call each agent was handed.
 * Injecting context is the one thing this adapter does to the history a
 * provider validates, so a rejection is worth reporting against the shape that
 * was actually sent rather than against the durable history the restore leaves
 * behind. Cleared on a run that carries no context, because per-thread agents
 * are reused and a stale entry would name a different run's call.
 */
const historyOutlines = new WeakMap<object, string>();

/**
 * The outline recorded for `agent`'s last context-carrying model call, or
 * `"unrecorded"` when the current run carried none.
 */
export function modelBoundHistoryOutline(agent: unknown): string {
  if (agent === null || typeof agent !== "object") return "unrecorded";
  return historyOutlines.get(agent) ?? "unrecorded";
}

/**
 * Whether a native message answers a tool call. Strands puts tool results in a
 * `user` message, so role alone does not say whether a turn is a real question
 * or the answer half of a tool exchange, and only the latter constrains where
 * context may go. The Python counterpart is `_carries_tool_result`.
 */
function carriesToolResult(message: unknown): boolean {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content) && content.some(isToolResultBlock);
}

/**
 * Index of the latest user turn a text block can join, or `-1`.
 *
 * That turn is the question the run is still answering. It has to carry no
 * tool result, or the block would land between an assistant tool call and the
 * result answering it, and its content has to be an array, or there is nothing
 * to prepend to. The Python counterpart is `_context_host_index`.
 */
function contextHostIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role !== "user") continue;
    if (carriesToolResult(message)) continue;
    if (Array.isArray(message.content)) return index;
  }
  return -1;
}

/** Record what the model was just handed, for a later failure report. */
function injectModelContext(event: BeforeModelCallEvent): void {
  const agent = event.agent as unknown as MessagesOwner;
  if (!placeModelContext(event)) {
    // A run with no context leaves no outline behind. Per-thread agents are
    // reused, so a stale one would report a previous run's history as the
    // history this call was handed, which is worse than saying nothing.
    if (agent !== null && typeof agent === "object") {
      historyOutlines.delete(agent as object);
    }
    return;
  }
  historyOutlines.delete(agent as object);
  try {
    historyOutlines.set(
      agent as object,
      describeModelBoundHistory(agent.messages),
    );
  } catch {
    // The block is already spliced in and the mutation already recorded, so a
    // throw here would abort the run, leave the block in the durable history
    // and make the next call fail the not-restored guard. Observability is not
    // allowed to cost any of that. The delete above runs first, so a failure
    // leaves no outline rather than an earlier run's, and the forced-stop
    // report then says `unrecorded` instead of naming the wrong call. Nothing
    // is logged because this hook has no access to the run's injected logger
    // and the default one drops debug, so a line here would go nowhere.
  }
}

/**
 * Show the run's block to the model. `false` when the run has none.
 *
 * One placement, every history: the block joins the latest user turn that
 * carries no tool result, which is the question the run is still answering.
 * That is the only position no provider objects to, and the reason is that the
 * two families object to different things and no separate message satisfies
 * both.
 *
 * A turn carrying a tool result cannot take the block, because every
 * OpenAI-compatible formatter emits a turn's non-tool content as its own
 * message ahead of the tool results it appends, whatever order the blocks sit
 * in, so the block would wedge a user message between the assistant tool call
 * and its answers and the request is rejected. A separate user message cannot
 * take it either, because the block-level formatters (Anthropic, Bedrock,
 * Gemini) map messages one to one and never merge same-role neighbours, so a
 * context turn next to any user turn is two user messages in a row and fails
 * role alternation.
 *
 * Joining the question satisfies both at once, and in the strongest available
 * sense: the provider-bound message sequence comes out exactly as it would
 * with no context at all. When no question turn exists the block has to become
 * a message of its own, appended when the history ends on an assistant turn
 * (or is empty) and placed at the head otherwise, which is the cold
 * continuation replaying only a tool exchange. Mirrors Python's
 * `_place_context` case for case.
 */
function placeModelContext(event: BeforeModelCallEvent): boolean {
  const contextBlock = modelContextBlock.getStore();
  if (!contextBlock) return false;
  const agent = event.agent as unknown as MessagesOwner;
  if (mutations.has(agent)) {
    // A second before-hook with the first still in place means an after-hook
    // or a teardown was skipped. Persisting that would leak the block into the
    // durable conversation, which is the one thing this module exists to
    // prevent, so it fails loudly instead. Same message as Python.
    throw new Error("Transient AG-UI model context was not restored");
  }
  const messages = agent.messages;
  if (!Array.isArray(messages)) {
    // Returning `false` here would read to the caller as "this run carried no
    // context" and drop the application's context with no error, which is the
    // one outcome the caller explicitly refuses.
    throw new Error(
      "Strands agent exposes no message list for transient context",
    );
  }

  const hostIndex = contextHostIndex(messages);
  if (hostIndex >= 0) {
    const content = (messages[hostIndex] as { content: unknown[] }).content;
    const inserted = new TextBlock(contextBlock);
    content.unshift(inserted);
    mutations.set(agent, { kind: "prepend", content, inserted });
    return true;
  }

  // No question to join. The head keeps a replayed tool exchange intact; the
  // tail is right when the history ends on an assistant turn, where a new user
  // turn both alternates and sits closest to the generation it informs. A
  // history whose only user turn answers a tool call has no valid placement at
  // all, because it is already missing the assistant turn that opened that
  // call: the head keeps tool adjacency and leaves the alternation the history
  // arrived with, which the outline reports rather than hides.
  const tail = messages[messages.length - 1] as { role?: unknown } | undefined;
  const index = tail?.role === "user" ? 0 : messages.length;
  const contextMessage = new StrandsMessage({
    role: "user",
    content: [new TextBlock(contextBlock)],
  });
  messages.splice(index, 0, contextMessage);
  mutations.set(agent, {
    kind: "insert",
    messages,
    index,
    inserted: contextMessage,
  });
  return true;
}
/** Remove `target` from `list` by identity, trying `hint` first. */
function removeByIdentity(
  list: unknown[],
  target: unknown,
  hint: number,
): void {
  const at = list[hint] === target ? hint : list.indexOf(target);
  if (at >= 0) list.splice(at, 1);
}

/**
 * Undo an in-flight context mutation on `agent`, if there is one.
 *
 * Called from the after-model-call hook on the normal path and from the run
 * loop's teardown on the cancellation path, where the model call was
 * abandoned and the after-hook never fired. Idempotent, so both may run.
 * The recorded array is searched first; the agent's live `messages` is
 * searched as well in case the SDK swapped the array in between, so the
 * inserted turn cannot survive in a copy the record does not know about.
 */
export function restoreTransientModelContext(agent: unknown): void {
  if (agent === null || typeof agent !== "object") return;
  const mutation = mutations.get(agent);
  if (!mutation) return;
  mutations.delete(agent);
  if (mutation.kind === "prepend") {
    removeByIdentity(mutation.content, mutation.inserted, 0);
    // The recorded array is searched first, then every live turn, in case the
    // SDK swapped a turn's content array in between. Without the second pass
    // the block survives in a copy the record does not know about, which is
    // the leak this module exists to prevent.
    const live = (agent as MessagesOwner).messages;
    if (Array.isArray(live)) {
      for (const message of live) {
        const content = (message as { content?: unknown } | null)?.content;
        if (Array.isArray(content) && content !== mutation.content) {
          removeByIdentity(content, mutation.inserted, 0);
        }
      }
    }
    return;
  }
  removeByIdentity(mutation.messages, mutation.inserted, mutation.index);
  const live = (agent as MessagesOwner).messages;
  if (Array.isArray(live) && live !== mutation.messages) {
    removeByIdentity(live, mutation.inserted, mutation.index);
  }
}

type AddHook = (
  eventType: unknown,
  callback: (event: never) => void,
) => unknown;

/**
 * Install the model-only context hook pair once on a Strands agent.
 *
 * Returns `false` when `agent` exposes no `addHook`, which is the TS shape of
 * Python's "no `hooks.add_hook`" answer: a real `Agent` always has one, a
 * remote or hand-rolled `InvokableAgent` may not. The caller decides what a
 * `false` means; with a non-empty block it is a run the bridge cannot honour.
 */
export function ensureTransientContextHook(agent: unknown): boolean {
  if (agent === null || typeof agent !== "object") return false;
  if (hookedAgents.has(agent)) return true;
  const addHook = (agent as { addHook?: unknown }).addHook;
  if (typeof addHook !== "function") return false;
  // Both or neither. An injector installed without its restorer would splice
  // the block in on every model call and never take it back out, which is the
  // leak into durable history this module exists to prevent.
  try {
    (addHook as AddHook).call(agent, BeforeModelCallEvent, injectModelContext);
    (addHook as AddHook).call(
      agent,
      AfterModelCallEvent,
      (event: AfterModelCallEvent) => restoreTransientModelContext(event.agent),
    );
  } catch (error) {
    hookedAgents.delete(agent);
    throw error;
  }
  hookedAgents.add(agent);
  return true;
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

/**
 * The node map of a `Graph` or `Swarm`, or `undefined` for anything that does
 * not expose one. `ReadonlyMap` is a `Map` at runtime; Python's `dict` check
 * is the same gate.
 */
function orchestratorNodes(
  orchestrator: unknown,
): Iterable<unknown> | undefined {
  const nodes = (orchestrator as { nodes?: unknown } | null)?.nodes;
  return nodes instanceof Map ? nodes.values() : undefined;
}

/**
 * Install the hook pair on every leaf agent an orchestrator exposes, and
 * return how many took it. The Python SDK hangs both an agent and a nested
 * orchestrator off `node.executor`; the TS SDK gives `AgentNode` an `.agent`
 * and `MultiAgentNode` an `.orchestrator`, so both are read. A leaf that
 * refuses the hook is not counted, which lets the caller fall back to the
 * prompt when nothing at all could take it.
 */
export function installOrchestratorContextHooks(
  orchestrator: unknown,
  depth = 0,
): number {
  if (depth > MAX_MULTIAGENT_NESTING) return 0;
  const nodes = orchestratorNodes(orchestrator);
  if (!nodes) return 0;
  let installed = 0;
  for (const node of nodes) {
    const record = node as { agent?: unknown; orchestrator?: unknown } | null;
    if (ensureTransientContextHook(record?.agent)) {
      installed += 1;
    } else {
      installed += installOrchestratorContextHooks(
        record?.orchestrator,
        depth + 1,
      );
    }
  }
  return installed;
}

/**
 * Restore transient context on every hooked leaf under an orchestrator. The
 * orchestrator teardown calls this so a run abandoned mid-model-call leaves
 * no leaf carrying the block.
 */
export function restoreOrchestratorContext(
  orchestrator: unknown,
  depth = 0,
): void {
  if (depth > MAX_MULTIAGENT_NESTING) return;
  const nodes = orchestratorNodes(orchestrator);
  if (!nodes) return;
  for (const node of nodes) {
    const record = node as { agent?: unknown; orchestrator?: unknown } | null;
    const leaf = record?.agent;
    if (leaf !== null && typeof leaf === "object" && hookedAgents.has(leaf)) {
      restoreTransientModelContext(leaf);
    } else {
      restoreOrchestratorContext(record?.orchestrator, depth + 1);
    }
  }
}

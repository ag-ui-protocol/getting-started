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
  if (!contextBlock) return iterator.next();
  return modelContextBlock.run(contextBlock, () => iterator.next());
}

// ---------------------------------------------------------------------------
// Model-call-only injection
// ---------------------------------------------------------------------------

/**
 * What the before-hook did to `agent.messages`, so the after-hook and the
 * teardown can undo exactly that. `insert` added a whole user message at
 * `index`; `prepend` added one text block to the front of an existing user
 * turn's `content`. Both hold the inserted object so the restore removes by
 * identity rather than by position, in case the SDK moved things meanwhile.
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
 * Whether a content block is a tool result. Seeded history reaches the agent
 * as ContentBlock instances, which carry a `type` discriminant; the
 * plain-object form carries the `toolResult` key itself. Both shapes occur,
 * and the run loop's own tail check reads them the same way.
 */
function isToolResultBlock(block: unknown): boolean {
  if (block === null || typeof block !== "object") return false;
  const record = block as { toolResult?: unknown; type?: unknown };
  return record.toolResult !== undefined || record.type === "toolResultBlock";
}

/**
 * Place the run's block in front of the model, mirroring Python's
 * `_TransientModelContextHook._before_model_call` case for case:
 *
 * - No user message at all: append the block as a new user turn.
 * - The latest user turn carries a tool result: prepend the block into that
 *   same turn. A separate user message between an assistant `toolUse` and its
 *   `toolResult` is a shape providers reject, so the block rides inside.
 * - Otherwise: insert the block as its own user message immediately BEFORE
 *   the latest user turn. The actual latest turn stays byte-identical for
 *   model routers and fixtures that key off it, while live UI context lands
 *   next to the question it belongs to rather than at the head of stale
 *   history.
 */
function injectModelContext(event: BeforeModelCallEvent): void {
  const contextBlock = modelContextBlock.getStore();
  if (!contextBlock) return;
  const agent = event.agent as unknown as MessagesOwner;
  if (mutations.has(agent)) {
    // A second before-hook with the first still in place means an after-hook
    // or a teardown was skipped. Persisting that would leak the block into the
    // durable conversation, which is the one thing this module exists to
    // prevent, so it fails loudly instead. Same message as Python.
    throw new Error("Transient AG-UI model context was not restored");
  }
  const messages = agent.messages;
  if (!Array.isArray(messages)) return;

  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if ((messages[index] as { role?: unknown } | undefined)?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const contextMessage = new StrandsMessage({
    role: "user",
    content: [new TextBlock(contextBlock)],
  });

  if (latestUserIndex < 0) {
    messages.push(contextMessage);
    mutations.set(agent, {
      kind: "insert",
      messages,
      index: messages.length - 1,
      inserted: contextMessage,
    });
    return;
  }

  const latestUser = messages[latestUserIndex] as { content?: unknown };
  const content = latestUser.content;
  if (Array.isArray(content) && content.some(isToolResultBlock)) {
    const inserted = new TextBlock(contextBlock);
    content.unshift(inserted);
    mutations.set(agent, { kind: "prepend", content, inserted });
    return;
  }

  messages.splice(latestUserIndex, 0, contextMessage);
  mutations.set(agent, {
    kind: "insert",
    messages,
    index: latestUserIndex,
    inserted: contextMessage,
  });
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
  (addHook as AddHook).call(agent, BeforeModelCallEvent, injectModelContext);
  (addHook as AddHook).call(
    agent,
    AfterModelCallEvent,
    (event: AfterModelCallEvent) => restoreTransientModelContext(event.agent),
  );
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

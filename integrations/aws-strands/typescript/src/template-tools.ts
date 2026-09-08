/**
 * Per-request filtering of the tools the template agent contributed.
 *
 * The adapter builds one Strands `Agent` per thread and keeps it. That instance
 * is load-bearing: it holds the thread's `SessionManager`, its native interrupt
 * checkpoint and its conversation history. Changing which tools a request sees
 * therefore has to be done to the registry the live instance already owns, the
 * way client-declared tools are already synchronised, and never by constructing
 * a replacement.
 *
 * Scope is the template's own tools. Client-declared tools arrive on
 * `RunAgentInput.tools` every request and are synchronised by
 * {@link syncProxyTools}; a caller that wants fewer of those sends fewer.
 * Auto-injected A2UI tools are the adapter's and are refreshed per turn. What
 * no per-request channel reached until now is the set the wrapped template
 * contributed once, at construction.
 */

import type { Tool } from "@strands-agents/sdk";

import { isAutoInjectedA2UITool } from "./a2ui-tool";
import { isProxyTool, type StrandsToolRegistry } from "./client-proxy-tool";
import { DEFAULT_LOGGER, type Logger } from "./logger";

const LOG_PREFIX = "[@ag-ui/aws-strands]";

/** One entry a `templateToolsProvider` may return: a template tool or its name. */
export type TemplateToolSelectionEntry = Tool | string;

/** What a `templateToolsProvider` may answer with. */
export type TemplateToolSelection =
  | Iterable<TemplateToolSelectionEntry>
  | null
  | undefined;

/**
 * The narrowed name set for the run in flight, stamped on the per-thread agent
 * so the re-narrowing hook can read it back. Deliberately not routed through
 * the agent's own state, which a `SessionManager` persists; this is per-request
 * scratch that must not outlive the process.
 */
const ALLOWED_KEY = Symbol.for("@ag-ui/aws-strands.templateToolsAllowed");

/** A provider answer this hook cannot read as a selection of tools. */
export class TemplateToolsSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateToolsSelectionError";
  }
}

/**
 * What {@link parkedBatchToolNames} answers for a checkpoint it cannot read.
 *
 * A distinct value rather than `undefined`: absent already means "no
 * exemptions" wherever `exemptNames` is passed, and the two are opposites.
 */
export const EXEMPT_EVERY_TEMPLATE_TOOL = Symbol.for(
  "@ag-ui/aws-strands.exemptEveryTemplateTool",
);

/** Names to hold registered, or the sentinel meaning "hold all of them". */
export type TemplateToolExemption =
  | ReadonlySet<string>
  | typeof EXEMPT_EVERY_TEMPLATE_TOOL;

/** Index the template's tools by the name a registry holds them under. */
export function indexTemplateTools(
  templateTools: readonly unknown[],
): Map<string, Tool> {
  const indexed = new Map<string, Tool>();
  for (const tool of templateTools) {
    const name = (tool as { name?: unknown } | null | undefined)?.name;
    if (typeof name === "string" && name.length > 0) {
      indexed.set(name, tool as Tool);
    }
  }
  return indexed;
}

/**
 * Read one provider answer as the template tool names a request may see.
 *
 * Entries are either the template's own tool objects or their names, so a
 * caller can write the filter with whichever it has to hand.
 *
 * `null`/`undefined` means the provider declined to filter this request and
 * every template tool stays available. An empty array is a real answer and
 * means none of them do.
 *
 * The container is checked rather than merely iterated. A `string` and a `Map`
 * are both iterable and both mean something other than what iterating them
 * produces: a name would come apart into characters, and a permission map would
 * have its keys read as an allow-list while its values went unread. A plain
 * object is refused for the same reason rather than left to throw a bare
 * `TypeError`, which keeps one return contract across the two bridges rather
 * than two.
 *
 * A name the template never contributed is dropped with a warning. This hook
 * narrows what the wrapped agent already gave the adapter; it cannot hand the
 * model a capability the template did not carry, so honouring an unknown name
 * is the one thing it must not do.
 *
 * @throws {TemplateToolsSelectionError} If the answer is not a container of
 * names or tools. The run reports `TEMPLATE_TOOLS_PROVIDER_ERROR`.
 */
export function resolveTemplateToolSelection(
  selection: TemplateToolSelection,
  templateIndex: ReadonlyMap<string, Tool>,
  log: Logger = DEFAULT_LOGGER,
): Set<string> | null {
  if (selection == null) return null;

  if (typeof selection === "string") {
    throw new TemplateToolsSelectionError(
      "templateToolsProvider returned a single string, which iterates one " +
        "character at a time and would deny every tool. Return a container of " +
        'the tool names or tools this request may see, such as ["a_tool"]',
    );
  }
  if (selection instanceof Map) {
    throw new TemplateToolsSelectionError(
      "templateToolsProvider returned a Map, whose keys would be read as the " +
        "allow-list while its values went unread, so a name mapped to false " +
        "would still be allowed. Return a container holding only the tool " +
        "names or tools this request may see",
    );
  }
  if (typeof (selection as Iterable<unknown>)[Symbol.iterator] !== "function") {
    throw new TemplateToolsSelectionError(
      `templateToolsProvider returned ${describe(selection)}, which is not a ` +
        "container of tool names or tools",
    );
  }

  // Materialized here on purpose: a generator constructs without running its
  // body, so a provider can hand back something that throws only on first
  // iteration, and the caller guards this call.
  const entries = Array.from(selection as Iterable<unknown>);

  const allowed = new Set<string>();
  for (const entry of entries) {
    const name =
      typeof entry === "string"
        ? entry
        : (entry as { name?: unknown } | null | undefined)?.name;
    if (typeof name !== "string" || name.length === 0) {
      log.warn(
        `${LOG_PREFIX} templateToolsProvider returned an entry that names no tool`,
      );
      continue;
    }
    if (!templateIndex.has(name)) {
      log.warn(
        `${LOG_PREFIX} templateToolsProvider named "${name}", which the template ` +
          "agent does not contribute; it stays unavailable. This hook filters " +
          "the template's tools and cannot add one.",
      );
      continue;
    }
    allowed.add(name);
  }
  return allowed;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  return (value as object).constructor?.name ?? "an object";
}

/**
 * Tool names in the batch a live interrupt checkpoint would resume.
 *
 * A parked run resumes into the tool batch it stopped inside: Strands
 * re-dispatches every `toolUse` in the assistant message it checkpointed,
 * answering the ones that already completed from the checkpoint and running the
 * one that is waiting. A tool absent from the registry at that moment turns the
 * human's answer into a "tool not found" the model then re-fires, so nothing in
 * that batch is filtered out while the pause is open.
 *
 * This is the same rule `syncProxyTools` applies to a proxy parked in a
 * frontend-tool interrupt, read off the checkpoint instead of off a
 * frontend-wait index because a template tool can park through the approval
 * hook, through an interrupt of its own, or not at all, and the batch answers
 * all three at once.
 *
 * Returns the names to hold registered; an empty set when nothing is parked; or
 * {@link EXEMPT_EVERY_TEMPLATE_TOOL} for a checkpoint that is carrying a tool
 * batch this function cannot read, where holding everything costs one
 * unfiltered turn and the alternative breaks a resume. An activated checkpoint
 * with no pending tool execution at all is not that case: an interrupt raised
 * before any tool ran parks exactly that way, and it has no batch to protect.
 */
export function parkedBatchToolNames(agent: unknown): TemplateToolExemption {
  const state = (agent as { _interruptState?: unknown } | null | undefined)
    ?._interruptState as
    | {
        activated?: unknown;
        pendingToolExecution?: unknown;
      }
    | undefined;
  if (!state || state.activated !== true) return new Set();

  const pending = state.pendingToolExecution;
  if (pending == null) {
    // A pause raised before any tool ran. Nothing is mid-dispatch, so nothing
    // needs holding.
    return new Set();
  }

  const message = (pending as { assistantMessageData?: unknown })
    .assistantMessageData as { content?: unknown } | undefined;
  const names = new Set<string>();
  if (
    message &&
    typeof message === "object" &&
    Array.isArray(message.content)
  ) {
    for (const block of message.content) {
      const toolUse = (block as { toolUse?: unknown } | null | undefined)
        ?.toolUse;
      const name = (toolUse as { name?: unknown } | null | undefined)?.name;
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
  }
  if (names.size === 0) {
    DEFAULT_LOGGER.warn(
      `${LOG_PREFIX} an activated interrupt checkpoint carries a tool batch ` +
        "this adapter cannot read; holding every template tool registered " +
        "rather than risk removing one this thread's resume is about to " +
        "re-dispatch.",
    );
    return EXEMPT_EVERY_TEMPLATE_TOOL;
  }
  return names;
}

/**
 * Whether a registry entry belongs to a producer other than the template.
 *
 * The adapter has exactly two others: proxies for client-declared tools, and
 * the A2UI tool it injects itself. Both are re-decided every turn by the code
 * that owns them, so neither is this filter's to touch.
 */
function isForeignEntry(entry: unknown): boolean {
  return isProxyTool(entry) || isAutoInjectedA2UITool(entry);
}

/**
 * Whether a registry entry under a template tool's name is the template's.
 *
 * Identity settles it when it holds. It does not always hold: with an external
 * `agentsByThread` map the wrapper is rebuilt per request while the cached
 * thread agent keeps the registry it already had, so a template whose tools are
 * built per request (a factory, or a closure over a request-scoped handle)
 * hands the adapter equivalent but not identical objects. Reading a non-match
 * as "someone else owns this name" would make a deny-everything answer remove
 * nothing, which is a silent failure in the permissive direction on a hook
 * whose whole job is withholding capability.
 *
 * So the fallback is ownership by elimination: the name is one the template
 * contributes, and the entry sitting on it is not one of the adapter's other
 * producers, therefore it is the template's.
 */
function isTemplateEntry(entry: unknown, templateTool: Tool): boolean {
  if (entry === templateTool) return true;
  return !isForeignEntry(entry);
}

/**
 * Make `toolRegistry` hold exactly the template tools `allowed` permits.
 *
 * `allowed` is a resolved name set, `null` meaning no filtering. `exemptNames`
 * holds names to keep registered whatever `allowed` says; omitted exempts
 * nothing and {@link EXEMPT_EVERY_TEMPLATE_TOOL} exempts every name.
 *
 * Removal is not destructive. The template tool objects outlive the registry
 * entry, so a later request that allows a name again restores the same
 * instance, and history stays untouched throughout: a filtered-out tool's
 * earlier calls and results remain in the thread's messages, which is what lets
 * the model read what it already did with a tool it can no longer call.
 *
 * Returns the template tool names the registry holds after the call.
 */
export function applyTemplateToolSelection(
  toolRegistry: StrandsToolRegistry,
  templateTools: readonly unknown[],
  allowed: Set<string> | null,
  options: { exemptNames?: TemplateToolExemption; log?: Logger } = {},
): Set<string> {
  const log = options.log ?? DEFAULT_LOGGER;
  const templateIndex = indexTemplateTools(templateTools);
  const exemptAll = options.exemptNames === EXEMPT_EVERY_TEMPLATE_TOOL;
  const exemptSet: ReadonlySet<string> =
    exemptAll || options.exemptNames === undefined
      ? new Set<string>()
      : (options.exemptNames as ReadonlySet<string>);

  const registered = new Set<string>();
  for (const [name, tool] of templateIndex) {
    const exempt = exemptAll || exemptSet.has(name);
    const keep = allowed === null || allowed.has(name) || exempt;
    const existing = toolRegistry.get(name);

    if (!keep) {
      if (existing !== undefined && isTemplateEntry(existing, tool)) {
        toolRegistry.remove(name);
        log.debug(`${LOG_PREFIX} Filtered out template tool: ${name}`);
      } else if (existing !== undefined) {
        log.debug(
          `${LOG_PREFIX} Template tool ${name} is held by another producer; ` +
            "the filter leaves it in place",
        );
      }
      continue;
    }

    if (existing === tool) {
      registered.add(name);
      continue;
    }
    if (existing === undefined) {
      toolRegistry.add(tool);
      registered.add(name);
      log.debug(`${LOG_PREFIX} Restored template tool: ${name}`);
      continue;
    }
    if (!exempt && isProxyTool(existing)) {
      // A client proxy took this name while the template tool was filtered
      // out, and the provider now allows the template tool. A native tool wins
      // a name collision, so hand the name back: the proxy sync runs after this
      // and re-decides the client's side, skipping a name a native tool holds.
      // Leaving the proxy would both shadow the allowed tool and, if the client
      // has stopped declaring it, let the proxy sync drop the name outright.
      //
      // Guarded on `exempt` rather than on the selection, because the keep
      // branch is also reached by exemption, and a proxy the parked batch is
      // answering keeps its name.
      toolRegistry.remove(name);
      toolRegistry.add(tool);
      registered.add(name);
      log.debug(
        `${LOG_PREFIX} Reclaimed template tool ${name} from a client proxy ` +
          "holding its name",
      );
      continue;
    }
    if (isTemplateEntry(existing, tool)) {
      // The template's, under a different object. Leave the entry the thread
      // has been using rather than churn it.
      registered.add(name);
      continue;
    }
    log.debug(
      `${LOG_PREFIX} Template tool ${name} is held by another producer; ` +
        "leaving it in place",
    );
  }
  return registered;
}

/**
 * Read `selection` and apply it to `toolRegistry` in one call.
 *
 * The run path keeps the two halves apart, so that reading a provider's answer
 * fails as a provider error and applying it does not. This composes them for a
 * caller with an answer already in hand.
 */
export function syncTemplateTools(
  toolRegistry: StrandsToolRegistry,
  templateTools: readonly unknown[],
  selection: TemplateToolSelection,
  options: { exemptNames?: TemplateToolExemption; log?: Logger } = {},
): Set<string> {
  const log = options.log ?? DEFAULT_LOGGER;
  return applyTemplateToolSelection(
    toolRegistry,
    templateTools,
    resolveTemplateToolSelection(
      selection,
      indexTemplateTools(templateTools),
      log,
    ),
    options,
  );
}

/** Publish the run's narrowed name set for the re-narrowing hook to read. */
export function recordTemplateToolSelection(
  agent: unknown,
  allowed: Set<string> | null,
): void {
  (agent as Record<symbol, unknown>)[ALLOWED_KEY] = allowed;
}

/**
 * Re-narrow the filtered set once a resumed batch has been dispatched.
 *
 * The parked-batch exemption keeps a denied tool registered so a resume can
 * reach it. Strands then carries on inside the same run: it re-dispatches the
 * batch, clears the checkpoint, and makes its next model call from this same
 * registry, which would still be advertising what the request denied. Without
 * this the model could call a withheld tool for the rest of that run, and only
 * the next request would narrow again.
 *
 * Strands reads the registry fresh for every model call, so this is called from
 * a hook that fires between one tool batch and the next such read. Which hook
 * that is differs by SDK, and the adapter picks it; see the call site.
 *
 * No exemption is passed. By the time this fires the parked batch has been
 * dispatched, which is the whole reason the exemption existed, so re-reading
 * the checkpoint would only ask a question whose answer no longer matters, and
 * the answer moved between releases: this SDK clears its pending execution
 * before the tool step in 1.1 and after it in 1.16, so a hook that reads it
 * holds the exemption on one release and drops it on the other. Asking nothing
 * is both simpler and the same on every release.
 *
 * A run the SDK is cancelling can replay a skipped batch after this fires, and
 * a tool this narrowing removed would be missing from that replay. The run is
 * being torn down at that point, and the next request restores whatever a live
 * checkpoint still needs before anything reads the registry again.
 */
export function renarrowTemplateTools(
  agent: unknown,
  templateTools: readonly unknown[],
  log: Logger = DEFAULT_LOGGER,
): void {
  const allowed = (agent as Record<symbol, unknown>)[ALLOWED_KEY];
  if (allowed == null) return;
  applyTemplateToolSelection(
    (agent as { toolRegistry: StrandsToolRegistry }).toolRegistry,
    templateTools,
    allowed as Set<string>,
    { log },
  );
}

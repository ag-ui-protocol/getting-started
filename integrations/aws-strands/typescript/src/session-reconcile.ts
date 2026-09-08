/**
 * Reconcile frontend (proxy) tool results into a Strands `SessionManager`.
 *
 * Frontend tools are executed on the client, so server-side the proxy returns a
 * placeholder `toolResult` (`"Forwarded to client"`). The real result only
 * arrives on the next run inside `RunAgentInput.messages`, under the same
 * `toolUseId` Strands persisted, so this module can find the persisted
 * placeholder and overwrite it with the real result.
 *
 * Nothing on that continuation says who executed the call. The adapter
 * therefore records the id of every frontend call it emits durably on the
 * agent's app state (see `AG_UI_FRONTEND_CALL_IDS_STATE_KEY`): membership there
 * is what tells a client-executed result apart from one Strands produced
 * itself. The ids are held in recorded order rather than as a bare set, because
 * the size cap applied at emission evicts the oldest first.
 *
 * Where the Python adapter rewrites individual persisted messages through a
 * session repository, the TypeScript SDK persists whole-agent snapshots: the
 * restored history IS `agent.messages`, so correcting that array and asking the
 * session manager to save a snapshot is the same durable write. An activated
 * interrupt checkpoint is the one further surface, because it parks its tool
 * results outside that array; both are corrected here in one pass.
 */

import {
  ToolResultBlock,
  toolResultContentFromData,
} from "@strands-agents/sdk";
import type {
  Message,
  SessionManager,
  ToolResultBlockData,
  ToolResultContent,
} from "@strands-agents/sdk";

import { PROXY_RESULT_PLACEHOLDER } from "./client-proxy-tool";
import { resolveLogger, type Logger } from "./logger";
import { _buildToolResultContent } from "./utils";

const LOG_PREFIX = "[@ag-ui/aws-strands]";

/**
 * Key under which the adapter stores the ids of the frontend tool calls it has
 * emitted, as a JSON array on the Strands agent's app state. Namespaced to
 * avoid clashing with user-managed state keys.
 */
export const AG_UI_FRONTEND_CALL_IDS_STATE_KEY = "ag_ui_frontend_call_ids";

/**
 * One content block of a `toolResult` in its persisted (data) form. The SDK
 * exports the block type but not this member type.
 */
export type ToolResultContentData = ToolResultBlockData["content"][number];

/** Upper bound on recorded ids, so abandoned calls cannot grow the store. */
export const FRONTEND_CALL_IDS_MAX = 512;

/** The real client answer for one frontend call: its text and failure flag. */
export interface PendingFrontendResult {
  text: string;
  isError: boolean;
  /** The client's failure reason, set only when the failure reported one. */
  errorReason?: string;
}

/** Minimal app-state surface; a test double may supply neither half. */
interface AppStateLike {
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
}

function appStateOf(agent: unknown): AppStateLike | undefined {
  const appState = (agent as { appState?: unknown })?.appState as
    | AppStateLike
    | undefined;
  return appState && typeof appState === "object" ? appState : undefined;
}

/**
 * Return the frontend-call ids recorded on `agent`'s app state.
 *
 * Both the continuation read and the emission write go through here so they
 * cannot disagree about the stored shape. Anything that is not the array this
 * adapter writes is state some other writer left behind: a permissive read
 * turns a stored string into one id per character, so it is discarded instead.
 */
export function recordedFrontendCallIds(agent: unknown): string[] {
  const appState = appStateOf(agent);
  if (!appState || typeof appState.get !== "function") return [];
  const stored = appState.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (callId): callId is string =>
      typeof callId === "string" && callId.trim().length > 0,
  );
}

/**
 * Persist `callIds` verbatim, preserving order for the size cap.
 *
 * Reports whether the write happened, and EVERY caller acts on the answer:
 * reconciliation refuses the whole attempt rather than saving a correction whose
 * call id it cannot retire, and the recorded id is the only thing that ever
 * admits a newly emitted call's client answer, so a refused write there loses
 * the answer.
 *
 * A store that THROWS did not write either, so it is reported the same way
 * rather than propagated: reporting success would let a correction be saved
 * against ids the store never took, and a throw escaping here reaches the caller
 * below outside the one branch that knows how to undo what is already in memory.
 * The cause goes to `log`, which a boolean cannot carry.
 */
export function writeFrontendCallIds(
  agent: unknown,
  callIds: string[],
  log?: Logger,
): boolean {
  const appState = appStateOf(agent);
  if (!appState || typeof appState.set !== "function") return false;
  try {
    appState.set(AG_UI_FRONTEND_CALL_IDS_STATE_KEY, callIds);
  } catch (e) {
    log?.warn(
      `${LOG_PREFIX} The agent's app state refused a write of the frontend ` +
        `call ids`,
      e,
    );
    return false;
  }
  return true;
}

/**
 * Record `toolUseId` as a call this adapter handed to the client.
 *
 * Oldest-first eviction at the cap: an id for a call that never gets a client
 * result (abandoned or dismissed HITL) is never consumed, so without a bound
 * the store only grows.
 *
 * An id `recordedFrontendCallIds` would discard is refused here instead of
 * stored: recorded and then dropped on the way back out, it leaves a call whose
 * client answer nothing can admit while the store claims to hold its record.
 * The emission path refuses such an id before this point, so reaching it is a
 * defect, and refusing here keeps it from being a silent one.
 *
 * Returns whether the id ended up recorded, and a refusal is reported through
 * `log` (the fallback logger when a caller passes none) whether or not anyone
 * reads the answer: a refused record loses the only signal that ever admits this
 * call's client result, so its persisted placeholder can never be corrected for
 * the life of the thread.
 *
 * A store whose READ throws is reported the same way rather than propagated:
 * this runs mid-stream on the emission path, where nothing is set up to catch a
 * throw, and the unknown existing ids are what make this id unwritable in the
 * first place.
 */
export function recordFrontendCallId(
  agent: unknown,
  toolUseId: string,
  log?: Logger,
): boolean {
  if (!toolUseId?.trim()) return false;
  const logger = resolveLogger(log);
  let cause: unknown;
  try {
    const callIds = recordedFrontendCallIds(agent);
    if (!callIds.includes(toolUseId)) callIds.push(toolUseId);
    if (callIds.length > FRONTEND_CALL_IDS_MAX) {
      callIds.splice(0, callIds.length - FRONTEND_CALL_IDS_MAX);
    }
    if (writeFrontendCallIds(agent, callIds, logger)) return true;
  } catch (e) {
    // Only the read can land here: the write reports its own refusal instead of
    // throwing. Writing this id alone on an unreadable store would replace the
    // record rather than extend it, so nothing is written.
    cause = e;
  }
  const refusal =
    `${LOG_PREFIX} Cannot record frontend tool call ${toolUseId}: the agent's ` +
    `app state could not take the record, so this call's client answer can ` +
    `never be admitted and its persisted placeholder can never be corrected`;
  if (cause === undefined) logger.warn(refusal);
  else logger.warn(refusal, cause);
  return false;
}

/**
 * Return whether the exact public snapshot-rewrite API is available.
 *
 * Fails closed: without a session manager that can write a snapshot back, a
 * corrected `agent.messages` would be lost at the next restart, which is the
 * failure this module exists to prevent. A READABLE and writable app state is
 * part of the same capability, because retiring the corrected call's id is half
 * of every reconciliation: without the write the snapshot would save while the
 * store went on offering the call as outstanding forever, and without the read
 * no result can be admitted in the first place, since membership in the
 * recorded ids is the only thing that tells a client-executed result apart.
 *
 * Reading these surfaces should not throw. When it does, this still fails
 * closed, but says so through `log`: the fallback path it selects otherwise
 * looks like an ordinary turn.
 *
 * The app state's read is EXERCISED rather than type-checked, because a store
 * whose read throws satisfies a type check and then throws where nothing
 * handles it, on the emission path and inside reconciliation's own first read.
 * Only the read: the write is already reported rather than propagated by
 * `writeFrontendCallIds`, and probing it would mean writing to the store from a
 * capability question.
 */
export function supportsSnapshotReconciliation(
  sessionManager: unknown,
  agent: unknown,
  log?: Logger,
): boolean {
  if (sessionManager == null) return false;
  try {
    const saveSnapshot = (sessionManager as { saveSnapshot?: unknown })
      .saveSnapshot;
    if (typeof saveSnapshot !== "function") return false;
    if (!Array.isArray((agent as { messages?: unknown }).messages))
      return false;
    const appState = appStateOf(agent);
    if (
      typeof appState?.set !== "function" ||
      typeof appState?.get !== "function"
    ) {
      return false;
    }
    appState.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY);
    return true;
  } catch (e) {
    log?.warn(
      `${LOG_PREFIX} Cannot determine whether snapshot reconciliation is ` +
        `supported; treating it as unsupported`,
      e,
    );
    return false;
  }
}

/**
 * Return true if `content` mentions the proxy's `"Forwarded to client"` stub.
 *
 * Detection is permissive where the rewrite is exact. A stub sitting alongside
 * other blocks is still a stub the model must not be replayed, so it is
 * reported here; `isExactPlaceholder` then refuses to overwrite it, rather than
 * destroying content this adapter did not write. Every caller has to fail
 * closed on that pair: the message path onto its continuation prompt, and the
 * resume path, which has no fallback, by refusing the run.
 */
function mentionsPlaceholder(content: readonly unknown[]): boolean {
  return content.some(
    (block) =>
      block != null &&
      typeof block === "object" &&
      (block as { text?: unknown }).text === PROXY_RESULT_PLACEHOLDER,
  );
}

/**
 * Return true unless `content` is a readable block array holding no stub.
 *
 * A shape this cannot scan is answered as a stub. The answer decides whether a
 * resume may feed the result to the model, and content that is not a block
 * array at all may hold anything, including the stub.
 */
function mayMentionPlaceholder(content: unknown): boolean {
  return !Array.isArray(content) || mentionsPlaceholder(content);
}

/** The proxy stub's content in data form: exactly one text block. */
const PLACEHOLDER_CONTENT_BLOCK: ToolResultContentData = {
  text: PROXY_RESULT_PLACEHOLDER,
};

/**
 * Return true if `content` is exactly the proxy stub and nothing else.
 *
 * The permission to replace a content array, and the only thing in this module
 * that refuses one. A rewrite replaces the whole array, so applying it to a
 * result that also carries blocks this adapter did not write would destroy them
 * unrecoverably.
 */
function isExactPlaceholder(content: readonly unknown[]): boolean {
  return isSoleContentBlock(content, PLACEHOLDER_CONTENT_BLOCK);
}

/**
 * One `toolResult` this module found: its fields for reading, plus the rewrite
 * that suits the shape it was found in.
 */
interface ToolResultView {
  toolUseId: string;
  status: unknown;
  /** Always an array: both readers below refuse a result without one. */
  content: readonly unknown[];
  /**
   * Rewrite this result, returning the undo that puts it back exactly as it
   * was. Capture and restore are written together here because the rewrite
   * lands before the save that persists it, and a save the store refuses has
   * to leave nothing behind.
   */
  rewrite: (
    status: "success" | "error",
    built: ToolResultContentData,
  ) => () => void;
}

/**
 * Read the SDK's serialized `{ toolResult: ... }` wrapper, or undefined.
 *
 * This is the shape `ToolResultBlock.toJSON()` writes, so it is what an
 * interrupt checkpoint parks, what a snapshot on disk holds, and what a
 * `Message` built straight from data keeps verbatim. Wrapped data is rewritten
 * in place rather than replaced, so a plain-data history does not gain a class
 * instance where the snapshot writer expects data.
 */
function wrappedToolResultView(wrapped: unknown): ToolResultView | undefined {
  if (wrapped == null || typeof wrapped !== "object") return undefined;
  const data = wrapped as ToolResultBlockData;
  if (typeof data.toolUseId !== "string") return undefined;
  if (!Array.isArray(data.content)) return undefined;
  return {
    toolUseId: data.toolUseId,
    status: data.status,
    content: data.content,
    rewrite: (status, built) => {
      // Whether the key was there, not just what it held: assigning a captured
      // absence back recreates the key as `undefined`, which is a result whose
      // status is undefined rather than one carrying none. The instance path
      // below owes nothing here because it puts the original block back whole.
      const fields = data as { status?: unknown };
      const hadStatus = "status" in fields;
      const previous = { status: data.status, content: data.content };
      data.status = status;
      data.content = [built];
      return () => {
        data.content = previous.content;
        if (hadStatus) data.status = previous.status;
        else delete fields.status;
      };
    },
  };
}

/**
 * Read the content block at `index` as a `toolResult`, or undefined.
 *
 * Both shapes the SDK produces are accepted, as this package's other reader of
 * `agent.messages` (`strandsToolResultsToAgui`) already does: the class
 * instance carries a discriminator, and its serialized form wraps the same
 * fields under `toolResult`. Refusing either would report a clean history to
 * the placeholder gate and replay the stub to the model, which is the failure
 * this module exists to prevent. `ToolResultBlock`'s fields are readonly, so
 * correcting an instance means substituting a new block at the same index.
 */
function toolResultViewAt(
  content: unknown[],
  index: number,
): ToolResultView | undefined {
  const block = content[index];
  if (block == null || typeof block !== "object") return undefined;
  if ((block as { type?: unknown }).type === "toolResultBlock") {
    const instance = block as ToolResultBlock;
    // The discriminator alone is not the shape. Every reader of a view calls
    // array methods on its content and matches on its id, some of them from
    // call sites outside reconciliation's own error handling, so a block that
    // claims the class without carrying its fields is refused here exactly as
    // the same malformed wrapper is below.
    if (typeof instance.toolUseId !== "string") return undefined;
    if (!Array.isArray(instance.content)) return undefined;
    return {
      toolUseId: instance.toolUseId,
      status: instance.status,
      content: instance.content,
      rewrite: (status, built) => {
        content[index] = new ToolResultBlock({
          toolUseId: instance.toolUseId,
          status,
          content: [toolResultContentFromData(built)] as ToolResultContent[],
        });
        return () => {
          content[index] = instance;
        };
      },
    };
  }
  return wrappedToolResultView((block as { toolResult?: unknown }).toolResult);
}

/** Every `toolResult` in `message`. */
function toolResultViewsOf(message: unknown): ToolResultView[] {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  const views: ToolResultView[] = [];
  for (let index = 0; index < content.length; index++) {
    const view = toolResultViewAt(content, index);
    if (view) views.push(view);
  }
  return views;
}

/** The parked tool results of an activated checkpoint, or undefined. */
function activePendingToolResults(
  agent: unknown,
): Record<string, { toolResult: ToolResultBlockData }> | undefined {
  const interruptState = (agent as { _interruptState?: unknown })
    ?._interruptState as
    | {
        activated?: unknown;
        pendingToolExecution?: {
          completedToolResults?: Record<
            string,
            { toolResult: ToolResultBlockData }
          >;
        };
      }
    | undefined;
  if (!interruptState || interruptState.activated !== true) return undefined;
  const completed = interruptState.pendingToolExecution?.completedToolResults;
  if (!completed || typeof completed !== "object") return undefined;
  return completed;
}

/** The parked `toolResult`s of an activated checkpoint, in reading form. */
function parkedToolResultViews(
  completed: Record<string, { toolResult: ToolResultBlockData }>,
): ToolResultView[] {
  const views: ToolResultView[] = [];
  for (const entry of Object.values(completed)) {
    const view = wrappedToolResultView(entry?.toolResult);
    if (view) views.push(view);
  }
  return views;
}

/**
 * Every parked proxy placeholder an active checkpoint holds, split by whether
 * a rewrite in this module can correct it.
 *
 * Detection is permissive and the rewrite exact, as on the message path: a
 * parked result that merely MENTIONS the stub is still a stub the model must
 * not read, and it is still not one of ours to overwrite. So it is reported,
 * as `uncorrectable`, rather than dropped from both sets.
 *
 * The split does not predict the rewrite, it IS the rewrite: `planCorrection`
 * is asked what it would do and not asked to do it, so there is no second
 * opinion to drift from it. It settles the refusal from the view alone, before
 * any answer is read, so nothing an answer can be turns a placeholder reported
 * here as correctable into one the rewrite then refuses.
 *
 * What no rewrite can do is find a client result under an id nothing can key
 * one to, so a stub whose own id is unreadable is `uncorrectable` however
 * repairable its content is.
 *
 * `correctable` is exact about substance, but not about the key set: demanding
 * a fixed set of keys would stop recognising the placeholder for any field the
 * SDK carries or later adds, emptying the set, which silently disables the
 * resume gates that read it and lets a stub be consumed on resume.
 *
 * `stubbed` is the provenance half: the ids under which a stub was actually
 * SEEN. It is deliberately not the union of the other two, because
 * `uncorrectable` also fails closed on shapes whose content was never scanned
 * at all.
 *
 * One pass builds all three, and a shape this module cannot read lands in
 * `uncorrectable`, so no parked result is invisible to both gates at once.
 */
function parkedProxyPlaceholders(agent: unknown): {
  correctable: Set<string>;
  uncorrectable: Set<string>;
  stubbed: Set<string>;
} {
  const correctable = new Set<string>();
  const uncorrectable = new Set<string>();
  const stubbed = new Set<string>();
  const completed = activePendingToolResults(agent);
  if (!completed) return { correctable, uncorrectable, stubbed };
  // Keyed by the `toolUseId` the checkpoint parked the result under, which is
  // the only name a result whose own id is unreadable still has.
  for (const [parkedId, entry] of Object.entries(completed)) {
    const parked = entry?.toolResult as
      | { content?: unknown; toolUseId?: unknown }
      | undefined;
    const view = wrappedToolResultView(parked);
    if (!view) {
      // A shape no reader here can take apart: no id to key a client result to,
      // or content it cannot even scan. Content that IS readable and holds no
      // stub is the one such shape nothing needs to fail closed on.
      //
      // Not `stubbed`: nothing here saw a stub, only content it could not rule
      // one out of, and provenance that guesses reports a backend call as
      // client-executed.
      if (mayMentionPlaceholder(parked?.content)) uncorrectable.add(parkedId);
      continue;
    }
    if (!mentionsPlaceholder(view.content)) continue;
    stubbed.add(view.toolUseId.trim() ? view.toolUseId : parkedId);
    // The dry run: the rewrite's own verdict, with no write asked for.
    if (view.toolUseId.trim() && planCorrection(view).repairable) {
      correctable.add(view.toolUseId);
      continue;
    }
    uncorrectable.add(parkedId);
  }
  return { correctable, uncorrectable, stubbed };
}

/**
 * Return ids for parked proxy placeholders the rewrite accepts.
 *
 * These are the ones a mapped client result repairs, so this is the set the
 * resume gate demands results for. The rewrite itself produced them, so once a
 * client result is mapped to one the correction cannot come back refused.
 */
export function activeProxyPlaceholderIds(agent: unknown): Set<string> {
  return parkedProxyPlaceholders(agent).correctable;
}

/**
 * Return ids for parked proxy placeholders the rewrite refuses.
 *
 * A mapped client result does not help these: the refusal is settled from the
 * parked result alone, so it stands however many results the turn carries.
 * Every caller reading this set has to fail closed on it rather than gate on a
 * result that would not be applied. The ids are the ones the checkpoint parked
 * them under, since a result whose own id is unreadable has no other name.
 */
export function uncorrectableProxyPlaceholderIds(agent: unknown): Set<string> {
  return parkedProxyPlaceholders(agent).uncorrectable;
}

/**
 * Return every id this thread's stored history or live checkpoint still answers
 * with a proxy placeholder.
 *
 * Provenance of last resort, and provenance ONLY: it says a call was handed to
 * the client, never that the store still records the call id, so admission stays
 * with the recorded ids alone. It settles who executed a result on a payload
 * where nothing else can say: a continuation declaring no tools whose recorded
 * id the size cap has since evicted still resolves the tool NAME off the native
 * history, and a name with no other signal reads as a tool Strands ran itself,
 * so the client's answer is filed as backend context and the model re-fires the
 * call. Only this adapter's proxy writes this stub, so its presence is proof.
 *
 * Detection is permissive, as everywhere a stub is merely REPORTED: a decorated
 * stub is still one this adapter wrote, even though no exact rewrite may touch
 * it. Permissive is not speculative, though: every id here is one a stub was
 * actually seen under. A parked shape this module could not read is reported to
 * the resume gates so none of them is blind to it, but nothing about it says who
 * executed it, and claiming it would report a backend call as client-executed.
 */
export function proxyPlaceholderProvenanceIds(agent: unknown): Set<string> {
  const ids = new Set<string>(parkedProxyPlaceholders(agent).stubbed);
  const messages = (agent as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return ids;
  for (const message of messages) {
    for (const view of toolResultViewsOf(message)) {
      if (view.toolUseId.trim() && mentionsPlaceholder(view.content)) {
        ids.add(view.toolUseId);
      }
    }
  }
  return ids;
}

/**
 * The result body the model should read for one client answer.
 *
 * A failure carries its reason, which is the whole content of a result whose
 * body is empty: `status: "error"` on its own says a frontend tool failed
 * without saying why. The tool name is deliberately absent, unlike the
 * continuation prompt's wording, because a `toolResult` block is already
 * attached to the call it answers.
 *
 * A failure with neither a reason nor a body still has to say it failed. Left
 * empty it would reach the content builder as a void result and be answered
 * with the "no return value" acknowledgement, which asserts success under
 * `status: "error"`.
 */
function resultText(result: PendingFrontendResult): string {
  if (!result.isError) return result.text;
  const reason = result.errorReason?.trim();
  if (reason) {
    return result.text.trim()
      ? `Failed: ${reason} (returned: ${result.text})`
      : `Failed: ${reason}`;
  }
  return result.text.trim() ? result.text : "Failed: no reason given.";
}

/**
 * The `toolResult` fields the real client answer owes the model.
 *
 * The single answer to "what does this client result look like to the model?".
 * Both paths that put one there call it: this module, which rewrites the
 * persisted placeholder, and the adapter's history replay, which builds the
 * block from the request when no session manager is wired. Which of the two
 * runs is a deployment detail, so deriving either half independently lets the
 * same answer reach the model as two different results.
 *
 * The content is `_buildToolResultContent`'s: a JSON body as structured data,
 * and a void one as a non-empty acknowledgement (an empty tool-result block is
 * rejected outright by OpenAI). The status is the client's failure signal,
 * which the placeholder's hardcoded `"success"` would otherwise assert away.
 */
export function clientResultFields(result: PendingFrontendResult): {
  status: "success" | "error";
  content: ToolResultContentData;
} {
  return {
    status: result.isError ? "error" : "success",
    content: _buildToolResultContent(
      resultText(result),
    ) as ToolResultContentData,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    // Indexed rather than through a callback iterator, which skips array holes:
    // a sparse array would then compare equal to any array of the same length,
    // and the comparison decides whether a persisted result already carries the
    // client's answer.
    for (let index = 0; index < a.length; index++) {
      if (!deepEqual(a[index], b[index])) return false;
    }
    return true;
  }
  const keys = Object.keys(a);
  // Counted, because the walk below only visits `a`'s keys: without this a
  // block with no keys at all matches every block, the stub included.
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      key in b &&
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  );
}

/**
 * Return true if `content` is exactly the one block `expected` describes.
 *
 * The persisted block is compared structurally rather than by its text: the
 * real result can be a `text` or a `json` block, and only a value comparison
 * recognises an exact client retry as already-correct in both cases. Persisted
 * history holds SDK class instances, which report their stored shape through
 * `toJSON()`, and plain objects where history was hydrated from data.
 */
function isSoleContentBlock(
  content: readonly unknown[],
  expected: ToolResultContentData,
): boolean {
  if (content.length !== 1) return false;
  const block = content[0];
  const data =
    block != null &&
    typeof block === "object" &&
    typeof (block as { toJSON?: unknown }).toJSON === "function"
      ? (block as { toJSON: () => unknown }).toJSON()
      : block;
  return deepEqual(data, expected);
}

/**
 * What a correction does to one `toolResult`.
 *
 * `apply` is present exactly when a write is needed, and returns the undo that
 * puts the result back. A repairable outcome without one is a result the
 * correction found already correct.
 */
type Correction =
  | { repairable: false }
  | { repairable: true; apply?: () => () => void };

const REFUSED: Correction = { repairable: false };
const NOTHING_TO_WRITE: Correction = { repairable: true };

/**
 * Decide what a correction does to `view`, and hand back the write itself.
 *
 * The single answer to "can this placeholder be repaired?". Omitting `result` is
 * a dry run: every decision is made and no write comes back to apply, which is
 * what `parkedProxyPlaceholders` splits its sets on, so the sets and the write
 * cannot hold different opinions about one result. The dry run is exact because
 * the permission to replace content is read from `view` alone and before
 * `result` is looked at, with both refusals behind it: nothing a client answer
 * can be turns a view this accepts into one it refuses.
 *
 * Both the content and the status are rewritten: the placeholder was written by
 * the proxy tool with a hardcoded `"success"`, so leaving the status alone would
 * assert a failed frontend tool to the model as a success.
 *
 * An answer whose body IS the stub's own content is repaired like any other. The
 * persisted result then says exactly what the client answered, and reading it
 * back later as an uncorrected stub costs nothing: the same answer against the
 * same content lands here again and is reported handled again. Refusing it
 * wedges the thread, because the resume gate demands a mapped result for every
 * placeholder this accepts and no path is left that could carry the answer.
 */
function planCorrection(
  view: ToolResultView,
  result?: PendingFrontendResult,
): Correction {
  // A rewrite replaces the whole content array, so it may only replace content
  // this adapter wrote.
  const replaceable = isExactPlaceholder(view.content);
  if (!result) return replaceable ? NOTHING_TO_WRITE : REFUSED;
  const { status: expectedStatus, content: built } = clientResultFields(result);
  // Already exactly the client's answer, so the correction is done: an exact
  // client retry. Reported without a write, which is also what keeps every
  // rewrite in this module behind the permission above. Rewriting a result to
  // the status and content it already holds would slip past it.
  if (view.status === expectedStatus && isSoleContentBlock(view.content, built))
    return NOTHING_TO_WRITE;
  if (!replaceable) return REFUSED;
  return { repairable: true, apply: () => view.rewrite(expectedStatus, built) };
}

/**
 * Reconcile each `toolResult` against the pending result for its id.
 *
 * `undos` carries one entry per result actually rewritten, so the caller can
 * put every surface back the way it found it.
 */
function correctViews(
  views: readonly ToolResultView[],
  pendingResults: ReadonlyMap<string, PendingFrontendResult>,
): { matched: Set<string>; undos: Array<() => void> } {
  const matched = new Set<string>();
  const undos: Array<() => void> = [];
  for (const view of views) {
    const result = pendingResults.get(view.toolUseId);
    if (!result) continue;
    const correction = planCorrection(view, result);
    if (!correction.repairable) continue;
    matched.add(view.toolUseId);
    if (correction.apply) undos.push(correction.apply());
  }
  return { matched, undos };
}

/**
 * Overwrite placeholder `toolResult` blocks with real client results.
 *
 * `pendingResults` MUST be keyed by the `toolUseId` Strands persisted, which
 * for a frontend call is also the id the client answers under.
 *
 * Every id whose placeholder ends up correct is dropped from the frontend-call
 * id store here, in the same snapshot as the correction itself: pruned by the
 * caller afterwards, the shorter list would only reach the store if some later
 * save happened to fire. Ids that were NOT corrected are kept so a later turn
 * can retry, and order is preserved so the emission-time size cap keeps
 * dropping the oldest first.
 *
 * The prune reads the store itself rather than taking a list from the caller:
 * whatever the caller read earlier in the turn, an id the store has gained
 * since belongs to a call whose result has not come back, and writing the older
 * list back would destroy the only record that admits that result later.
 *
 * Returns the set of `toolUseId`s whose pending result was already present or
 * whose placeholder was corrected in any reconciliation surface. Every write is
 * flushed to the store before returning, so a crash before the next invocation
 * boundary cannot lose it.
 *
 * Nothing survives a write the store refuses. Every correction and the prune
 * land in memory before the save that persists them, so a refused save undoes
 * them all and rethrows: the caller then forwards the
 * client's answer as a continuation prompt, which would tell the model an answer
 * twice over if a correction stayed in the history, and a prune kept without its
 * correction would retire a call id whose stub the store still holds.
 *
 * Putting the pruned ids back is itself an app-state write, so it is the one
 * step the store can refuse with nothing left to try: the shorter list then sits
 * where the next successful save flushes it, with the stubs already back in
 * memory and the ids that admit their answers gone. That is said out loud
 * through `log`, because the caller's fallback path reports that nothing of a
 * failed attempt survived.
 */
export async function reconcileFrontendToolResults(
  sessionManager: SessionManager,
  agent: unknown,
  pendingResults: ReadonlyMap<string, PendingFrontendResult>,
  log?: Logger,
): Promise<Set<string>> {
  const corrected = new Set<string>();
  const undos: Array<() => void> = [];
  const logger = resolveLogger(log);
  let mutated = false;
  // Read before the first mutation, so a store this cannot read fails the whole
  // attempt while there is still nothing to undo.
  const recordedCallIds = recordedFrontendCallIds(agent);

  const messages = ((agent as { messages?: Message[] }).messages ??
    []) as unknown[];
  for (const message of messages) {
    const outcome = correctViews(toolResultViewsOf(message), pendingResults);
    for (const id of outcome.matched) corrected.add(id);
    undos.push(...outcome.undos);
    mutated = mutated || outcome.undos.length > 0;
  }

  // An activated checkpoint parks its tool results outside `agent.messages`,
  // so the same correction runs over them. Whether an uncorrected parked result
  // may reach the model at all is decided before this call, in the adapter.
  const completed = activePendingToolResults(agent);
  if (completed) {
    const outcome = correctViews(
      parkedToolResultViews(completed),
      pendingResults,
    );
    for (const id of outcome.matched) corrected.add(id);
    undos.push(...outcome.undos);
    mutated = mutated || outcome.undos.length > 0;
  }

  /** Put the pruned call ids back, when a prune actually landed. */
  let restorePrunedCallIds: (() => void) | undefined;

  /**
   * Undo every in-memory write this call made: the content rewrites newest
   * first, then the recorded ids.
   *
   * The id restore goes last because it is the only undo that writes back
   * through the app state. Run first, a store that refuses it would strand
   * every content rollback behind it and mask the error that brought the
   * caller here.
   */
  const undoEverything = () => {
    for (const undo of [...undos].reverse()) undo();
    restorePrunedCallIds?.();
  };

  const remaining = recordedCallIds.filter((callId) => !corrected.has(callId));
  const pruned = remaining.length !== recordedCallIds.length;
  if (pruned) {
    if (!writeFrontendCallIds(agent, remaining, logger)) {
      // Saving the correction here would leave the store offering the call as
      // outstanding forever, so the attempt fails and the caller falls back.
      undoEverything();
      throw new Error(
        "Cannot reconcile frontend tool results: the agent's app state cannot " +
          "record the pruned frontend call ids",
      );
    }
    restorePrunedCallIds = () => {
      if (writeFrontendCallIds(agent, recordedCallIds, logger)) return;
      // The rollback's own write refused. There is no third surface to try, so
      // the prune stands: the ids the corrections retired are gone from the app
      // state while the stubs they answered are back in the history, and the
      // next successful save from any turn flushes that pairing to the store.
      logger.error(
        `${LOG_PREFIX} Rolled back the frontend tool result corrections but ` +
          `could not put the pruned frontend call ids back, so the calls ` +
          `${recordedCallIds.filter((callId) => corrected.has(callId)).join(", ")} ` +
          `can no longer be admitted and no later turn can carry their answers`,
      );
    };
  }

  // One snapshot carries both writes. The prune alone is worth a save: an exact
  // client retry corrects nothing, and its id still has to leave the store.
  if (mutated || pruned) {
    try {
      await sessionManager.saveSnapshot({
        target: agent as Parameters<
          SessionManager["saveSnapshot"]
        >[0]["target"],
        isLatest: true,
      });
    } catch (e) {
      undoEverything();
      throw e;
    }
  }
  return corrected;
}

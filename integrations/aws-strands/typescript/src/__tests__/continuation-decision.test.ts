/**
 * The continuation decision, enumerated.
 *
 * What a continuation turn should do is one decision over one input space, and
 * this file is that space written down. Every row fixes a point in it and
 * asserts the WHOLE outcome: whether the run failed and under which code, which
 * path ran, what the model actually received, and what the session store holds
 * afterwards. A change that moves one input therefore has to state what it did
 * to every row it touches.
 *
 * The dimensions:
 *
 *   admitted          the call id was still recorded when the result came back
 *   void              the client answered with nothing
 *   failed            the client reported a failure
 *   duplicateId       one payload repeats a call id
 *   unnameable        a trailing result nothing can name
 *   unnamedInRequest  only the store names the call the result answers
 *   resume            the turn carries `resume[]`
 *   replay            history replay into Strands, i.e. no session manager
 *   unwritableSession a session manager reached as a plugin, no `saveSnapshot`
 *   competingHalt     a `stopStreamingAfterResult` tool shares the batch
 *   streamerFails     the tool's `argsStreamer` throws, so args go out at once
 *   parked            an activated checkpoint parks the proxy placeholder
 *   withholdResume    the parked turn resumes with no answer for the call
 *   plainFollowUp     turn 2 is an ordinary user turn, not a resume
 *   malformed         the tool message's `content` is not a plain string
 *   deltaOnly         the payload sends the results alone, declaring no tools
 *   newerUser         a user message follows the result, so the turn has a prompt
 *   beforeUserTurn    the result arrives before a user turn, not after it
 *   trimmed           the history window slid past the turn holding the result
 *   declined          the correction was refused, so no repair landed
 *
 * The model is the only stub, so no provider is called. Every row drives a REAL
 * Strands `Agent`; what sits behind it is the `replay` and `unwritableSession`
 * dimensions' business, so a real `SessionManager` over a real on-disk
 * `FileStorage` is what MOST rows get rather than all of them: a `replay` row
 * wires no session manager and an `unwritableSession` row wires one with no
 * storage, and neither leaves anything on disk to read back. The rows that do
 * have a store also get a genuine restart, the continuation running on a
 * brand-new adapter, agent and session manager that share nothing but the
 * storage directory. A `parked` row is the exception: the checkpoint it resumes
 * is live in the first process, so it stays there.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileStorage, SessionManager } from "@strands-agents/sdk";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { PROXY_RESULT_PLACEHOLDER } from "../client-proxy-tool";
import type { StrandsAgentConfig } from "../config";
import {
  AG_UI_FRONTEND_CALL_IDS_STATE_KEY,
  activeProxyPlaceholderIds,
} from "../session-reconcile";
import {
  collect,
  errorCodes,
  minimalRunInput,
  modelSawTexts,
  modelTurn,
  persistedSnapshot,
  persistedToolResults,
  realStrandsAgent,
  recordingTool,
  snapshotPathOf,
  soleInterruptId,
  threadAgent,
  type PersistedSnapshot,
  type PersistedToolResult,
} from "./helpers";

const TOOL = "set_color";
/** The frontend call the rows revolve around. */
const FIRST = "native-first";
/** A sibling frontend call, for the rows that need two. */
const SECOND = "native-second";
/** A tool result id nothing in the request or the store can name. */
const GHOST = "native-ghost";
const APPROVE = "approve_it";
const APPROVE_ID = "native-approve";
const BACKEND = "read_temperature";
const BACKEND_ID = "native-backend";
const SESSION_ID = "decision-session";
/** The continuation model's only turn, once it can see the real result. */
const ANSWER = "The color is now red.";

const CLIENT_TOOLS = [
  {
    name: TOOL,
    description: "Sets a UI color.",
    parameters: {
      type: "object",
      properties: { color: { type: "string" } },
      required: ["color"],
    },
  },
] as never;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agui-strands-decision-"));
  dirs.push(dir);
  return dir;
}

// --------------------------------------------------------------------------
// Reading the store
// --------------------------------------------------------------------------

/**
 * Where the snapshot the session manager wrote lives, failing when there is
 * none. Only the rows that EDIT the store need the path itself; everything that
 * merely reads it goes through the shared readers.
 */
function snapshotPath(dir: string): string {
  const path = snapshotPathOf(dir);
  expect(path, `no snapshot was persisted under ${dir}`).toBeDefined();
  return path!;
}

function writeSnapshot(dir: string, snapshot: PersistedSnapshot): void {
  writeFileSync(snapshotPath(dir), JSON.stringify(snapshot));
}

/** The recorded frontend-call ids as the store holds them. */
function persistedCallIds(dir: string): unknown {
  return persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY];
}

/**
 * Drop one recorded frontend-call id, leaving its persisted placeholder alone.
 *
 * NOT what the size cap does to THIS id. The cap evicts oldest-first, so the
 * newest recorded id, which is the one every row here forgets, is precisely the
 * one eviction keeps. A store reaches this state by losing the record some other
 * way: a snapshot restored from before the call was recorded, a replica that lost
 * the write, or the cap finally reaching an OLD call only answered after
 * `FRONTEND_CALL_IDS_MAX` later ones. However it got here, the next process still
 * restores that call's placeholder while nothing left in the store records the
 * call id.
 */
function forgetCallId(dir: string, toolUseId: string): void {
  const snapshot = persistedSnapshot(dir);
  const state = snapshot.data.state;
  const ids = state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY] as string[] | undefined;
  expect(ids, "expected the call id to forget to be recorded").toContain(
    toolUseId,
  );
  state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY] = ids!.filter(
    (id) => id !== toolUseId,
  );
  writeSnapshot(dir, snapshot);
}

/**
 * Trim the stored history the way the SDK's sliding window really does: whole
 * messages spliced off the front, through the turn holding `toolUseId`'s
 * `toolResult`.
 *
 * `SlidingWindowConversationManager._reduceContext` does exactly one thing to the
 * history, `messages.splice(0, trimIndex)`, and it advances `trimIndex` past any
 * point that would leave a leading orphaned `toolResult` or an unanswered
 * `toolUse`. So it can never remove a `toolResult` block on its own: the
 * assistant turn carrying the call goes with it. (The one thing that rewrites a
 * block in place is `_truncateToolResults`, which keeps the `toolUseId` and
 * replaces the body, and only on a context-overflow error.)
 *
 * The recorded call id survives, because app state is not history. The result is
 * still admitted; there is simply no block left anywhere to correct.
 */
function trimTurnsThrough(dir: string, toolUseId: string): void {
  const snapshot = persistedSnapshot(dir);
  const messages = snapshot.data.messages as Array<{ content?: unknown[] }>;
  const through = messages.findIndex((message) =>
    (message.content ?? []).some(
      (block) =>
        (block as { toolResult?: { toolUseId?: string } }).toolResult
          ?.toolUseId === toolUseId,
    ),
  );
  expect(
    through,
    "expected a persisted result block to trim through",
  ).toBeGreaterThan(-1);
  snapshot.data.messages = messages.slice(through + 1);
  writeSnapshot(dir, snapshot);
}

// --------------------------------------------------------------------------
// The row spec
// --------------------------------------------------------------------------

/** How the client answered one frontend call. */
interface Answer {
  /** Empty means the client answered with nothing (a render-only tool). */
  text?: string;
  /** Present means the client reported a failure. */
  error?: string;
  /** `content` shapes other than the plain string the AG-UI wire declares. */
  shape?: "null" | "blocks" | "json" | "object";
  /** Forget this call's recorded id before the continuation runs. */
  forget?: boolean;
  /** Slide the history window past this call's turn before continuing. */
  trim?: boolean;
  /** Repeat this answer under the same call id in the same payload. */
  duplicate?: boolean;
  /**
   * Place this answer BEFORE a user turn in the payload, so a later answer is
   * what trails it. A slow client tool answered after the human typed again.
   */
  beforeUserTurn?: boolean;
  /** The payload's assistant turn omits this call, so only the store names it. */
  unnamedInRequest?: boolean;
}

interface Row {
  name: string;
  /**
   * Which of the enumerated dimensions this row moves off its default. Kept
   * beside the row so the table reads as a map of the space rather than as a
   * list of scenarios.
   */
  dims: string;
  /** The frontend calls turn 1 makes, and how the client answered each. */
  answers: Record<string, Answer>;
  /** A `stopStreamingAfterResult` backend tool shares turn 1's batch. */
  competingHalt?: boolean;
  /** The frontend tool's `argsStreamer` throws, taking the burst emit path. */
  streamerFails?: boolean;
  /** An approval interrupt parks the proxy placeholder; the turn resumes. */
  parked?: boolean;
  /** Resume the parked checkpoint without answering the frontend call. */
  withholdResume?: boolean;
  /**
   * Follow turn 1 with an ORDINARY turn rather than a resume: a bare user
   * message on the same process. The only question such a row asks is whether
   * a plain turn is possible on this thread at all.
   */
  plainFollowUp?: boolean;
  /** No session manager at all, so history replay into Strands governs. */
  replay?: boolean;
  /** A session manager with no `saveSnapshot`, reached as a plugin. */
  unwritableSession?: boolean;
  /** An extra trailing tool result nothing can name. */
  unnameable?: boolean;
  /** A user message after the tool results, so the turn has a new prompt. */
  newerUser?: boolean;
  /** Send the continuation with no tool declarations (a delta-only payload). */
  deltaOnly?: boolean;
  expected: Observed;
}

/**
 * Everything one row pins.
 *
 * `turn1` is here because two of the defects live in turn 1: what the halt
 * persists is the only thing a continuation has to repair, so a row that only
 * looked at turn 2 could not tell a correct repair from a turn that never left
 * anything to repair.
 */
interface Observed {
  turn1: {
    errors: string[];
    /** null when the row runs without a session manager. */
    results: PersistedToolResult[] | null;
    callIds: unknown;
  };
  errors: string[];
  /**
   * Which path the continuation took, read off what the model was handed:
   * "history" means it continued from native history alone, "prompt" means the
   * adapter synthesised user text to carry what the history could not,
   * "user-turn" means the client's own user text went out unaltered, and "none"
   * means the run ended before reaching the model.
   *
   * The last two are kept apart because they answer different questions. A
   * synthetic prompt is a fallback and its wording is the adapter's; a plain
   * user turn is just this run's prompt, and a row that called one the other
   * would report a fallback that never ran.
   */
  path: "history" | "prompt" | "user-turn" | "none";
  /** The trailing user text, verbatim, on either of the two prompt paths. */
  prompt: string | null;
  /**
   * How many times the continuation called the model. Pinned because every
   * other field is silent about a run that reached the provider twice, or about
   * a fail-closed that yielded its error and streamed anyway.
   */
  modelCalls: number;
  /** Every text the model actually received on the continuation. */
  modelSaw: string[];
  results: PersistedToolResult[] | null;
  callIds: unknown;
  /**
   * Exact proxy placeholders the live checkpoint still parks afterwards. A
   * refusal that leaves one parked is a refusal no later run can repair, and a
   * checkpoint left activated with nothing advertised wedges the thread.
   */
  parkedIds: string[];
}

const stub = (toolUseId: string): PersistedToolResult => ({
  toolUseId,
  status: "success",
  content: [{ text: PROXY_RESULT_PLACEHOLDER }],
});

const answered = (
  toolUseId: string,
  text: string,
  status = "success",
): PersistedToolResult => ({ toolUseId, status, content: [{ text }] });

// --------------------------------------------------------------------------
// The runner
// --------------------------------------------------------------------------

type Booted = ReturnType<typeof realStrandsAgent>;

/** The AG-UI `content` for one answer, in the shape the row asked for. */
function answerContent(answer: Answer): unknown {
  const text = answer.text ?? "";
  switch (answer.shape) {
    case "null":
      return null;
    case "blocks":
      return [{ type: "text", text }];
    case "json":
      return JSON.stringify({ body: text });
    case "object":
      // Off the AG-UI wire contract, which declares `content` a string. It must
      // degrade to a coerced, non-empty body rather than crash or vanish.
      return { body: text };
    default:
      return text;
  }
}

/** The text of the last user message the client actually sent, if any. */
function clientUserText(input: RunAgentInput): string | undefined {
  const messages = input.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    return typeof message.content === "string" ? message.content : undefined;
  }
  return undefined;
}

/**
 * Which path the continuation took, and the trailing user text it carried.
 *
 * A run that continues from native history ends that history on the `toolResult`
 * the client's answer belongs to and adds no user text of its own. Either prompt
 * path adds one, so the trailing user text is what separates history from prompt
 * without the test having to reach into the adapter. It is the TEXT and not the
 * message boundary that says so: two consecutive user turns are a shape no
 * provider accepts, so a prompt sent while the history already ends on a
 * user-role `toolResult` turn travels inside that turn rather than after it, and
 * a reader keyed on the boundary would call such a run a history continuation
 * that sent no answer at all. Which prompt it is comes from comparing the text
 * against what the client sent: identical means the client's own turn went out,
 * anything else is the adapter's own wording.
 */
function classifyPath(
  model: Booted["model"],
  call: number,
  sent: string | undefined,
): { path: Observed["path"]; prompt: string | null } {
  const messages = model.seenMessages[call];
  if (!messages || messages.length === 0) return { path: "none", prompt: null };
  const last = messages[messages.length - 1]!;
  const texts =
    last.role === "user"
      ? (last.content as unknown[])
          .map((block) => (block as { text?: unknown }).text)
          .filter((text): text is string => typeof text === "string")
      : [];
  if (texts.length === 0) return { path: "history", prompt: null };
  const prompt = texts.join("\n");
  return { path: prompt === sent ? "user-turn" : "prompt", prompt };
}

function sessionProvider(dir: string) {
  return () =>
    new SessionManager({
      sessionId: SESSION_ID,
      storage: { snapshot: new FileStorage(dir) },
    });
}

/** Turn 1's model script: one batch calling everything the row needs. */
function turnOneScript(row: Row) {
  const calls = Object.keys(row.answers).map((toolUseId) => ({
    toolUseId,
    name: TOOL,
    input: { color: toolUseId },
  }));
  if (row.competingHalt) {
    calls.push({
      toolUseId: BACKEND_ID,
      name: BACKEND,
      input: {} as { color: string },
    });
  }
  if (row.parked) {
    calls.push({
      toolUseId: APPROVE_ID,
      name: APPROVE,
      input: {} as { color: string },
    });
  }
  return [modelTurn.toolUse(...calls), modelTurn.text(ANSWER)];
}

/**
 * The adapter config a row needs, and the real SDK tools to register.
 *
 * A restarted process gets a script that only ANSWERS. Replaying turn 1's batch
 * there would have the model re-fire the same call ids, which the identity guard
 * rejects, and no continuation ever asks a model to repeat the call it is
 * answering.
 */
function bootFor(
  row: Row,
  dir: string,
  restarted = false,
  logger?: StrandsAgentConfig["logger"],
): Booted {
  const tools: unknown[] = [];
  const toolBehaviors: NonNullable<StrandsAgentConfig["toolBehaviors"]> = {};
  if (row.competingHalt) {
    tools.push(recordingTool(BACKEND).tool);
    toolBehaviors[BACKEND] = { stopStreamingAfterResult: true };
  }
  if (row.parked) {
    tools.push(recordingTool(APPROVE).tool);
    toolBehaviors[APPROVE] = { interruptOnCall: true };
  }
  if (row.streamerFails) {
    toolBehaviors[TOOL] = {
      // eslint-disable-next-line require-yield
      argsStreamer: async function* () {
        throw new Error("scripted args streamer failure");
      },
    };
  }
  const config: StrandsAgentConfig = { toolBehaviors };
  if (logger) config.logger = logger;
  if (row.unwritableSession) {
    const unwritable = { name: "unwritable", initAgent: () => {} };
    config.sessionManagerProvider = () =>
      unwritable as unknown as SessionManager;
  } else if (!row.replay) {
    config.sessionManagerProvider = sessionProvider(dir);
  }
  const script = restarted ? [modelTurn.text(ANSWER)] : turnOneScript(row);
  return realStrandsAgent(script, { tools, config });
}

const firstRun = (): RunAgentInput =>
  minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "make it red" } as never],
    tools: CLIENT_TOOLS,
  });

/**
 * The continuation payload the row's answers describe.
 *
 * By default it is the whole thread as an ordinary client resends it: the user
 * turn, the assistant turn carrying the tool calls, then the results. A
 * `deltaOnly` row sends the results alone, which is the hard case where nothing
 * in the REQUEST says who executed them and only the store can.
 */
function continuationFor(row: Row, interruptId?: string): RunAgentInput {
  const messages: unknown[] = [];
  let index = 0;
  if (row.plainFollowUp) {
    return minimalRunInput({
      runId: "run-2",
      messages: [{ id: "u2", role: "user", content: "and darker" } as never],
      tools: CLIENT_TOOLS,
    });
  }
  if (!row.deltaOnly) {
    messages.push({ id: "u1", role: "user", content: USER });
    messages.push({
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: Object.entries(row.answers)
        .filter(([, answer]) => !answer.unnamedInRequest)
        .map(([toolUseId]) => ({
          id: toolUseId,
          type: "function",
          function: { name: TOOL, arguments: "{}" },
        })),
    });
  }
  const pushAnswers = (beforeUserTurn: boolean): void => {
    for (const [toolCallId, answer] of Object.entries(row.answers)) {
      if (row.withholdResume) continue;
      if (!!answer.beforeUserTurn !== beforeUserTurn) continue;
      const copies = answer.duplicate ? 2 : 1;
      for (let i = 0; i < copies; i++) {
        messages.push({
          id: `t${++index}`,
          role: "tool",
          toolCallId,
          content: answerContent(answer),
          ...(answer.error ? { error: answer.error } : {}),
        });
      }
    }
  };
  pushAnswers(true);
  if (Object.values(row.answers).some((answer) => answer.beforeUserTurn)) {
    messages.push({ id: "u-mid", role: "user", content: MID_USER });
  }
  pushAnswers(false);
  if (row.unnameable) {
    messages.push({
      id: `t${++index}`,
      role: "tool",
      toolCallId: GHOST,
      content: "orphan",
    });
  }
  if (row.newerUser) {
    messages.push({ id: "u2", role: "user", content: "and darker" });
  }
  return minimalRunInput({
    runId: "run-2",
    messages: messages as never,
    tools: row.deltaOnly ? [] : CLIENT_TOOLS,
    ...(interruptId
      ? {
          resume: [
            { interruptId, status: "resolved", payload: { approved: true } },
          ],
        }
      : {}),
  } as Partial<RunAgentInput>);
}

/**
 * Drive one row and report everything it pins.
 *
 * A row whose turn needs the live checkpoint (`parked`) continues on the same
 * process, because only that process knows the interrupt id it must resume.
 * Every other row restarts: the continuation adapter, agent and session manager
 * are new and share nothing but the storage directory.
 */
async function runRow(row: Row): Promise<Observed> {
  const dir = storageDir();
  const first = bootFor(row, dir);
  const firstEvents = await collect(first.agent, firstRun());
  const hasStore = !row.replay && !row.unwritableSession;

  const turn1 = {
    errors: errorCodes(firstEvents),
    results: hasStore ? persistedToolResults(dir) : null,
    callIds: hasStore ? persistedCallIds(dir) : null,
  };

  if (hasStore) {
    for (const [toolUseId, answer] of Object.entries(row.answers)) {
      if (answer.trim) trimTurnsThrough(dir, toolUseId);
      if (answer.forget) forgetCallId(dir, toolUseId);
    }
  }

  const second = row.parked ? first : bootFor(row, dir, true);
  const interruptId =
    row.parked && !row.plainFollowUp ? soleInterruptId(firstEvents) : undefined;
  const before = second.model.calls;
  const continuation = continuationFor(row, interruptId);
  const events = await collect(second.agent, continuation);
  const call = second.model.calls - 1;
  const modelCalls = second.model.calls - before;
  const reached = modelCalls > 0;

  const { path, prompt } = reached
    ? classifyPath(second.model, call, clientUserText(continuation))
    : { path: "none" as const, prompt: null };

  return {
    turn1,
    errors: errorCodes(events),
    path,
    prompt,
    modelCalls,
    modelSaw: reached ? modelSawTexts(second.model, call) : [],
    results: hasStore ? persistedToolResults(dir) : null,
    callIds: hasStore ? persistedCallIds(dir) : null,
    parkedIds: [...activeProxyPlaceholderIds(threadAgent(second.agent))].sort(),
  };
}

// --------------------------------------------------------------------------
// The table
// --------------------------------------------------------------------------

/** The user text turn 1 sends, which every replayed history starts with. */
const USER = "make it red";

/** What the human typed while a slow client tool was still resolving. */
const MID_USER = "and warmer";

/**
 * The one row whose repair DECLINES: the window slid past the turn holding the
 * placeholder, so the result is still admitted and there is no longer a block
 * anywhere to correct. Named because the log assertion after the table drives
 * the same point in the space and must not drift from it.
 */
const SLID_PAST_ROW: Row = {
  name: "an admitted result the history window slid past reaches the model as a prompt",
  dims: "admitted, non-void, trimmed, declined",
  answers: { [FIRST]: { text: "color applied", trim: true } },
  expected: {
    turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
    errors: [],
    path: "prompt",
    modelCalls: 1,
    prompt: `${TOOL} returned: color applied`,
    // The window splices whole messages, so the user turn goes with the pair and
    // the model sees the prompt alone. Nothing was corrected, because there was
    // no block left to correct, so the answer has to arrive as that prompt or it
    // reaches the model nowhere at all.
    modelSaw: [`${TOOL} returned: color applied`],
    results: [],
    callIds: [FIRST],
    parkedIds: [],
  },
};

const ROWS: Row[] = [
  {
    name: "an admitted non-void result reconciles and continues from history",
    dims: "admitted, non-void",
    answers: { [FIRST]: { text: "color applied" } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "color applied"],
      results: [answered(FIRST, "color applied")],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "an admitted VOID result reconciles too, so no stub is read to the model",
    dims: "admitted, void",
    answers: { [FIRST]: { text: "" } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "Tool executed successfully with no return value."],
      results: [
        answered(FIRST, "Tool executed successfully with no return value."),
      ],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "an admitted void FAILURE reconciles as an error, not a silent success",
    dims: "admitted, void, failed",
    answers: { [FIRST]: { text: "", error: "user denied" } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "Failed: user denied"],
      results: [answered(FIRST, "Failed: user denied", "error")],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "an admitted non-void failure carries both reason and body",
    dims: "admitted, non-void, failed",
    answers: { [FIRST]: { text: "partial", error: "user denied" } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "Failed: user denied (returned: partial)"],
      results: [
        answered(FIRST, "Failed: user denied (returned: partial)", "error"),
      ],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "an UNADMITTED non-void result repairs nothing and reaches the model as a prompt",
    dims: "unadmitted, non-void",
    answers: { [FIRST]: { text: "color applied", forget: true } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "prompt",
      modelCalls: 1,
      prompt: `${TOOL} returned: color applied`,
      modelSaw: [
        USER,
        PROXY_RESULT_PLACEHOLDER,
        `${TOOL} returned: color applied`,
      ],
      results: [stub(FIRST)],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "an UNADMITTED void FAILURE beside an admitted result repairs neither",
    dims: "admitted+unadmitted, void, failed",
    answers: {
      [FIRST]: { text: "color applied" },
      [SECOND]: { text: "", error: "user denied", forget: true },
    },
    expected: {
      turn1: {
        errors: [],
        results: [stub(FIRST), stub(SECOND)],
        callIds: [FIRST, SECOND],
      },
      errors: [],
      path: "prompt",
      modelCalls: 1,
      // The denial has to reach the model. Repairing only the admitted half is
      // what leaves the model reading the other half's stub as a success.
      prompt: `${TOOL} returned: color applied\n${TOOL} failed: user denied`,
      modelSaw: [
        USER,
        PROXY_RESULT_PLACEHOLDER,
        PROXY_RESULT_PLACEHOLDER,
        `${TOOL} returned: color applied\n${TOOL} failed: user denied`,
      ],
      results: [stub(FIRST), stub(SECOND)],
      callIds: [FIRST],
      parkedIds: [],
    },
  },
  {
    name: "a payload repeating one admitted call id still reconciles",
    dims: "admitted, non-void, duplicateId",
    answers: { [FIRST]: { text: "color applied", duplicate: true } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "color applied"],
      results: [answered(FIRST, "color applied")],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "a repeated call id that is NOT admitted still repairs nothing",
    dims: "unadmitted, non-void, duplicateId",
    answers: {
      [FIRST]: { text: "color applied", duplicate: true, forget: true },
    },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "prompt",
      modelCalls: 1,
      prompt: `${TOOL} returned: color applied\n${TOOL} returned: color applied`,
      modelSaw: [
        USER,
        PROXY_RESULT_PLACEHOLDER,
        `${TOOL} returned: color applied\n${TOOL} returned: color applied`,
      ],
      results: [stub(FIRST)],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "an unnameable trailing result fails the run closed on the reconcile path",
    dims: "admitted, non-void, unnameable",
    answers: { [FIRST]: { text: "color applied" } },
    unnameable: true,
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: ["CONTINUATION_TOOL_NAME_UNRESOLVED"],
      path: "none",
      modelCalls: 0,
      prompt: null,
      modelSaw: [],
      // Failing closed has to leave the turn exactly as repairable as it was,
      // or the retry has no admission signal and the thread fails forever.
      results: [stub(FIRST)],
      callIds: [FIRST],
      parkedIds: [],
    },
  },
  {
    name: "an unnameable trailing result fails the run closed on the resume path",
    dims: "admitted, non-void, unnameable, resume, parked",
    answers: { [FIRST]: { text: "color applied" } },
    parked: true,
    unnameable: true,
    expected: {
      // A checkpoint parks its tool results OUTSIDE `agent.messages`, so the
      // store's message list holds none of them yet.
      turn1: { errors: [], results: [], callIds: [FIRST] },
      errors: ["CONTINUATION_TOOL_NAME_UNRESOLVED"],
      path: "none",
      modelCalls: 0,
      prompt: null,
      modelSaw: [],
      results: [],
      callIds: [FIRST],
      // Failing closed before the checkpoint is consumed is what leaves the
      // resume retryable.
      parkedIds: [FIRST],
    },
  },
  {
    name: "an unnameable trailing result fails the run closed on the replay path too",
    dims: "non-void, unnameable, replay",
    answers: { [FIRST]: { text: "color applied" } },
    replay: true,
    unnameable: true,
    expected: {
      turn1: { errors: [], results: null, callIds: null },
      // Replay looks exempt, since a result rides its own `toolResult` block
      // addressed by id and needs no name. But the two conditions arrive
      // together: nothing can name the call BECAUSE the assistant `toolUse`
      // block is absent, so the replay would hand the provider a `toolResult`
      // answering no call. Exempting it swaps this error for whatever the
      // provider says about that, which is worse and no more repairable.
      errors: ["CONTINUATION_TOOL_NAME_UNRESOLVED"],
      path: "none",
      modelCalls: 0,
      prompt: null,
      modelSaw: [],
      results: null,
      callIds: null,
      parkedIds: [],
    },
  },
  SLID_PAST_ROW,
  {
    name: "a competing stopStreamingAfterResult tool still lets the frontend halt persist",
    dims: "admitted, non-void, competingHalt",
    answers: { [FIRST]: { text: "color applied" } },
    competingHalt: true,
    expected: {
      turn1: {
        errors: [],
        // The halt has to latch on the batch, not on the first result: this
        // pair is the only thing the continuation has to repair.
        results: [
          stub(FIRST),
          {
            toolUseId: BACKEND_ID,
            status: "success",
            content: [{ json: { ran: BACKEND } }],
          },
        ],
        callIds: [FIRST],
      },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "color applied"],
      results: [
        answered(FIRST, "color applied"),
        {
          toolUseId: BACKEND_ID,
          status: "success",
          content: [{ json: { ran: BACKEND } }],
        },
      ],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "an args-streamer failure still arms the halt, so the placeholder is not read as the answer",
    dims: "admitted, non-void, streamer failure",
    answers: { [FIRST]: { text: "color applied" } },
    streamerFails: true,
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "color applied"],
      results: [answered(FIRST, "color applied")],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "a parked placeholder is corrected when the resume carries the answer",
    dims: "admitted, non-void, resume, parked",
    answers: { [FIRST]: { text: "color applied" } },
    parked: true,
    expected: {
      turn1: { errors: [], results: [], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      // The approval's own result is a `json` block, so it carries no text here.
      modelSaw: [USER, "color applied"],
      results: [
        answered(FIRST, "color applied"),
        {
          toolUseId: APPROVE_ID,
          status: "success",
          content: [{ json: { ran: APPROVE } }],
        },
      ],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "a resume withholding the parked answer is refused and stays retryable",
    dims: "resume, parked, no mapped result",
    answers: { [FIRST]: { text: "color applied" } },
    parked: true,
    withholdResume: true,
    expected: {
      turn1: { errors: [], results: [], callIds: [FIRST] },
      errors: ["INTERRUPT_RECONCILIATION_ERROR"],
      path: "none",
      modelCalls: 0,
      prompt: null,
      modelSaw: [],
      results: [],
      callIds: [FIRST],
      // Refused before anything was rewritten, so the retry has it all.
      parkedIds: [FIRST],
    },
  },
  {
    // The client echoes the stub text back as its answer. Refusing that wedged
    // the thread for good: the resume gate demands a mapped result for every
    // parked placeholder the rewrite accepts, this row supplies one, and the
    // rewrite then refused it. The run failed with the checkpoint still
    // activated, which leaves every later plain run refused for pending
    // interrupts and every resume carrying the same answer refused again.
    name: "a resume answered with the stub's own text is applied like any other",
    dims: "admitted, resume, parked",
    answers: { [FIRST]: { text: PROXY_RESULT_PLACEHOLDER } },
    parked: true,
    expected: {
      turn1: { errors: [], results: [], callIds: [FIRST] },
      errors: [],
      path: "history",
      // What the model reads is exactly what the client answered. The stored
      // result needs no rewrite to say that, and the call id still retires.
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, PROXY_RESULT_PLACEHOLDER],
      results: [
        answered(FIRST, PROXY_RESULT_PLACEHOLDER),
        {
          toolUseId: APPROVE_ID,
          status: "success",
          content: [{ json: { ran: APPROVE } }],
        },
      ],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "a mixed checkpoint with no session manager is refused without wedging the thread",
    dims: "parked, no session manager",
    answers: { [FIRST]: { text: "color applied" } },
    parked: true,
    replay: true,
    plainFollowUp: true,
    expected: {
      turn1: {
        errors: ["INTERRUPT_SESSION_REQUIRED"],
        results: null,
        callIds: null,
      },
      // The checkpoint was never advertised and never can be, so no client can
      // ever resume it. Leaving it activated is what turns every later plain
      // run into PENDING_INTERRUPTS and every resume into UNKNOWN_INTERRUPT_ID.
      errors: [],
      path: "user-turn",
      modelCalls: 1,
      prompt: "and darker",
      modelSaw: ["and darker"],
      results: null,
      callIds: null,
      parkedIds: [],
    },
  },
  {
    name: "a mixed checkpoint with an unwritable session manager is refused without wedging the thread",
    dims: "parked, session manager without saveSnapshot",
    answers: { [FIRST]: { text: "color applied" } },
    parked: true,
    unwritableSession: true,
    plainFollowUp: true,
    expected: {
      turn1: {
        errors: ["INTERRUPT_SESSION_CAPABILITY_ERROR"],
        results: null,
        callIds: null,
      },
      errors: [],
      path: "user-turn",
      modelCalls: 1,
      prompt: "and darker",
      // This manager holds history in memory, so turn 1's user turn is still
      // there. Only the checkpoint was abandoned.
      modelSaw: [USER, "and darker"],
      results: null,
      callIds: null,
      parkedIds: [],
    },
  },
  {
    name: "history replay carries an admitted-free result with no store at all",
    dims: "non-void, replay",
    answers: { [FIRST]: { text: "color applied" } },
    replay: true,
    expected: {
      turn1: { errors: [], results: null, callIds: null },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "color applied"],
      results: null,
      callIds: null,
      parkedIds: [],
    },
  },
  {
    name: "history replay acknowledges a void result rather than replaying nothing",
    dims: "void, replay",
    answers: { [FIRST]: { text: "" } },
    replay: true,
    expected: {
      turn1: { errors: [], results: null, callIds: null },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "Tool executed successfully with no return value."],
      results: null,
      callIds: null,
      parkedIds: [],
    },
  },
  {
    name: "a newer user message stays this run's prompt even after a clean repair",
    dims: "admitted, non-void, newer user message",
    answers: { [FIRST]: { text: "color applied" } },
    newerUser: true,
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      // The client's own turn, not a fallback the adapter phrased: the repair
      // landed, so the history already carries the answer.
      path: "user-turn",
      modelCalls: 1,
      prompt: "and darker",
      modelSaw: [USER, "color applied", "and darker"],
      results: [answered(FIRST, "color applied")],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "a declined repair still carries the answer ahead of a newer user message",
    dims: "admitted, non-void, newerUser, trimmed, declined",
    answers: { [FIRST]: { text: "color applied", trim: true } },
    newerUser: true,
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      // The adapter's own wording, not the client's turn: the repair declined,
      // so the history carries nothing and sending the user's message alone
      // would drop the answer entirely.
      path: "prompt",
      modelCalls: 1,
      prompt: `${TOOL} returned: color applied\nand darker`,
      modelSaw: [`${TOOL} returned: color applied\nand darker`],
      results: [],
      callIds: [FIRST],
      parkedIds: [],
    },
  },
  {
    name: "an unnameable answer carried into a newer user message's prompt fails closed",
    dims: "admitted, non-void, deltaOnly, newerUser, trimmed, declined",
    answers: { [FIRST]: { text: "color applied", trim: true } },
    deltaOnly: true,
    newerUser: true,
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      // The window took the assistant turn with the result, and a delta-only
      // payload never carried one, so nothing names the tool. Carrying the
      // answer needs the name exactly as a trailing result does, so it fails
      // under the same code rather than being dropped from a prompt that
      // cannot phrase it.
      errors: ["CONTINUATION_TOOL_NAME_UNRESOLVED"],
      path: "none",
      modelCalls: 0,
      prompt: null,
      modelSaw: [],
      results: [],
      callIds: [FIRST],
      parkedIds: [],
    },
  },
  {
    name: "a null content body is a void answer, not a crash",
    dims: "admitted, void, malformed (null)",
    answers: { [FIRST]: { shape: "null" } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "Tool executed successfully with no return value."],
      results: [
        answered(FIRST, "Tool executed successfully with no return value."),
      ],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "a block-array content body is flattened to its text",
    dims: "admitted, non-void, malformed (blocks)",
    answers: { [FIRST]: { text: "color applied", shape: "blocks" } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "color applied"],
      results: [answered(FIRST, "color applied")],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "a JSON-encoded content body reconciles as structured data",
    dims: "admitted, non-void, malformed (json)",
    answers: { [FIRST]: { text: "color applied", shape: "json" } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER],
      results: [
        {
          toolUseId: FIRST,
          status: "success",
          content: [{ json: { body: "color applied" } }],
        },
      ],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    name: "an off-contract object content body degrades to a coerced body",
    dims: "admitted, non-void, malformed (object)",
    answers: { [FIRST]: { text: "color applied", shape: "object" } },
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      // Lossy, because `content` was never a string. What matters is that the
      // stub is still replaced and the id still pruned: leaving either is what
      // wedges the thread on an off-contract payload.
      modelSaw: [USER, "[object Object]"],
      results: [answered(FIRST, "[object Object]")],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    // The re-fire loop, at its narrowest. Nothing in the REQUEST says who
    // executed this result and the store no longer records the call id, so the
    // only signal left is the placeholder the proxy itself persisted.
    name: "a delta-only payload whose call id the store forgot still says what came back",
    dims: "unadmitted, non-void, deltaOnly",
    answers: { [FIRST]: { text: "color applied", forget: true } },
    deltaOnly: true,
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "prompt",
      modelCalls: 1,
      // Not the greeting. A name resolved off the native history with no other
      // signal reads as a tool Strands ran itself, and filing the client's
      // answer that way is what left the prompt a bare "Hello" and had the
      // model call the same tool again.
      prompt: `${TOOL} returned: color applied`,
      modelSaw: [
        USER,
        PROXY_RESULT_PLACEHOLDER,
        `${TOOL} returned: color applied`,
      ],
      results: [stub(FIRST)],
      callIds: [],
      parkedIds: [],
    },
  },
  {
    /**
     * An OLDER answer, lost entirely. Taking the turn's newer-user-message flag
     * from the LAST client answer alone hides an answer with a user turn after
     * it whenever a later answer trails the payload: the trailing derivation
     * never phrases it, the carry that exists for exactly that case is gated
     * off, and its own placeholder stays uncorrected.
     */
    name: "an older answer before a user turn still reaches the model",
    dims: "admitted+unadmitted, non-void, older answer before a user turn",
    answers: {
      [FIRST]: { text: "color applied", beforeUserTurn: true, forget: true },
      [SECOND]: { text: "size applied" },
    },
    expected: {
      turn1: {
        errors: [],
        results: [stub(FIRST), stub(SECOND)],
        callIds: [FIRST, SECOND],
      },
      errors: [],
      path: "prompt",
      modelCalls: 1,
      // In payload order, and ahead of nothing else: the answers are all this
      // run has to say, and the older one reaching the model nowhere at all is
      // what left the model to re-fire the call it was being answered about.
      prompt: `${TOOL} returned: color applied\n${TOOL} returned: size applied`,
      modelSaw: [
        USER,
        PROXY_RESULT_PLACEHOLDER,
        PROXY_RESULT_PLACEHOLDER,
        `${TOOL} returned: color applied\n${TOOL} returned: size applied`,
      ],
      results: [stub(FIRST), stub(SECOND)],
      callIds: [SECOND],
      parkedIds: [],
    },
  },
  {
    /**
     * The same gate silenced the fail-closed report: an older answer nothing can
     * name has to be refused exactly as a trailing one is, because the prompt
     * that would carry it cannot phrase it either.
     */
    name: "an older answer nothing can name fails closed rather than vanishing",
    dims: "admitted, non-void, older answer before a user turn, unnameable, trimmed",
    answers: {
      [FIRST]: {
        text: "color applied",
        beforeUserTurn: true,
        unnamedInRequest: true,
        trim: true,
      },
      [SECOND]: { text: "size applied" },
    },
    expected: {
      turn1: {
        errors: [],
        results: [stub(FIRST), stub(SECOND)],
        callIds: [FIRST, SECOND],
      },
      errors: ["CONTINUATION_TOOL_NAME_UNRESOLVED"],
      path: "none",
      modelCalls: 0,
      prompt: null,
      modelSaw: [],
      // Failing closed leaves the turn as repairable as it arrived: the recorded
      // ids are the admission signal a retry needs.
      results: [],
      callIds: [FIRST, SECOND],
      parkedIds: [],
    },
  },
  {
    name: "a delta-only payload is admitted by the recorded id alone",
    dims: "admitted, non-void, delta-only",
    answers: { [FIRST]: { text: "color applied" } },
    deltaOnly: true,
    expected: {
      turn1: { errors: [], results: [stub(FIRST)], callIds: [FIRST] },
      errors: [],
      path: "history",
      modelCalls: 1,
      prompt: null,
      modelSaw: [USER, "color applied"],
      results: [answered(FIRST, "color applied")],
      callIds: [],
      parkedIds: [],
    },
  },
];

describe("the continuation decision, over its input space", () => {
  it.each(ROWS.map((row) => [row.name, row] as const))(
    "%s",
    async (_name, row) => {
      expect(await runRow(row), `dimensions: ${row.dims}`).toEqual(
        row.expected,
      );
    },
  );
});

/**
 * A declined repair, said out loud.
 *
 * `Observed` cannot see a log, and both ways a decline can lose the client's
 * answer -- a newer user message taking the prompt, and a resume having no
 * prompt at all -- are otherwise silent.
 */
describe("a declined repair", () => {
  it("names the call no correction landed for", async () => {
    const dir = storageDir();
    const first = bootFor(SLID_PAST_ROW, dir);
    await collect(first.agent, firstRun());
    trimTurnsThrough(dir, FIRST);

    const warn = vi.fn();
    const second = bootFor(SLID_PAST_ROW, dir, true, {
      debug: vi.fn(),
      warn,
      error: vi.fn(),
    });
    await collect(second.agent, continuationFor(SLID_PAST_ROW));

    expect(warn.mock.calls.map((args) => String(args[0]))).toContain(
      "[@ag-ui/aws-strands] Frontend tool result reconciliation corrected " +
        `nothing for native ids ${FIRST}; the client's answer has to reach the ` +
        "model through the continuation prompt instead",
    );
  });
});

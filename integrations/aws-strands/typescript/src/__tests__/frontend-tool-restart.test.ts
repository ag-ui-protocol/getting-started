/**
 * Durable recovery of frontend tool results across a process restart.
 *
 * A frontend tool executes on the client, so server-side the proxy persists a
 * `"Forwarded to client"` placeholder `toolResult` and the run halts. The real
 * answer arrives on the NEXT request, which a restarted process (or a different
 * instance behind a load balancer) has no in-memory memory of. Recovery
 * therefore has to come entirely out of the session store: the placeholder to
 * correct, and the record of which call ids this adapter handed to the client.
 *
 * These tests drive a REAL Strands `Agent`, a REAL `SessionManager` over a real
 * on-disk `FileStorage`, and a scripted model (no provider calls). The restart
 * is a genuine one: turn 2 runs on a brand-new adapter, a brand-new agent and a
 * brand-new session manager that share nothing but the storage directory.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AfterToolsEvent,
  Agent as StrandsAgentCore,
  FileStorage,
  Message as StrandsMessage,
  Model,
  SessionManager,
  ToolUseBlock,
  type ContentBlock,
  type ModelStreamEvent,
  type StopReason,
} from "@strands-agents/sdk";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";

import { FrontendToolIdentityError, StrandsAgent } from "../agent";
import { PROXY_RESULT_PLACEHOLDER } from "../client-proxy-tool";
import type { StrandsAgentConfig } from "../config";
import {
  AG_UI_FRONTEND_CALL_IDS_STATE_KEY,
  activeProxyPlaceholderIds,
} from "../session-reconcile";
import {
  collect,
  durableRecoveryState,
  expectCompletedRun,
  expectDurableRecovery,
  expectNoRunError,
  expectStoreMatchesMemory,
  historyTexts,
  IDLE_CHECKPOINT,
  liveCheckpoint,
  minimalRunInput,
  modelSawShape,
  modelSawTexts,
  modelTurn,
  persistedSnapshot,
  persistedToolResults,
  realStrandsAgent,
  recordingTool,
  snapshotPathOf,
  soleInterruptId,
  threadAgent,
  type CheckpointPicture,
} from "./helpers";
import { expectContractErrors } from "./error-code-table";

const TOOL = "set_color";
const NATIVE_ID = "native-tool-use-1";
const SESSION_ID = "restart-session";
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

function storageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agui-strands-restart-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A fresh adapter + agent + session manager over `dir`, as a restart gives. */
function bootProcess(
  dir: string,
  turns: Parameters<typeof realStrandsAgent>[0],
  extra: {
    /** Real SDK tools to register, for a batch with a backend sibling. */
    tools?: unknown[];
    config?: Omit<StrandsAgentConfig, "sessionManagerProvider">;
  } = {},
) {
  return realStrandsAgent(turns, {
    tools: extra.tools,
    config: {
      ...extra.config,
      sessionManagerProvider: () =>
        new SessionManager({
          sessionId: SESSION_ID,
          storage: { snapshot: new FileStorage(dir) },
        }),
    },
  });
}

/** The `snapshot_latest.json` the session manager wrote, failing when absent. */
function snapshotPath(dir: string): string {
  const path = snapshotPathOf(dir);
  expect(path, `no snapshot was persisted under ${dir}`).toBeDefined();
  return path!;
}

/** The recorded frontend-call ids as the store holds them. */
function persistedCallIds(dir: string): unknown {
  return persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY];
}

/**
 * Drop one recorded frontend-call id from the store, leaving its persisted
 * placeholder alone.
 *
 * NOT what the emission-time size cap does to THIS id: that cap evicts
 * oldest-first, and the id dropped here is the newest recorded, which is the one
 * eviction keeps. A store loses the record another way: a snapshot restored from
 * before the call was recorded, a replica that lost the write, or the cap
 * finally reaching an OLD call only answered after `FRONTEND_CALL_IDS_MAX` later
 * ones. The next process still restores that call's persisted placeholder while
 * nothing left in the store records the call id.
 */
function forgetPersistedCallId(dir: string, toolUseId: string): void {
  const path = snapshotPath(dir);
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  const ids = snapshot.data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY] as
    | string[]
    | undefined;
  expect(ids, "expected the call id to forget to be recorded").toContain(
    toolUseId,
  );
  snapshot.data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY] = ids!.filter(
    (id) => id !== toolUseId,
  );
  writeFileSync(path, JSON.stringify(snapshot));
}

/**
 * Put `toolUseId` back among the store's recorded ids.
 *
 * The adapter drops an id in the same snapshot as the placeholder it corrected,
 * so the two can only disagree through a writer outside it: a snapshot restored
 * from before the prune, or a replica that lost it. A store in that state still
 * offers the call as admissible while its result is already correct, which is
 * the one thing reconciliation's already-correct branch is there to settle.
 */
function rerecordPersistedCallId(dir: string, toolUseId: string): void {
  const path = snapshotPath(dir);
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  const ids = (snapshot.data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY] ??
    []) as string[];
  expect(
    ids,
    "expected the id to have been spent before re-recording it",
  ).not.toContain(toolUseId);
  snapshot.data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY] = [...ids, toolUseId];
  writeFileSync(path, JSON.stringify(snapshot));
}

/** A block this adapter did not write, as a hook would leave it behind. */
const DECORATION = "annotated by a history hook";

/** Every persisted `toolResult` content array, as JSON holds them. */
function persistedResultContents(snapshot: {
  data: {
    messages: Array<{
      content?: Array<{
        toolResult?: {
          toolUseId?: string;
          content?: Array<{ text?: string }>;
        };
      }>;
    }>;
  };
}): Array<{ toolUseId?: string; content: Array<{ text?: string }> }> {
  const found: Array<{
    toolUseId?: string;
    content: Array<{ text?: string }>;
  }> = [];
  for (const message of snapshot.data.messages) {
    for (const block of message.content ?? []) {
      const content = block.toolResult?.content;
      if (!content) continue;
      found.push({ toolUseId: block.toolResult?.toolUseId, content });
    }
  }
  return found;
}

/**
 * Append a block this adapter did not write inside the persisted placeholder's
 * own content, the way a conversation manager or a history-editing hook can.
 * The next process restores it as part of the same `toolResult`.
 *
 * `toolUseId` narrows it to one call of a batch, so a turn can carry a stub the
 * rewrite accepts beside one it refuses.
 */
function decoratePersistedPlaceholder(
  dir: string,
  text: string,
  toolUseId?: string,
): void {
  const path = snapshotPath(dir);
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  let decorated = 0;
  for (const result of persistedResultContents(snapshot)) {
    if (toolUseId && result.toolUseId !== toolUseId) continue;
    if (!result.content.some((c) => c.text === PROXY_RESULT_PLACEHOLDER)) {
      continue;
    }
    result.content.push({ text });
    decorated++;
  }
  expect(decorated, "expected one persisted placeholder to decorate").toBe(1);
  writeFileSync(path, JSON.stringify(snapshot));
}

/**
 * Take that decoration back off, leaving the stub exactly as this adapter wrote
 * it. What a hook can do to a persisted result it can also undo, and a later
 * turn then meets a placeholder the exact rewrite accepts.
 */
function undecoratePersistedPlaceholder(dir: string, text: string): void {
  const path = snapshotPath(dir);
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  let undone = 0;
  for (const result of persistedResultContents(snapshot)) {
    const at = result.content.findIndex((c) => c.text === text);
    if (at < 0) continue;
    result.content.splice(at, 1);
    undone++;
  }
  expect(undone, "expected one decoration to remove").toBe(1);
  writeFileSync(path, JSON.stringify(snapshot));
}

/**
 * How many of the texts the model saw SAY `line`.
 *
 * A prompt joins its lines into one text block, so a substring is what says an
 * answer, and the count is what a prompt restating an answer the history already
 * carries adds to.
 */
function timesSaid(texts: readonly string[], line: string): number {
  return texts.filter((text) => text.includes(line)).length;
}

/**
 * The same decoration, applied to a placeholder an activated checkpoint PARKED.
 *
 * A checkpoint parks its completed tool results outside `agent.messages`, so a
 * hook that edits them reaches a surface the persisted-history decoration above
 * never touches. The resume is what consumes them.
 *
 * Returns the undo, so a test can put the checkpoint back the way this adapter
 * left it and ask whether the refusal in between cost the thread anything.
 */
function decorateParkedPlaceholder(
  agent: StrandsAgent,
  text: string,
): () => void {
  const parked = (
    threadAgent(agent) as unknown as {
      _interruptState?: {
        pendingToolExecution?: {
          completedToolResults?: Record<
            string,
            { toolResult?: { content?: Array<{ text?: string }> } }
          >;
        };
      };
    }
  )?._interruptState?.pendingToolExecution?.completedToolResults;
  const decorated: Array<{ text?: string }[]> = [];
  for (const entry of Object.values(parked ?? {})) {
    const content = entry?.toolResult?.content;
    if (!content?.some((c) => c.text === PROXY_RESULT_PLACEHOLDER)) continue;
    content.push({ text });
    decorated.push(content);
  }
  expect(decorated.length, "expected one parked placeholder to decorate").toBe(
    1,
  );
  return () => {
    for (const content of decorated) {
      const at = content.findIndex((c) => c.text === text);
      expect(at, "expected the decoration to still be there to undo").toBe(
        content.length - 1,
      );
      content.pop();
    }
  };
}

/**
 * A plugin whose hook decorates the parked placeholder DURING the run that
 * parked it.
 *
 * Both decorations above run between runs, so the gate that decides whether to
 * advertise the interrupt has already seen a stub it could still repair. A
 * history-editing hook is not so polite: `AfterToolsEvent` fires inside the very
 * batch whose interrupt parked the results, which is the state that gate reads.
 *
 * `only` narrows it to one call of a batch, so a batch can park one stub the
 * rewrite accepts beside one it refuses.
 */
function decoratesParkedPlaceholderMidRun(only?: string) {
  return {
    name: "parked-placeholder-decorator",
    initAgent(agent: unknown) {
      (
        agent as {
          addHook: (
            event: unknown,
            callback: (event: { agent: unknown }) => void,
          ) => unknown;
        }
      ).addHook(AfterToolsEvent, (event) => {
        const parked = (
          event.agent as {
            _interruptState?: {
              pendingToolExecution?: {
                completedToolResults?: Record<
                  string,
                  { toolResult?: { content?: Array<{ text?: string }> } }
                >;
              };
            };
          }
        )?._interruptState?.pendingToolExecution?.completedToolResults;
        for (const [parkedId, entry] of Object.entries(parked ?? {})) {
          if (only && parkedId !== only) continue;
          const content = entry?.toolResult?.content;
          if (!content?.some((c) => c.text === PROXY_RESULT_PLACEHOLDER)) {
            continue;
          }
          content.push({ text: DECORATION });
        }
      });
    },
  };
}

/**
 * Replace the parked placeholder's own `toolUseId` with a value that is not a
 * string, the way a hook writing back a hand-built result can.
 *
 * The stub's content is left exactly as this adapter wrote it, so what comes
 * back is a parked result no reader here can take apart whose content is still
 * the one the model must not read.
 */
function mangleParkedPlaceholderId(agent: StrandsAgent): void {
  const parked = (
    threadAgent(agent) as unknown as {
      _interruptState?: {
        pendingToolExecution?: {
          completedToolResults?: Record<
            string,
            {
              toolResult?: {
                toolUseId?: unknown;
                content?: Array<{ text?: string }>;
              };
            }
          >;
        };
      };
    }
  )?._interruptState?.pendingToolExecution?.completedToolResults;
  let mangled = 0;
  for (const entry of Object.values(parked ?? {})) {
    const result = entry?.toolResult;
    if (!result?.content?.some((c) => c.text === PROXY_RESULT_PLACEHOLDER)) {
      continue;
    }
    result.toolUseId = 7;
    mangled++;
  }
  expect(mangled, "expected one parked placeholder to mangle").toBe(1);
}

/** Turn 1: the model calls the frontend tool, so the adapter halts. */
const CALLS_FRONTEND_TOOL = [
  modelTurn.toolUse({
    toolUseId: NATIVE_ID,
    name: TOOL,
    input: { color: "red" },
  }),
];

/** Turn 2: the model answers once it can see the real result. */
const ANSWERS = [modelTurn.text("The color is now red.")];

function firstRun(): RunAgentInput {
  return minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "make it red" } as never],
    tools: CLIENT_TOOLS,
  });
}

/**
 * The continuation a client sends after running the tool, in its hardest form:
 * a delta-only payload. Neither the assistant message that carries the tool
 * call nor the tool declarations are present, so nothing in the request says
 * who executed this result. Only the session store can.
 */
function deltaOnlyContinuation(
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return minimalRunInput({
    runId: "run-2",
    messages: [
      {
        id: "t1",
        role: "tool",
        toolCallId: NATIVE_ID,
        content: "color applied",
      } as never,
    ],
    tools: [],
    ...overrides,
  });
}

const toolCallIds = (events: BaseEvent[]): string[] =>
  events
    .filter((e) => e.type === EventType.TOOL_CALL_START)
    .map((e) => (e as unknown as { toolCallId: string }).toolCallId);

describe("frontend tool identity", () => {
  it("reports the identity failure under its own error name", () => {
    // Name-based inspection is how a caller tells this apart from the
    // provider failures that share the RUN_ERROR path.
    expect(new FrontendToolIdentityError("nope").name).toBe(
      "FrontendToolIdentityError",
    );
  });

  it("puts Strands' native toolUseId on the wire", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, CALLS_FRONTEND_TOOL);

    const events = await collect(agent, firstRun());

    expectNoRunError(events);
    expect(toolCallIds(events)).toEqual([NATIVE_ID]);
  });

  it("records the emitted call id in the durable store", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, CALLS_FRONTEND_TOOL);

    await collect(agent, firstRun());

    expect(
      persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY],
    ).toEqual([NATIVE_ID]);
  });

  it("persists the proxy placeholder so a later run can correct it", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, CALLS_FRONTEND_TOOL);

    await collect(agent, firstRun());

    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }],
      },
    ]);
  });

  it("leaves no trailing assistant turn on the halted history", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, CALLS_FRONTEND_TOOL);

    await collect(agent, firstRun());

    // Ending the turn on the tool batch is what gets the pair above persisted,
    // but it also appends an assistant message. Persisting that would replay a
    // trailing assistant turn to the model on the continuation.
    expect(
      persistedSnapshot(dir).data.messages.map(
        (message) => (message as { role: string }).role,
      ),
    ).toEqual(["user", "assistant", "user"]);
  });

  it("refuses a frontend call Strands gave no native id", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, [
      modelTurn.toolUse({ toolUseId: "", name: TOOL, input: {} }),
    ]);

    const events = await collect(agent, firstRun());

    expectContractErrors(events, ["FRONTEND_TOOL_IDENTITY_ERROR"]);
  });

  it("refuses two frontend calls sharing one native id in a turn", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, [
      modelTurn.toolUse(
        { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
        { toolUseId: NATIVE_ID, name: TOOL, input: { color: "blue" } },
      ),
    ]);

    const events = await collect(agent, firstRun());

    expectContractErrors(events, ["FRONTEND_TOOL_IDENTITY_ERROR"]);
  });

  it("refuses two burst-emitted frontend calls sharing one native id", async () => {
    // An `argsStreamer` takes the call off the streaming path and onto the
    // burst emit path, which is the one whose envelope events have to record
    // that they went out for the cross-call uniqueness check to see them.
    const dir = storageDir();
    const { agent } = bootProcess(
      dir,
      [
        modelTurn.toolUse(
          { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
          { toolUseId: NATIVE_ID, name: TOOL, input: { color: "blue" } },
        ),
      ],
      {
        config: {
          toolBehaviors: {
            [TOOL]: {
              argsStreamer: async function* () {
                yield "{}";
              },
            },
          },
        },
      },
    );

    const events = await collect(agent, firstRun());

    expectContractErrors(events, ["FRONTEND_TOOL_IDENTITY_ERROR"]);
  });

  it("refuses a frontend call reusing a native id from prior history", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, [
      modelTurn.toolUse({
        toolUseId: NATIVE_ID,
        name: TOOL,
        input: { color: "red" },
      }),
      modelTurn.toolUse({
        toolUseId: NATIVE_ID,
        name: TOOL,
        input: { color: "blue" },
      }),
    ]);
    await collect(agent, firstRun());

    const events = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [{ id: "u2", role: "user", content: "again" } as never],
        tools: CLIENT_TOOLS,
      }),
    );

    expectContractErrors(events, ["FRONTEND_TOOL_IDENTITY_ERROR"]);
  });
});

/**
 * One model turn calling a frontend tool and a backend tool in parallel.
 *
 * Strands executes both, so the backend answer exists and is persisted; the
 * halt therefore has to wait for the end of the batch rather than fire on the
 * first result to reach the adapter. Latching earlier drops whichever sibling
 * results follow, and with them their `stateFromResult` / `customResultHandler`
 * hooks, while the model has already been billed for the work.
 */
describe("a frontend call sharing its batch with a backend call", () => {
  const BACKEND_TOOL = "read_temperature";
  const BACKEND_NATIVE_ID = "native-tool-use-backend";

  const MIXED_BATCH = [
    modelTurn.toolUse(
      { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
      { toolUseId: BACKEND_NATIVE_ID, name: BACKEND_TOOL, input: {} },
    ),
  ];

  function bootMixed(dir: string) {
    const backend = recordingTool(BACKEND_TOOL);
    const seenResults: string[] = [];
    const booted = bootProcess(dir, MIXED_BATCH, {
      tools: [backend.tool],
      config: {
        toolBehaviors: {
          [BACKEND_TOOL]: {
            stateFromResult: ({ resultData }) => {
              seenResults.push(JSON.stringify(resultData));
              return null;
            },
          },
        },
      },
    });
    return { ...booted, backend, seenResults };
  }

  const resultsOf = (events: BaseEvent[]) =>
    events
      .filter((e) => e.type === EventType.TOOL_CALL_RESULT)
      .map((e) => {
        const { toolCallId, content } = e as unknown as {
          toolCallId: string;
          content: string;
        };
        return { toolCallId, content };
      });

  it("delivers the backend sibling's result and still halts", async () => {
    const dir = storageDir();
    const { agent, model, backend, seenResults } = bootMixed(dir);

    const events = await collect(agent, firstRun());

    expectNoRunError(events);
    expect(backend.calls).toHaveLength(1);
    expect(resultsOf(events)).toEqual([
      {
        toolCallId: BACKEND_NATIVE_ID,
        content: JSON.stringify({ ran: BACKEND_TOOL }),
      },
    ]);
    // The result hooks are the other half of what an early latch skipped.
    expect(seenResults).toEqual([JSON.stringify({ ran: BACKEND_TOOL })]);
    // Halting means no second model cycle: the client owes a result first.
    expect(model.calls).toBe(1);
  });

  it("still persists the frontend placeholder for a later run to correct", async () => {
    const dir = storageDir();
    const { agent } = bootMixed(dir);

    await collect(agent, firstRun());

    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }],
      },
      {
        toolUseId: BACKEND_NATIVE_ID,
        status: "success",
        content: [{ json: { ran: BACKEND_TOOL } }],
      },
    ]);
  });
});

describe("a checkpoint parking a proxy placeholder", () => {
  const APPROVE = "approve_it";

  /** Both tools in one batch: the proxy runs, then approval interrupts. */
  const MIXED_BATCH = [
    modelTurn.toolUse(
      { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
      { toolUseId: "native-approve", name: APPROVE, input: {} },
    ),
    ...ANSWERS,
  ];

  /**
   * A process over `dir`. `turns` defaults to the batch that parks the
   * checkpoint; a restarted process passes the turns that follow the resume,
   * because the batch itself comes back from the snapshot rather than from the
   * model.
   */
  function bootWithApproval(
    dir: string,
    turns = MIXED_BATCH,
    plugins?: unknown[],
  ) {
    const approval = recordingTool(APPROVE);
    return {
      approval,
      ...realStrandsAgent(turns, {
        tools: [approval.tool],
        ...(plugins ? { plugins } : {}),
        config: {
          toolBehaviors: { [APPROVE]: { interruptOnCall: true } },
          sessionManagerProvider: () =>
            new SessionManager({
              sessionId: SESSION_ID,
              storage: { snapshot: new FileStorage(dir) },
            }),
        },
      }),
    };
  }

  /** The same batch with no session manager, so there is no store at all. */
  function bootWithoutSessionManager(turns = MIXED_BATCH) {
    const approval = recordingTool(APPROVE);
    return {
      approval,
      ...realStrandsAgent(turns, {
        tools: [approval.tool],
        config: { toolBehaviors: { [APPROVE]: { interruptOnCall: true } } },
      }),
    };
  }

  function firstMixedRun(): RunAgentInput {
    return minimalRunInput({
      messages: [{ id: "u1", role: "user", content: "make it red" } as never],
      tools: CLIENT_TOOLS,
    });
  }

  it("parks the placeholder under the interrupt", async () => {
    const dir = storageDir();
    const { agent } = bootWithApproval(dir);

    const events = await collect(agent, firstMixedRun());

    expectNoRunError(events);
    const parked = activeProxyPlaceholderIds(threadAgent(agent));
    expect([...parked]).toEqual([NATIVE_ID]);
  });

  /**
   * The checkpoint the halted batch leaves behind: the approval still open, the
   * whole batch parked, and the proxy's placeholder among its results.
   */
  const PARKED: CheckpointPicture = {
    activated: true,
    interruptIds: [
      `hook:beforeToolCall:native-approve:ag_ui:tool_call:${APPROVE}`,
    ],
    parkedToolCallIds: [NATIVE_ID, "native-approve"],
    parkedToolResults: [
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }],
      },
    ],
  };

  it("refuses to advertise the checkpoint with no session manager", async () => {
    const { agent } = bootWithoutSessionManager();

    const events = await collect(agent, firstMixedRun());

    expectContractErrors(events, ["INTERRUPT_SESSION_REQUIRED"]);
    // The code alone would not say where the refusal leaves the thread. It has
    // to leave it usable: the checkpoint is abandoned rather than held, because
    // a checkpoint parking a placeholder that can never be corrected is one no
    // resume could ever complete, and holding it would refuse every later turn
    // over an interrupt the client was never told about.
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toEqual([]);
    // The live checkpoint is the whole claim. There is no session manager here,
    // so a "nothing was persisted" half would hold against any directory at
    // all and could not fail for any reason this test is about.
    expect(liveCheckpoint(agent), "after refusing the checkpoint").toEqual(
      IDLE_CHECKPOINT,
    );
    // So the next turn gets in.
    const next = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        messages: [{ id: "u2", role: "user", content: "again" } as never],
      }),
    );
    expectContractErrors(next, []);
  });

  it("refuses to advertise a checkpoint parking a stub no rewrite can correct", async () => {
    const dir = storageDir();
    const { agent } = bootWithApproval(dir, MIXED_BATCH, [
      decoratesParkedPlaceholderMidRun(),
    ]);

    const events = await collect(agent, firstMixedRun());

    // The resume gate refuses this checkpoint however the client answers,
    // cancelled entries included. Advertising it would therefore ask the human
    // to approve a resume that cannot happen, and the refusal keeps the
    // checkpoint activated, so every later plain run meets it too: a thread no
    // client action can leave.
    expectContractErrors(events, ["INTERRUPT_RECONCILIATION_ERROR"]);
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toEqual([]);
    // Abandoned rather than held, on the same reasoning as the refusals above:
    // a checkpoint no client was told about and no resume could finish is one
    // holding costs the thread everything and buys nothing.
    expect(
      liveCheckpoint(agent),
      "after refusing to advertise the unrepairable checkpoint",
    ).toEqual(IDLE_CHECKPOINT);
    // So the next turn gets in.
    const next = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        messages: [{ id: "u2", role: "user", content: "again" } as never],
      }),
    );
    expectContractErrors(next, []);
  });

  it("refuses to advertise a batch only some of whose stubs can be corrected", async () => {
    const dir = storageDir();
    const SECOND_NATIVE_ID = "native-tool-use-2";
    const { agent } = bootWithApproval(
      dir,
      [
        modelTurn.toolUse(
          { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
          { toolUseId: SECOND_NATIVE_ID, name: TOOL, input: { color: "blue" } },
          { toolUseId: "native-approve", name: APPROVE, input: {} },
        ),
        ...ANSWERS,
      ],
      [decoratesParkedPlaceholderMidRun(SECOND_NATIVE_ID)],
    );

    const events = await collect(agent, firstMixedRun());

    // An exact sibling does not make the batch resumable: a resume consumes the
    // parked batch entire, and the resume gate refuses on the unrepairable one
    // without asking what the rest of the batch looks like.
    expectContractErrors(events, ["INTERRUPT_RECONCILIATION_ERROR"]);
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toEqual([]);
    expect(
      liveCheckpoint(agent),
      "after refusing to advertise the partly-repairable checkpoint",
    ).toEqual(IDLE_CHECKPOINT);
    const next = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        messages: [{ id: "u2", role: "user", content: "again" } as never],
      }),
    );
    expectContractErrors(next, []);
  });

  it("refuses to resume until the client's result is mapped", async () => {
    const dir = storageDir();
    const { agent } = bootWithApproval(dir);
    const events = await collect(agent, firstMixedRun());
    const interruptId = soleInterruptId(events);

    // Resuming the approval WITHOUT the frontend result would let Strands
    // consume the checkpoint, replaying the placeholder as the tool's answer.
    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ],
      } as Partial<RunAgentInput>),
    );

    expectContractErrors(resumed, ["INTERRUPT_RECONCILIATION_ERROR"]);
    // Refusing before any write is what keeps the retry below possible: the
    // checkpoint, its placeholder and the recorded call id all stand.
    expectDurableRecovery(
      dir,
      agent,
      {
        store: {
          messages: [{ role: "user", blocks: ["text:make it red"] }],
          toolResults: [],
          frontendCallIds: [NATIVE_ID],
          checkpoint: PARKED,
        },
        live: PARKED,
      },
      "after refusing the unmapped resume",
    );
  });

  it("leaves the refused resume retryable", async () => {
    const dir = storageDir();
    const { agent, approval } = bootWithApproval(dir);
    const events = await collect(agent, firstMixedRun());
    const interruptId = soleInterruptId(events);
    const resume = [{ interruptId, status: "cancelled" }];

    const refused = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        resume,
      } as Partial<RunAgentInput>),
    );
    expectContractErrors(refused, ["INTERRUPT_RECONCILIATION_ERROR"]);

    // The same resume, now carrying the result it was missing. Refusing must
    // not have spent the checkpoint: the parked batch is what Strands replays,
    // and replaying it is what names the cancelled call to the client.
    const retried = await collect(
      agent,
      minimalRunInput({
        runId: "run-3",
        tools: CLIENT_TOOLS,
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
        ],
        resume,
      } as Partial<RunAgentInput>),
    );

    expectNoRunError(retried);
    // The cancelled call is named, exactly once. Which wording says so is the
    // cancellation path's own, and pinning it here would couple this test to a
    // phrasing it is not about; what the thread cannot survive is the client
    // being told nothing, or one tool card handed two answers.
    expect(
      retried
        .filter((e) => e.type === EventType.TOOL_CALL_RESULT)
        .map((e) => (e as unknown as { toolCallId: string }).toolCallId)
        .filter((toolCallId) => toolCallId === "native-approve"),
    ).toEqual(["native-approve"]);
    expect(approval.calls).toHaveLength(0);
  });

  it("leaves every parked placeholder alone when only some are answered", async () => {
    const dir = storageDir();
    const SECOND_NATIVE_ID = "native-tool-use-2";
    const approval = recordingTool(APPROVE);
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse(
          { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
          { toolUseId: SECOND_NATIVE_ID, name: TOOL, input: { color: "blue" } },
          { toolUseId: "native-approve", name: APPROVE, input: {} },
        ),
        ...ANSWERS,
      ],
      {
        tools: [approval.tool],
        config: {
          toolBehaviors: { [APPROVE]: { interruptOnCall: true } },
          sessionManagerProvider: () =>
            new SessionManager({
              sessionId: SESSION_ID,
              storage: { snapshot: new FileStorage(dir) },
            }),
        },
      },
    );
    const events = await collect(agent, firstMixedRun());
    const interruptId = soleInterruptId(events);

    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
        ],
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ],
      } as Partial<RunAgentInput>),
    );

    expectContractErrors(resumed, ["INTERRUPT_RECONCILIATION_ERROR"]);
    // Refusing has to happen BEFORE anything is rewritten. Correcting the
    // answered half and then failing would leave the checkpoint half-repaired
    // with no run able to finish it.
    expect([...activeProxyPlaceholderIds(threadAgent(agent))].sort()).toEqual([
      NATIVE_ID,
      SECOND_NATIVE_ID,
    ]);
  });

  it("refuses to resume onto a parked stub carrying other content", async () => {
    const dir = storageDir();
    const { agent, model, approval } = bootWithApproval(dir);
    const events = await collect(agent, firstMixedRun());
    const interruptId = soleInterruptId(events);
    decorateParkedPlaceholder(agent, DECORATION);

    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
        ],
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ],
      } as Partial<RunAgentInput>),
    );

    // Resuming clears the parked context into the history the model reads, and
    // the exact rewrite declines a stub carrying content this adapter did not
    // write. On the message path such a stub falls back to the continuation
    // prompt; a resume has no fallback, so the only way not to feed the stub to
    // the model is to refuse the resume.
    expectContractErrors(resumed, ["INTERRUPT_RECONCILIATION_ERROR"]);
    expect(
      model.seenMessages.flatMap((turn) => historyTexts(turn)),
    ).not.toContain(PROXY_RESULT_PLACEHOLDER);
    expect(approval.calls).toHaveLength(0);
    // Refused before anything is rewritten, and the interrupt is still open,
    // so the block this adapter did not write survives untouched.
    expect(durableRecoveryState(dir, agent).live).toEqual({
      ...PARKED,
      parkedToolResults: [
        {
          toolUseId: NATIVE_ID,
          status: "success",
          content: [{ text: PROXY_RESULT_PLACEHOLDER }, { text: DECORATION }],
        },
      ],
    });
  });

  it("refuses to resume onto a parked stub whose shape it cannot read", async () => {
    const dir = storageDir();
    const { agent, model, approval } = bootWithApproval(dir);
    const events = await collect(agent, firstMixedRun());
    const interruptId = soleInterruptId(events);
    mangleParkedPlaceholderId(agent);

    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
        ],
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ],
      } as Partial<RunAgentInput>),
    );

    // A parked result whose shape no reader here can take apart is reported as
    // uncorrectable, not dropped from both parked sets. Dropped from both it is
    // invisible to every gate at once, and resuming clears the stub into the
    // history the model reads as the tool's own answer.
    expectContractErrors(resumed, ["INTERRUPT_RECONCILIATION_ERROR"]);
    expect(
      model.seenMessages.flatMap((turn) => historyTexts(turn)),
    ).not.toContain(PROXY_RESULT_PLACEHOLDER);
    expect(approval.calls).toHaveLength(0);
    // Refused before anything is rewritten, so the mangled result is still
    // there for a client to retry against once a hook puts it back.
    expect(durableRecoveryState(dir, agent).live).toEqual({
      ...PARKED,
      parkedToolResults: [
        {
          toolUseId: 7 as unknown as string,
          status: "success",
          content: [{ text: PROXY_RESULT_PLACEHOLDER }],
        },
      ],
    });
  });

  it("leaves that refused resume retryable once the stub is a stub again", async () => {
    const dir = storageDir();
    const { agent, approval } = bootWithApproval(dir);
    const events = await collect(agent, firstMixedRun());
    const interruptId = soleInterruptId(events);
    const undecorate = decorateParkedPlaceholder(agent, DECORATION);
    // Cancelled rather than resolved, so the denial has to reach Strands: its
    // approval hook is what sets `cancel`, and the error tool result the SDK
    // then produces for the parked call is what names it to the client.
    const resume = [{ interruptId, status: "cancelled" }];
    const resumeRun = (runId: string): RunAgentInput =>
      minimalRunInput({
        runId,
        tools: CLIENT_TOOLS,
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
        ],
        resume,
      } as Partial<RunAgentInput>);

    const refused = await collect(agent, resumeRun("run-2"));
    expectContractErrors(refused, ["INTERRUPT_RECONCILIATION_ERROR"]);

    // The hook's edit reverted, and the same resume sent again. Refusing must
    // not have spent anything the retry needs: the parked batch and the
    // recorded call id both have to have survived it.
    undecorate();
    const retried = await collect(agent, resumeRun("run-3"));

    expectNoRunError(retried);
    // The cancelled call is named, exactly once. Which wording says so is the
    // cancellation path's own, and pinning it here would couple this test to a
    // phrasing it is not about; what the thread cannot survive is the client
    // being told nothing, or one tool card handed two answers.
    expect(
      retried
        .filter((e) => e.type === EventType.TOOL_CALL_RESULT)
        .map((e) => (e as unknown as { toolCallId: string }).toolCallId)
        .filter((toolCallId) => toolCallId === "native-approve"),
    ).toEqual(["native-approve"]);
    expect(approval.calls).toHaveLength(0);
    // The parked stub was still correctable, so the client's answer replaced it.
    expect(persistedToolResults(dir).map((r) => r.content)).toContainEqual([
      { text: "color applied" },
    ]);
  });

  it("refuses a session manager that cannot write a snapshot", async () => {
    const approval = recordingTool(APPROVE);
    // `sessionManagerProvider` also accepts a plugin-shaped manager, which is
    // how one with no `saveSnapshot` reaches a run at all. Such a manager can
    // hold a corrected history in memory and lose it at the next restart, which
    // is the failure reconciliation exists to prevent.
    const unwritable = { name: "unwritable", initAgent: () => {} };
    const { agent } = realStrandsAgent(MIXED_BATCH, {
      tools: [approval.tool],
      config: {
        toolBehaviors: { [APPROVE]: { interruptOnCall: true } },
        sessionManagerProvider: () => unwritable as unknown as SessionManager,
      },
    });

    const events = await collect(agent, firstMixedRun());

    expectContractErrors(events, ["INTERRUPT_SESSION_CAPABILITY_ERROR"]);
    // Same shape of refusal, same place it leaves the thread: abandoned rather
    // than held, so the thread stays usable.
    expect(events.filter((e) => e.type === EventType.RUN_FINISHED)).toEqual([]);
    expect(
      liveCheckpoint(agent),
      "after refusing an unwritable session manager",
    ).toEqual(IDLE_CHECKPOINT);
  });

  it("resumes once the client's result comes with the answer", async () => {
    const dir = storageDir();
    const { agent, approval } = bootWithApproval(dir);
    const events = await collect(agent, firstMixedRun());
    const interruptId = soleInterruptId(events);

    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
        ],
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ],
      } as Partial<RunAgentInput>),
    );

    expectNoRunError(resumed);
    expect(approval.calls).toHaveLength(1);
    expect(persistedToolResults(dir).map((r) => r.content)).toContainEqual([
      { text: "color applied" },
    ]);
  });

  /**
   * The same checkpoint, resumed by a process that never saw it raised.
   *
   * Everything above runs in one process, where the live agent still holds the
   * checkpoint in memory. Cross-process resume has only the snapshot: the
   * parked batch, its completed results and the recorded call id all have to
   * come back off disk, and the restored checkpoint is what the resume gates
   * then read. A restart is therefore the only way to tell a resume that works
   * apart from one that works because nothing was ever reloaded.
   */
  describe("resumed on a restarted process", () => {
    const RESUME_RESULT = [
      {
        id: "t1",
        role: "tool",
        toolCallId: NATIVE_ID,
        content: "color applied",
      } as never,
    ];

    /** Park the checkpoint in one process and hand back a fresh one over `dir`. */
    async function parkThenRestart() {
      const dir = storageDir();
      const first = bootWithApproval(dir);
      const parked = await collect(first.agent, firstMixedRun());
      const interruptId = soleInterruptId(parked);
      // Nothing of the batch is in the persisted messages yet: it lives in the
      // checkpoint, which is what the restarted process has to restore.
      expectDurableRecovery(
        dir,
        first.agent,
        {
          store: {
            messages: [{ role: "user", blocks: ["text:make it red"] }],
            toolResults: [],
            frontendCallIds: [NATIVE_ID],
            checkpoint: PARKED,
          },
          live: PARKED,
        },
        "before the restart",
      );
      return { dir, interruptId, second: bootWithApproval(dir, ANSWERS) };
    }

    it("runs the parked tool and corrects the parked placeholder", async () => {
      const { dir, interruptId, second } = await parkThenRestart();

      const resumed = await collect(
        second.agent,
        minimalRunInput({
          runId: "run-2",
          tools: CLIENT_TOOLS,
          messages: RESUME_RESULT,
          resume: [
            { interruptId, status: "resolved", payload: { approved: true } },
          ],
        } as Partial<RunAgentInput>),
      );

      expectNoRunError(resumed);
      // The tool ran in THIS process, so the parked execution genuinely came
      // back rather than being replayed from memory.
      expect(second.approval.calls).toHaveLength(1);
      expectDurableRecovery(
        dir,
        second.agent,
        {
          store: {
            messages: [
              { role: "user", blocks: ["text:make it red"] },
              {
                role: "assistant",
                blocks: [
                  `toolUse:${TOOL}#${NATIVE_ID}`,
                  `toolUse:${APPROVE}#native-approve`,
                ],
              },
              {
                role: "user",
                blocks: [
                  `toolResult:#${NATIVE_ID}`,
                  "toolResult:#native-approve",
                ],
              },
              { role: "assistant", blocks: ["text:The color is now red."] },
            ],
            toolResults: [
              {
                toolUseId: NATIVE_ID,
                status: "success",
                content: [{ text: "color applied" }],
              },
              {
                toolUseId: "native-approve",
                status: "success",
                content: [{ json: { ran: APPROVE } }],
              },
            ],
            frontendCallIds: [],
            checkpoint: IDLE_CHECKPOINT,
          },
          live: IDLE_CHECKPOINT,
        },
        "after the restarted resume",
      );
    });

    it("leaves the restored checkpoint untouched when the result is missing", async () => {
      const { dir, interruptId, second } = await parkThenRestart();

      const refused = await collect(
        second.agent,
        minimalRunInput({
          runId: "run-2",
          tools: CLIENT_TOOLS,
          resume: [
            { interruptId, status: "resolved", payload: { approved: true } },
          ],
        } as Partial<RunAgentInput>),
      );

      expectContractErrors(refused, ["INTERRUPT_RECONCILIATION_ERROR"]);
      expect(second.approval.calls).toHaveLength(0);
      // Refusing a restored checkpoint has to leave it exactly as restored:
      // consuming any part of it here would strand the thread in a process
      // that has no memory of what it held.
      expectDurableRecovery(
        dir,
        second.agent,
        {
          store: {
            messages: [{ role: "user", blocks: ["text:make it red"] }],
            toolResults: [],
            frontendCallIds: [NATIVE_ID],
            checkpoint: PARKED,
          },
          live: PARKED,
        },
        "after the refused restarted resume",
      );
    });
  });
});

describe("frontend tool result with history replay turned off", () => {
  it("still corrects the placeholder the adapter itself persisted", async () => {
    const dir = storageDir();
    const config = {
      replayHistoryIntoStrands: false,
      sessionManagerProvider: () =>
        new SessionManager({
          sessionId: SESSION_ID,
          storage: { snapshot: new FileStorage(dir) },
        }),
    };
    const first = realStrandsAgent(CALLS_FRONTEND_TOOL, { config });
    await collect(first.agent, firstRun());

    // The flag governs the no-session-manager history replay. Here a session
    // manager owns history, and the placeholder is this adapter's own write:
    // leaving it means every later turn reads "Forwarded to client" as what the
    // client answered, and no caller can correct it in the adapter's place.
    const second = realStrandsAgent(ANSWERS, { config });
    const events = await collect(second.agent, deltaOnlyContinuation());

    expectNoRunError(events);
    expect(persistedToolResults(dir).map((r) => r.content)).toEqual([
      [{ text: "color applied" }],
    ]);
    // The recorded call id is still what admits the result as the client's: on
    // this payload nothing else says so, and an unadmitted result reconciles
    // nothing.
    expect(modelSawTexts(second.model, 0)).toContain("color applied");
    expect(modelSawTexts(second.model, 0)).not.toContain(
      PROXY_RESULT_PLACEHOLDER,
    );
    expectStoreMatchesMemory(dir, second.agent, "after the corrected turn");
  });
});

describe("frontend tool result with a session manager, same process", () => {
  it("reconciles without replaying the client's history", async () => {
    const dir = storageDir();
    const { agent, model } = bootProcess(dir, [
      ...CALLS_FRONTEND_TOOL,
      ...ANSWERS,
    ]);
    await collect(agent, firstRun());

    // The full payload a client normally sends: the assistant tool call and the
    // tool declarations are both present, so the result is nameable from the
    // request alone and only the placeholder correction is in question.
    const events = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [
          { id: "u1", role: "user", content: "make it red" } as never,
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: NATIVE_ID,
                type: "function",
                function: { name: TOOL, arguments: '{"color":"red"}' },
              },
            ],
          } as never,
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
        ],
        tools: CLIENT_TOOLS,
      }),
    );

    expectNoRunError(events);
    expect(toolCallIds(events)).toEqual([]);
    expect(modelSawShape(model, 1)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["toolUseBlock"] },
      { role: "user", blocks: ["toolResultBlock"] },
    ]);
    expect(modelSawTexts(model, 1)).toContain("color applied");
    expectStoreMatchesMemory(dir, agent, "after the same-process reconcile");
  });

  it("keeps a newer user message as this run's prompt", async () => {
    const dir = storageDir();
    const { agent, model } = bootProcess(dir, [
      ...CALLS_FRONTEND_TOOL,
      ...ANSWERS,
    ]);
    await collect(agent, firstRun());

    await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
          { id: "u2", role: "user", content: "now make it blue" } as never,
        ],
        tools: CLIENT_TOOLS,
      }),
    );

    // The placeholder is still corrected, but the newer user turn is the prompt.
    expect(persistedToolResults(dir).map((r) => r.content)).toEqual([
      [{ text: "color applied" }],
    ]);
    expect(modelSawTexts(model, 1)).toContain("now make it blue");
  });
});

describe("frontend tool result recovery across a restart", () => {
  it("feeds the real result to the model instead of the placeholder", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    // Restart: nothing below shares state with the run above.
    const second = bootProcess(dir, ANSWERS);
    const events = await collect(second.agent, deltaOnlyContinuation());

    expectNoRunError(events);
    const seen = modelSawTexts(second.model, 0);
    expect(seen).toContain("color applied");
    expect(seen).not.toContain(PROXY_RESULT_PLACEHOLDER);
  });

  it("continues from the corrected history, not a synthetic retelling", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    await collect(second.agent, deltaOnlyContinuation());

    // The real result reaches the model as the toolResult it belongs to. A
    // fourth, synthetic user message restating it would mean reconciliation
    // fell through to the legacy prompt path.
    expect(modelSawShape(second.model, 0)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["toolUseBlock"] },
      { role: "user", blocks: ["toolResultBlock"] },
    ]);
    expect(modelSawTexts(second.model, 0)).not.toContain(
      `${TOOL} returned: color applied`,
    );
  });

  it("does not re-fire the frontend tool on the continuation", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    const events = await collect(second.agent, deltaOnlyContinuation());

    expect(toolCallIds(events)).toEqual([]);
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(
      true,
    );
  });

  it("never prompts the restarted model with the placeholder greeting", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    const events = await collect(second.agent, deltaOnlyContinuation());

    // The negative below says nothing unless the restarted model was reached,
    // which a run that failed before its first turn would not do.
    expectCompletedRun(events);
    expect(second.model.calls).toBe(1);
    expect(modelSawTexts(second.model, 0)).not.toContain("Hello");
  });

  it("writes the corrected result back to the store", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    await collect(second.agent, deltaOnlyContinuation());

    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: "color applied" }],
      },
    ]);
    expectStoreMatchesMemory(
      dir,
      second.agent,
      "after the restarted correction",
    );
  });

  it("drops the call id once its placeholder is corrected", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    await collect(second.agent, deltaOnlyContinuation());

    expect(
      persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY],
    ).toEqual([]);
    expectStoreMatchesMemory(dir, second.agent, "after the id was spent");
  });

  it("stamps a client-reported failure as an error result", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    await collect(
      second.agent,
      deltaOnlyContinuation({
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "",
            error: "user cancelled",
          } as never,
        ],
      }),
    );

    expect(persistedToolResults(dir).map((r) => r.status)).toEqual(["error"]);
  });

  it("persists a JSON client result as a json block", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    const events = await collect(
      second.agent,
      deltaOnlyContinuation({
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: '{"applied":true,"color":"red"}',
          } as never,
        ],
      }),
    );

    // A structured client answer reaches the model as structured data, exactly
    // as it does on the replay path. Forwarded as opaque text, the model tends
    // to fall back on the tool call's own arguments instead.
    expectNoRunError(events);
    expect(persistedToolResults(dir).map((r) => r.content)).toEqual([
      [{ json: { applied: true, color: "red" } }],
    ]);
  });

  it("persists the client's failure reason, not an empty error", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    await collect(
      second.agent,
      deltaOnlyContinuation({
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "",
            error: "user cancelled",
          } as never,
        ],
      }),
    );

    expect(persistedToolResults(dir).map((r) => r.content)).toEqual([
      [{ text: "Failed: user cancelled" }],
    ]);
  });

  it("acknowledges a void result reconciled alongside a non-void one", async () => {
    const dir = storageDir();
    const VOID_ID = "native-tool-use-void";
    const first = bootProcess(dir, [
      modelTurn.toolUse(
        { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
        { toolUseId: VOID_ID, name: TOOL, input: { color: "blue" } },
      ),
    ]);
    await collect(first.agent, firstRun());

    // A render-only frontend tool answers with nothing. Persisting that as an
    // empty tool-result block is what OpenAI rejects with HTTP 400.
    const second = bootProcess(dir, ANSWERS);
    const events = await collect(
      second.agent,
      deltaOnlyContinuation({
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
          {
            id: "t2",
            role: "tool",
            toolCallId: VOID_ID,
            content: "",
          } as never,
        ],
      }),
    );

    expectNoRunError(events);
    const persisted = persistedToolResults(dir);
    expect(persisted.map((r) => r.toolUseId)).toEqual([NATIVE_ID, VOID_ID]);
    expect(persisted[1]!.content).toHaveLength(1);
    expect((persisted[1]!.content[0]!.text ?? "").trim()).not.toBe("");
  });

  /**
   * Turn 1 halts, turn 2 corrects the placeholder, and turn 3 is the retry
   * under test. The retry DECLARES the tool, as a client that just ran it does:
   * turn 2 spent the recorded call id, so the declaration is the only
   * provenance signal left. Without it the result is filtered out before
   * reconciliation is reached and the model is prompted with the bare greeting,
   * which says nothing at all about what a retry does to the store.
   */
  async function retryAfterCorrection(
    third: Partial<RunAgentInput>,
    mutateStore?: (dir: string) => void,
  ) {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    await collect(second.agent, deltaOnlyContinuation());
    mutateStore?.(dir);

    const boot = bootProcess(dir, ANSWERS);
    const events = await collect(
      boot.agent,
      deltaOnlyContinuation({ runId: "run-3", tools: CLIENT_TOOLS, ...third }),
    );
    return { dir, events, ...boot };
  }

  /** The corrected turn 1, as every retry below leaves it. */
  const CORRECTED_TURN = [
    { role: "user", blocks: ["text:make it red"] },
    { role: "assistant", blocks: [`toolUse:${TOOL}#${NATIVE_ID}`] },
    { role: "user", blocks: [`toolResult:#${NATIVE_ID}`] },
    { role: "assistant", blocks: ["text:The color is now red."] },
  ];

  /** The one persisted result, still carrying the client's first answer. */
  const FIRST_ANSWER = [
    {
      toolUseId: NATIVE_ID,
      status: "success",
      content: [{ text: "color applied" }],
    },
  ];

  it("is idempotent when the client retries the same result", async () => {
    const { dir, events, agent, model } = await retryAfterCorrection({});

    expectCompletedRun(events, "third run");
    // The retry was recognised as the client's answer and carried to the model,
    // which is what makes the unchanged store below a statement about
    // reconciliation rather than about a result nothing looked at.
    expect(model.calls).toBe(1);
    expect(modelSawTexts(model, 0)).toContain(
      `${TOOL} returned: color applied`,
    );
    expect(modelSawTexts(model, 0)).not.toContain(PROXY_RESULT_PLACEHOLDER);
    expect(toolCallIds(events)).toEqual([]);
    expectDurableRecovery(
      dir,
      agent,
      {
        store: {
          messages: [
            ...CORRECTED_TURN,
            { role: "user", blocks: [`text:${TOOL} returned: color applied`] },
            { role: "assistant", blocks: ["text:The color is now red."] },
          ],
          toolResults: FIRST_ANSWER,
          // Spent by turn 2 and never re-recorded: the retry needed no id to be
          // handled safely.
          frontendCallIds: [],
          checkpoint: IDLE_CHECKPOINT,
        },
        live: IDLE_CHECKPOINT,
      },
      "after the retry",
    );
  });

  it("keeps the first result when a later run reports a different one", async () => {
    const { dir, events, agent, model } = await retryAfterCorrection({
      messages: [
        {
          id: "t2",
          role: "tool",
          toolCallId: NATIVE_ID,
          content: "a different answer",
        } as never,
      ],
    });

    expectCompletedRun(events, "third run");
    expect(model.calls).toBe(1);
    // The conflicting answer reaches the model as this turn's prompt, so the
    // store keeping the first one below is a decision taken about a result the
    // run actually read.
    expect(modelSawTexts(model, 0)).toContain(
      `${TOOL} returned: a different answer`,
    );
    expectDurableRecovery(
      dir,
      agent,
      {
        store: {
          messages: [
            ...CORRECTED_TURN,
            {
              role: "user",
              blocks: [`text:${TOOL} returned: a different answer`],
            },
            { role: "assistant", blocks: ["text:The color is now red."] },
          ],
          // The first answer stands: a persisted result is not a placeholder,
          // so nothing may overwrite it.
          toolResults: FIRST_ANSWER,
          frontendCallIds: [],
          checkpoint: IDLE_CHECKPOINT,
        },
        live: IDLE_CHECKPOINT,
      },
      "after the conflicting answer",
    );
  });

  it("spends a stale call id on a retry that needs no correction", async () => {
    // The already-correct branch of reconciliation, reachable only while the
    // store's recorded id outlives the correction it belongs to.
    const { dir, events, agent, model } = await retryAfterCorrection(
      {},
      (dir) => rerecordPersistedCallId(dir, NATIVE_ID),
    );

    expectCompletedRun(events, "third run");
    expect(model.calls).toBe(1);
    // Admitted, matched to an already-correct result, and so continued from the
    // corrected history: no prompt restating an answer the history carries.
    expect(modelSawTexts(model, 0)).not.toContain(
      `${TOOL} returned: color applied`,
    );
    expect(modelSawTexts(model, 0)).toContain("color applied");
    expectDurableRecovery(
      dir,
      agent,
      {
        store: {
          messages: [
            ...CORRECTED_TURN,
            { role: "assistant", blocks: ["text:The color is now red."] },
          ],
          toolResults: FIRST_ANSWER,
          // The stale id is gone: left behind it would re-admit this result on
          // every later turn.
          frontendCallIds: [],
          checkpoint: IDLE_CHECKPOINT,
        },
        live: IDLE_CHECKPOINT,
      },
      "after the retry against a stale id",
    );
  });

  /**
   * The store keeps the first answer, but the client's newer one is not thrown
   * away: it reaches the model as a prompt, so the model can act on the change
   * rather than being told nothing happened.
   */
  it("keeps a stale call id when the later answer conflicts", async () => {
    const { dir, events, agent } = await retryAfterCorrection(
      {
        messages: [
          {
            id: "t2",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "a different answer",
          } as never,
        ],
      },
      (dir) => rerecordPersistedCallId(dir, NATIVE_ID),
    );

    expectCompletedRun(events, "third run");
    expectDurableRecovery(
      dir,
      agent,
      {
        store: {
          messages: [
            ...CORRECTED_TURN,
            {
              role: "user",
              blocks: [`text:${TOOL} returned: a different answer`],
            },
            { role: "assistant", blocks: ["text:The color is now red."] },
          ],
          toolResults: FIRST_ANSWER,
          // Nothing was corrected, so nothing is spent. Dropping the id here
          // would retire a call whose placeholder may still be uncorrected.
          frontendCallIds: [NATIVE_ID],
          checkpoint: IDLE_CHECKPOINT,
        },
        live: IDLE_CHECKPOINT,
      },
      "after the conflicting answer against a stale id",
    );
  });

  it("keeps content beside the stub and forwards the result as a prompt", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());
    decoratePersistedPlaceholder(dir, DECORATION);

    const second = bootProcess(dir, ANSWERS);
    const events = await collect(second.agent, deltaOnlyContinuation());

    expectCompletedRun(events);
    // The rewrite is exact, so the block this adapter did not write survives.
    expect(persistedToolResults(dir)[0]!.content).toEqual([
      { text: PROXY_RESULT_PLACEHOLDER },
      { text: DECORATION },
    ]);
    // Detection stays permissive, so the gate still sees a stub and the real
    // result reaches the model through the fallback prompt instead.
    expect(modelSawTexts(second.model, 0)).toContain(
      `${TOOL} returned: color applied`,
    );
  });

  it("fails closed when nothing can name the returning tool call", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, ANSWERS);

    const events = await collect(
      agent,
      minimalRunInput({
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: "an-id-nothing-knows",
            content: "orphan",
          } as never,
        ],
        tools: [],
      }),
    );

    expectContractErrors(events, ["CONTINUATION_TOOL_NAME_UNRESOLVED"]);
  });
});

/**
 * A turn whose reconcile corrects one result and declines the other.
 *
 * Admission is settled before the first write, so both answers here are
 * repairable as far as the decision can tell. Only the attempt says otherwise:
 * one stub carries a block this adapter did not write, and the exact rewrite
 * refuses that one alone. The turn then falls back to the continuation prompt,
 * and that prompt phrases EVERY result of the turn -- including the one now
 * sitting corrected in the history. The model would be told that answer twice,
 * once as its own `toolResult` and once in words.
 */
describe("a continuation whose reconcile declines only some results", () => {
  const DECLINED_ID = "native-tool-use-declined";
  const CORRECTED_LINE = `${TOOL} returned: color applied`;
  const DECLINED_LINE = `${TOOL} returned: blue applied`;

  /** Turn 1 emits both frontend calls; turn 2 brings both answers back. */
  async function partialDecline() {
    const dir = storageDir();
    const first = bootProcess(dir, [
      modelTurn.toolUse(
        { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
        { toolUseId: DECLINED_ID, name: TOOL, input: { color: "blue" } },
      ),
    ]);
    await collect(first.agent, firstRun());
    decoratePersistedPlaceholder(dir, DECORATION, DECLINED_ID);

    const second = bootProcess(dir, ANSWERS);
    const events = await collect(
      second.agent,
      deltaOnlyContinuation({
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
          {
            id: "t2",
            role: "tool",
            toolCallId: DECLINED_ID,
            content: "blue applied",
          } as never,
        ],
      }),
    );
    return { dir, events, ...second };
  }

  it("says the declined answer and leaves the corrected one to the history", async () => {
    const { events, model } = await partialDecline();

    expectCompletedRun(events);
    expect(model.calls).toBe(1);
    const seen = modelSawTexts(model, 0);
    // The corrected answer rides its own `toolResult`, so restating it in the
    // prompt is the same answer twice.
    expect(seen).toContain("color applied");
    expect(timesSaid(seen, CORRECTED_LINE)).toBe(0);
    // The declined one has nowhere else to be, and is said exactly once.
    expect(timesSaid(seen, DECLINED_LINE)).toBe(1);
    expect(seen).not.toContain("Hello");
  });

  it("leaves the declined stub, its recorded id and the corrected result as they are", async () => {
    const { dir, agent } = await partialDecline();

    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: "color applied" }],
      },
      {
        toolUseId: DECLINED_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }, { text: DECORATION }],
      },
    ]);
    expectDurableRecovery(
      dir,
      agent,
      {
        store: {
          messages: [
            { role: "user", blocks: ["text:make it red"] },
            {
              role: "assistant",
              blocks: [
                `toolUse:${TOOL}#${NATIVE_ID}`,
                `toolUse:${TOOL}#${DECLINED_ID}`,
              ],
            },
            // The prompt travels inside the trailing `toolResult` turn rather
            // than after it, because two consecutive user turns are a shape no
            // provider accepts. The turn goes out reshaped, so it persists that
            // way too.
            {
              role: "user",
              blocks: [
                `toolResult:#${NATIVE_ID}`,
                `toolResult:#${DECLINED_ID}`,
                `text:${DECLINED_LINE}`,
              ],
            },
            { role: "assistant", blocks: ["text:The color is now red."] },
          ],
          toolResults: [
            {
              toolUseId: NATIVE_ID,
              status: "success",
              content: [{ text: "color applied" }],
            },
            {
              toolUseId: DECLINED_ID,
              status: "success",
              content: [
                { text: PROXY_RESULT_PLACEHOLDER },
                { text: DECORATION },
              ],
            },
          ],
          // The corrected call is spent; the declined one stays recorded so a
          // later turn can still repair it.
          frontendCallIds: [DECLINED_ID],
          checkpoint: IDLE_CHECKPOINT,
        },
        live: IDLE_CHECKPOINT,
      },
      "after the partial decline",
    );
  });

  /**
   * The same decline, on the turn where the corrected answer is the ONLY thing
   * the prompt had to say.
   *
   * The client answered the first call two turns ago, the decline said that
   * answer in words then, and the second call's answer arrives now. So the
   * trailing prompt is one line, that line's correction lands, and what is left
   * to say is nothing at all: the history carries the new answer in its own
   * block and the older one in the words of the earlier prompt. Sending the
   * trailing prompt anyway restates the answer this turn just wrote.
   */
  it("says nothing when the corrected answer was the whole prompt", async () => {
    const LATE_ID = "native-tool-use-late";
    const FIRST_LINE = `${TOOL} returned: color applied`;
    const LATE_LINE = `${TOOL} returned: size applied`;
    const dir = storageDir();
    const first = bootProcess(dir, [
      modelTurn.toolUse(
        { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
        { toolUseId: LATE_ID, name: TOOL, input: { size: "large" } },
      ),
    ]);
    await collect(first.agent, firstRun());
    decoratePersistedPlaceholder(dir, DECORATION, NATIVE_ID);

    // Turn 2: only the first answer is back, and no correction can land, so the
    // prompt is what says it.
    const second = bootProcess(dir, ANSWERS);
    await collect(second.agent, deltaOnlyContinuation());
    expect(timesSaid(modelSawTexts(second.model, 0), FIRST_LINE)).toBe(1);

    // Turn 3: the second answer arrives behind the assistant reply the client
    // now has in its history.
    const third = bootProcess(dir, ANSWERS);
    const events = await collect(
      third.agent,
      minimalRunInput({
        runId: "run-3",
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
          {
            id: "a1",
            role: "assistant",
            content: "The color is now red.",
          } as never,
          {
            id: "t2",
            role: "tool",
            toolCallId: LATE_ID,
            content: "size applied",
          } as never,
        ],
        tools: CLIENT_TOOLS,
      }),
    );

    expectCompletedRun(events, "third run");
    expect(third.model.calls).toBe(1);
    const seen = modelSawTexts(third.model, 0);
    // The new answer reaches the model as the `toolResult` it belongs to, and
    // is never said in words.
    expect(seen).toContain("size applied");
    expect(timesSaid(seen, LATE_LINE)).toBe(0);
    // The older answer keeps the one mention it has always had.
    expect(timesSaid(seen, FIRST_LINE)).toBe(1);
    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }, { text: DECORATION }],
      },
      {
        toolUseId: LATE_ID,
        status: "success",
        content: [{ text: "size applied" }],
      },
    ]);
    expect(
      persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY],
    ).toEqual([NATIVE_ID]);
  });
});

/**
 * A placeholder no correction can EVER repair, over the turns that follow.
 *
 * The stub is decorated, so detection reports it and the exact rewrite refuses
 * it on every turn. Both provenance signals therefore stay alive -- the stub
 * itself, and a recorded call id that only a landed correction retires -- so
 * every later turn reads the client's answer as still outstanding and prepends
 * it to that turn's prompt. Said once it is context; said again on every turn of
 * the thread it is the same stale answer without bound.
 */
describe("a client answer whose placeholder can never be repaired", () => {
  const LINE = `${TOOL} returned: color applied`;

  /** A new user turn that still carries the old answer, as a client does. */
  function laterTurn(runId: string, text: string): RunAgentInput {
    return minimalRunInput({
      runId,
      messages: [
        {
          id: "t1",
          role: "tool",
          toolCallId: NATIVE_ID,
          content: "color applied",
        } as never,
        { id: `u-${runId}`, role: "user", content: text } as never,
      ],
      tools: CLIENT_TOOLS,
    });
  }

  /** Turn 1 halts, turn 2 can only say the answer, and turns 3+ follow. */
  async function turnsAfterTheDecline() {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());
    decoratePersistedPlaceholder(dir, DECORATION);

    const second = bootProcess(dir, ANSWERS);
    const secondEvents = await collect(second.agent, deltaOnlyContinuation());
    return { dir, second, secondEvents };
  }

  it("says the answer once and never says it again", async () => {
    const { dir, second, secondEvents } = await turnsAfterTheDecline();

    expectCompletedRun(secondEvents, "second run");
    expect(second.model.calls).toBe(1);
    // Nothing could be corrected, so the prompt is the only thing that says it.
    expect(timesSaid(modelSawTexts(second.model, 0), LINE)).toBe(1);

    // Two more turns, each on a restarted process, each carrying a new user
    // message with the same old answer still in the client's history.
    const third = bootProcess(dir, ANSWERS);
    const thirdEvents = await collect(
      third.agent,
      laterTurn("run-3", "now make it blue"),
    );
    expectCompletedRun(thirdEvents, "third run");
    expect(third.model.calls).toBe(1);
    // Exactly one: the persisted turn-2 prompt the model already holds. A
    // second is this turn restating it.
    expect(timesSaid(modelSawTexts(third.model, 0), LINE)).toBe(1);
    expect(modelSawTexts(third.model, 0)).toContain("now make it blue");

    const fourth = bootProcess(dir, ANSWERS);
    const fourthEvents = await collect(
      fourth.agent,
      laterTurn("run-4", "and now green"),
    );
    expectCompletedRun(fourthEvents, "fourth run");
    expect(fourth.model.calls).toBe(1);
    // Still one. Growing with the turn count is the unbounded restatement.
    expect(timesSaid(modelSawTexts(fourth.model, 0), LINE)).toBe(1);

    // Nothing was retired from reconciliation: the stub is still there to
    // repair, and the recorded id that admits its answer still is too.
    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }, { text: DECORATION }],
      },
    ]);
    expect(
      persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY],
    ).toEqual([NATIVE_ID]);
  });

  it("still corrects the stub on a later turn once the rewrite accepts it", async () => {
    const { dir } = await turnsAfterTheDecline();

    const third = bootProcess(dir, ANSWERS);
    await collect(third.agent, laterTurn("run-3", "now make it blue"));

    // The hook's block comes off, so the stub is one the exact rewrite may
    // replace again. Retiring the call id when the decline looked permanent is
    // what would strand it here.
    undecoratePersistedPlaceholder(dir, DECORATION);

    const fourth = bootProcess(dir, ANSWERS);
    const events = await collect(
      fourth.agent,
      laterTurn("run-4", "and now green"),
    );

    expectCompletedRun(events, "fourth run");
    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: "color applied" }],
      },
    ]);
    expect(
      persistedSnapshot(dir).data.state[AG_UI_FRONTEND_CALL_IDS_STATE_KEY],
    ).toEqual([]);
    // The correction landed, so this turn says nothing: the one mention is the
    // turn-2 prompt the history already held.
    expect(timesSaid(modelSawTexts(fourth.model, 0), LINE)).toBe(1);
    expectStoreMatchesMemory(dir, fourth.agent, "after the late correction");
  });

  /**
   * The same, for a turn that declined TWO answers at once.
   *
   * A parallel frontend batch is said in one prompt of several lines, so what
   * the history holds is the joined text rather than any one answer's own words.
   * Each line is still an answer already put to the model, and a later turn has
   * to recognise every one of them.
   */
  it("never says either answer of a two-line prompt again", async () => {
    const OTHER_ID = "native-tool-use-other";
    const OTHER_LINE = `${TOOL} returned: size applied`;
    const dir = storageDir();
    const first = bootProcess(dir, [
      modelTurn.toolUse(
        { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
        { toolUseId: OTHER_ID, name: TOOL, input: { size: "large" } },
      ),
    ]);
    await collect(first.agent, firstRun());
    // Neither stub can ever be repaired, so the prompt is all the model gets.
    decoratePersistedPlaceholder(dir, DECORATION, NATIVE_ID);
    decoratePersistedPlaceholder(dir, DECORATION, OTHER_ID);

    const bothAnswers = [
      {
        id: "t1",
        role: "tool",
        toolCallId: NATIVE_ID,
        content: "color applied",
      } as never,
      {
        id: "t2",
        role: "tool",
        toolCallId: OTHER_ID,
        content: "size applied",
      } as never,
    ];

    const second = bootProcess(dir, ANSWERS);
    await collect(
      second.agent,
      deltaOnlyContinuation({ messages: bothAnswers }),
    );
    const saidInTurnTwo = modelSawTexts(second.model, 0);
    expect(timesSaid(saidInTurnTwo, LINE)).toBe(1);
    expect(timesSaid(saidInTurnTwo, OTHER_LINE)).toBe(1);

    const third = bootProcess(dir, ANSWERS);
    const events = await collect(
      third.agent,
      minimalRunInput({
        runId: "run-3",
        messages: [
          ...bothAnswers,
          { id: "u2", role: "user", content: "now make it blue" } as never,
        ],
        tools: CLIENT_TOOLS,
      }),
    );

    expectCompletedRun(events, "third run");
    const seen = modelSawTexts(third.model, 0);
    expect(timesSaid(seen, LINE)).toBe(1);
    expect(timesSaid(seen, OTHER_LINE)).toBe(1);
    expect(seen).toContain("now make it blue");
  });
});

/**
 * A reconciliation whose snapshot write the store refuses.
 *
 * The correction is applied to the live history first and only then offered to
 * the session manager, so a refused write is the one case where memory and the
 * store can disagree about what the client answered. The run logs that it is
 * falling back to the legacy continuation path, and that has to hold for the
 * whole turn: the model must be told the answer by the prompt rather than by a
 * corrected history no restart can see, and the store must be left exactly as
 * repairable as it was found.
 */
describe("a reconcile whose snapshot write the store refuses", () => {
  /**
   * A restarted process whose FIRST snapshot write fails. That write is
   * reconciliation's own, since the run's closing write comes after it, so
   * everything the run does later still reaches the real store.
   */
  function bootWithRefusedFirstSave(
    dir: string,
    turns: Parameters<typeof realStrandsAgent>[0],
  ) {
    const refused: string[] = [];
    const boot = realStrandsAgent(turns, {
      config: {
        sessionManagerProvider: () => {
          const manager = new SessionManager({
            sessionId: SESSION_ID,
            storage: { snapshot: new FileStorage(dir) },
          });
          const save = manager.saveSnapshot.bind(manager) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          (manager as unknown as { saveSnapshot: unknown }).saveSnapshot =
            async (...args: unknown[]) => {
              if (refused.length === 0) {
                refused.push("reconcile");
                throw new Error("snapshot storage unavailable");
              }
              return save(...args);
            };
          return manager;
        },
      },
    });
    return { ...boot, refused };
  }

  /** Turn 1, then a restart whose reconciliation cannot persist anything. */
  async function refusedReconcile() {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_FRONTEND_TOOL);
    await collect(first.agent, firstRun());

    const second = bootWithRefusedFirstSave(dir, ANSWERS);
    const events = await collect(second.agent, deltaOnlyContinuation());

    expectCompletedRun(events, "the run whose reconcile write was refused");
    // The refused write was reconciliation's own, so what each case asserts
    // below is about the fallback and not about a run that never got that far.
    expect(second.refused).toEqual(["reconcile"]);
    return { dir, events, ...second };
  }

  it("tells the model through the prompt, not through unpersisted history", async () => {
    const { model } = await refusedReconcile();

    expect(model.calls).toBe(1);
    // The legacy path in full: the stub still stands in the history the model
    // reads, and the client's answer arrives as the prompt beside it.
    expect(modelSawTexts(model, 0)).toEqual([
      "make it red",
      PROXY_RESULT_PLACEHOLDER,
      `${TOOL} returned: color applied`,
    ]);
  });

  it("leaves the store as repairable as it found it", async () => {
    const { dir, agent } = await refusedReconcile();

    expectDurableRecovery(
      dir,
      agent,
      {
        store: {
          messages: [
            { role: "user", blocks: ["text:make it red"] },
            { role: "assistant", blocks: [`toolUse:${TOOL}#${NATIVE_ID}`] },
            // One user turn, carrying both: the prompt travels inside the
            // trailing `toolResult` turn rather than after it, because two
            // consecutive user turns are a shape no provider accepts.
            {
              role: "user",
              blocks: [
                `toolResult:#${NATIVE_ID}`,
                `text:${TOOL} returned: color applied`,
              ],
            },
            { role: "assistant", blocks: ["text:The color is now red."] },
          ],
          // The stub and its call id both survive, so a later run can still
          // repair the turn. A correction kept in memory alone would have
          // reached the store through the run's own closing write instead, with
          // the id already spent against a repair that never happened.
          toolResults: [
            {
              toolUseId: NATIVE_ID,
              status: "success",
              content: [{ text: PROXY_RESULT_PLACEHOLDER }],
            },
          ],
          frontendCallIds: [NATIVE_ID],
          checkpoint: IDLE_CHECKPOINT,
        },
        live: IDLE_CHECKPOINT,
      },
      "after the refused reconcile write",
    );
    expectStoreMatchesMemory(dir, agent, "after the refused reconcile write");
  });

  it("still corrects the placeholder once the store accepts writes", async () => {
    const { dir } = await refusedReconcile();

    const third = bootProcess(dir, ANSWERS);
    const events = await collect(
      third.agent,
      deltaOnlyContinuation({ runId: "run-3" }),
    );

    expectCompletedRun(events, "third run");
    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: "color applied" }],
      },
    ]);
    expect(persistedCallIds(dir)).toEqual([]);
    expectStoreMatchesMemory(dir, third.agent, "after the repairing run");
  });
});

/**
 * A continuation whose frontend results cannot ALL be admitted.
 *
 * Two client answers come back, but only one of the two calls still has a
 * recorded id, so only that one may be matched to a persisted placeholder. The
 * other answer can only reach the model through the derived continuation
 * prompt, and that prompt restates every result in the turn. Correcting the
 * admitted half as well would tell the model that answer twice, once in its own
 * history block and again in the prompt, and would persist half a repair that
 * the next turn then has to reason about.
 */
describe("a continuation carrying one admitted and one unadmitted result", () => {
  const SECOND_ID = "native-tool-use-2";

  const CALLS_TWO_FRONTEND_TOOLS = [
    modelTurn.toolUse(
      { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
      { toolUseId: SECOND_ID, name: TOOL, input: { color: "blue" } },
    ),
  ];

  /** Both client answers, each non-void and each distinguishable in the prompt. */
  function bothResults(): RunAgentInput {
    return minimalRunInput({
      runId: "run-2",
      messages: [
        {
          id: "t1",
          role: "tool",
          toolCallId: NATIVE_ID,
          content: "color applied",
        } as never,
        {
          id: "t2",
          role: "tool",
          toolCallId: SECOND_ID,
          content: "second applied",
        } as never,
      ],
      // Declared, so the unadmitted result is still recognisable as a frontend
      // one and reaches the prompt. Admission is the only thing it lacks.
      tools: CLIENT_TOOLS,
    });
  }

  /** Turn 1, then the store forgets `SECOND_ID`, then the continuation. */
  async function runPartial() {
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_TWO_FRONTEND_TOOLS);
    await collect(first.agent, firstRun());
    forgetPersistedCallId(dir, SECOND_ID);

    const second = bootProcess(dir, ANSWERS);
    const events = await collect(second.agent, bothResults());
    return { dir, events, model: second.model };
  }

  it("persists nothing at all", async () => {
    const { dir, events } = await runPartial();

    expectCompletedRun(events);
    // Neither placeholder is corrected: repairing one of two is what leaves the
    // store asserting a half-answered turn.
    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }],
      },
      {
        toolUseId: SECOND_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }],
      },
    ]);
    // The admitted id stays recorded, so a later turn can still repair it.
    expect(persistedCallIds(dir)).toEqual([NATIVE_ID]);
  });

  it("reaches the model with the fallback prompt only", async () => {
    const { events, model } = await runPartial();

    expectCompletedRun(events);
    const texts = modelSawTexts(model, 0);
    // Both answers arrive together, in the one place that can carry the
    // unadmitted one.
    expect(texts).toContain(
      `${TOOL} returned: color applied\n${TOOL} returned: second applied`,
    );
    // And neither is also stated as a corrected toolResult beside it.
    expect(texts.filter((text) => text.includes("color applied"))).toHaveLength(
      1,
    );
    expect(
      texts.filter((text) => text.includes("second applied")),
    ).toHaveLength(1);
    // Both stubs are still there, uncorrected: exactly two, not one corrected
    // and one left behind.
    expect(
      texts.filter((text) => text === PROXY_RESULT_PLACEHOLDER),
    ).toHaveLength(2);
  });

  it("still reconciles the same turn once both results are admitted", async () => {
    // The positive control for the gate above: nothing is forgotten, so both
    // results are admitted and the turn continues from corrected history with
    // no prompt restating anything.
    const dir = storageDir();
    const first = bootProcess(dir, CALLS_TWO_FRONTEND_TOOLS);
    await collect(first.agent, firstRun());

    const second = bootProcess(dir, ANSWERS);
    const events = await collect(second.agent, bothResults());

    expectCompletedRun(events);
    expect(persistedToolResults(dir).map((result) => result.content)).toEqual([
      [{ text: "color applied" }],
      [{ text: "second applied" }],
    ]);
    expect(persistedCallIds(dir)).toEqual([]);
    expect(modelSawTexts(second.model, 0)).not.toContain(
      `${TOOL} returned: color applied\n${TOOL} returned: second applied`,
    );
  });
});

/**
 * A resume whose turn carries an unadmittable result beside the checkpoint's.
 *
 * The all-or-nothing gate must not stop a resume from correcting its own parked
 * placeholder: resuming clears the parked context, so a stub left there is
 * consumed as the tool's answer and no later run can repair it. The gate that
 * runs before this one has already proved every parked placeholder has a mapped
 * client result, and the resume path never swaps in the continuation prompt, so
 * there is nothing here to tell the model twice.
 */
describe("a resume beside a result that cannot be admitted", () => {
  const APPROVE = "approve_it";
  const EARLIER_ID = "native-tool-use-earlier";

  it("still corrects the placeholder its checkpoint parked", async () => {
    const dir = storageDir();
    const approval = recordingTool(APPROVE);
    const { agent } = realStrandsAgent(
      [
        // Turn 1: an ordinary frontend call, reconciled and pruned by turn 2.
        modelTurn.toolUse({
          toolUseId: EARLIER_ID,
          name: TOOL,
          input: { color: "blue" },
        }),
        // Turn 2: a frontend call beside an approval, so the checkpoint parks
        // the proxy placeholder.
        modelTurn.toolUse(
          { toolUseId: NATIVE_ID, name: TOOL, input: { color: "red" } },
          { toolUseId: "native-approve", name: APPROVE, input: {} },
        ),
        ...ANSWERS,
      ],
      {
        tools: [approval.tool],
        config: {
          toolBehaviors: { [APPROVE]: { interruptOnCall: true } },
          sessionManagerProvider: () =>
            new SessionManager({
              sessionId: SESSION_ID,
              storage: { snapshot: new FileStorage(dir) },
            }),
        },
      },
    );

    await collect(agent, firstRun());
    const parked = await collect(
      agent,
      minimalRunInput({
        runId: "run-2",
        tools: CLIENT_TOOLS,
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: EARLIER_ID,
            content: "blue applied",
          } as never,
        ],
      }),
    );
    const interruptId = soleInterruptId(parked);
    // Reconciling turn 2 spent the earlier call's id, so a client that repeats
    // that result below can no longer have it admitted.
    expect(persistedCallIds(dir)).toEqual([NATIVE_ID]);

    const resumed = await collect(
      agent,
      minimalRunInput({
        runId: "run-3",
        tools: CLIENT_TOOLS,
        messages: [
          {
            id: "t1",
            role: "tool",
            toolCallId: EARLIER_ID,
            content: "blue applied",
          } as never,
          {
            id: "t2",
            role: "tool",
            toolCallId: NATIVE_ID,
            content: "color applied",
          } as never,
        ],
        resume: [
          { interruptId, status: "resolved", payload: { approved: true } },
        ],
      } as Partial<RunAgentInput>),
    );

    expectNoRunError(resumed);
    expect(approval.calls).toHaveLength(1);
    // The parked stub is gone, replaced by what the client actually returned.
    const persisted = persistedToolResults(dir);
    expect(persisted.map((result) => result.content)).toContainEqual([
      { text: "color applied" },
    ]);
    expect(
      persisted.filter((result) =>
        result.content.some((block) => block.text === PROXY_RESULT_PLACEHOLDER),
      ),
    ).toEqual([]);
  });
});

/**
 * A halt armed by a frontend tool call whose turn Strands ended by THROWING
 * rather than by answering the adapter's `endTurn`.
 *
 * `Model.streamAggregated` raises its bare stream-ended sentinel when a model
 * turn closes with no completed message, and the adapter swallows that inside
 * the halt window so an ordinary halt still finishes. The question these tests
 * settle is what such a turn leaves behind, because the closeout that trims the
 * halt turn and re-saves the snapshot is keyed on the halt having LATCHED and so
 * does not run here.
 *
 * Strands appends both the assistant `toolUse` and its `toolResult` only after
 * the tool batch, and yields them after the `afterToolsEvent` the latch rides,
 * so a throw reaching the swallow landed before either message existed. There
 * is nothing to trim and nothing to persist, and what the run DID record is
 * already in the store: `Agent.stream()` drains `_stream` in its own `finally`
 * on the error path, and the `AfterInvocationEvent` that comes out of the drain
 * saves the snapshot before the throw reaches the adapter. If any of that ever
 * changes, these are the assertions that fail and reopen the question.
 */
describe("a halt armed on a turn Strands ended by throwing", () => {
  /** A turn naming the frontend call and then closing with no message stop. */
  const TRUNCATED_AFTER_FRONTEND_CALL = [
    { type: "modelMessageStartEvent", role: "assistant" },
    {
      type: "modelContentBlockStartEvent",
      start: { type: "toolUseStart", toolUseId: NATIVE_ID, name: TOOL },
    },
    {
      type: "modelContentBlockDeltaEvent",
      delta: {
        type: "toolUseInputDelta",
        input: JSON.stringify({ color: "red" }),
      },
    },
    { type: "modelContentBlockStopEvent" },
  ] as ModelStreamEvent[];

  it("finishes the run and hands the client the call", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, [TRUNCATED_AFTER_FRONTEND_CALL]);

    const events = await collect(agent, firstRun());

    expectCompletedRun(events);
    expect(toolCallIds(events)).toEqual([NATIVE_ID]);
  });

  it("leaves the truncated turn's own messages unpersisted", async () => {
    const dir = storageDir();
    const { agent } = bootProcess(dir, [TRUNCATED_AFTER_FRONTEND_CALL]);

    await collect(agent, firstRun());

    // No assistant `toolUse`, no placeholder `toolResult`, no halt turn: the
    // deferred append never ran, so there was never a pair to trim or save.
    // The emitted call id IS recorded, and the store has it.
    expectDurableRecovery(dir, agent, {
      store: {
        messages: [{ role: "user", blocks: ["text:make it red"] }],
        toolResults: [],
        frontendCallIds: [NATIVE_ID],
        checkpoint: IDLE_CHECKPOINT,
      },
      live: IDLE_CHECKPOINT,
    });
    expectStoreMatchesMemory(dir, agent, "after the truncated halt turn");
  });

  it("still persists an earlier cycle that did complete", async () => {
    const dir = storageDir();
    const backend = recordingTool("read_temperature");
    const { agent } = bootProcess(
      dir,
      [
        modelTurn.toolUse({
          toolUseId: "native-tool-use-backend",
          name: "read_temperature",
          input: {},
        }),
        TRUNCATED_AFTER_FRONTEND_CALL,
      ],
      { tools: [backend.tool] },
    );

    await collect(agent, firstRun());

    // The strongest form of the question: this run HAS state worth saving, and
    // the drain-time save already wrote it. An explicit save would repeat it.
    expect(backend.calls).toHaveLength(1);
    expectDurableRecovery(dir, agent, {
      store: {
        messages: [
          { role: "user", blocks: ["text:make it red"] },
          {
            role: "assistant",
            blocks: ["toolUse:read_temperature#native-tool-use-backend"],
          },
          { role: "user", blocks: ["toolResult:#native-tool-use-backend"] },
        ],
        toolResults: [
          {
            toolUseId: "native-tool-use-backend",
            status: "success",
            content: [{ json: { ran: "read_temperature" } }],
          },
        ],
        frontendCallIds: [NATIVE_ID],
        checkpoint: IDLE_CHECKPOINT,
      },
      live: IDLE_CHECKPOINT,
    });
    expectStoreMatchesMemory(dir, agent, "after the truncated second cycle");
  });

  it("refuses the client's answer instead of inventing a call to attach it to", async () => {
    const dir = storageDir();
    const first = bootProcess(dir, [TRUNCATED_AFTER_FRONTEND_CALL]);
    await collect(first.agent, firstRun());

    // Restart, then the client answers the call it was handed. Nothing in the
    // store names the tool behind it, and the refusal says exactly that rather
    // than letting a result with no call reach the model.
    const second = bootProcess(dir, ANSWERS);
    const events = await collect(second.agent, deltaOnlyContinuation());

    expectContractErrors(events, ["CONTINUATION_TOOL_NAME_UNRESOLVED"]);
    expect(second.model.calls).toBe(0);
  });
});

/**
 * A provider that assembles server-side and emits no deltas at all.
 *
 * `Model.streamAggregated` is a public method, and a non-streaming provider
 * overrides it rather than `stream()`: it yields finished `ContentBlock`s and
 * returns the message. Every one of those reaches the adapter's assembled-block
 * branch as a FIRST sighting, not as the re-delivery that same branch handles
 * for a streaming provider, so it is the one path on which two calls sharing a
 * native id are a genuine reuse rather than one call seen twice.
 */
class AssembledOnlyModel extends Model {
  /** Cursor over `turns`, one step per model invocation. */
  private calls = 0;

  constructor(private readonly turns: ContentBlock[][] = []) {
    super();
  }

  getConfig() {
    return { modelId: "assembled-only" };
  }

  updateConfig() {}

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<ModelStreamEvent> {
    throw new Error("streamAggregated is overridden; stream() is unused");
  }

  async *streamAggregated(): AsyncGenerator<
    ModelStreamEvent | ContentBlock,
    { message: StrandsMessage; stopReason: StopReason },
    undefined
  > {
    const blocks = this.turns[this.calls] ?? [];
    this.calls += 1;
    for (const block of blocks) yield block;
    return {
      message: new StrandsMessage({ role: "assistant", content: blocks }),
      stopReason: (blocks.length > 0 ? "toolUse" : "endTurn") as StopReason,
    };
  }
}

describe("a provider that emits only assembled blocks", () => {
  function bootAssembled(
    dir: string,
    turns: ContentBlock[][],
    extra: {
      tools?: unknown[];
      config?: Omit<StrandsAgentConfig, "sessionManagerProvider">;
    } = {},
  ) {
    const template = new StrandsAgentCore({
      model: new AssembledOnlyModel(turns),
      tools: (extra.tools ?? []) as never,
    });
    const agent = new StrandsAgent({
      agent: template,
      name: "test",
      config: {
        ...extra.config,
        sessionManagerProvider: () =>
          new SessionManager({
            sessionId: SESSION_ID,
            storage: { snapshot: new FileStorage(dir) },
          }),
      },
    });
    return { agent };
  }

  const frontendCall = (color: string, toolUseId = NATIVE_ID) =>
    new ToolUseBlock({ name: TOOL, toolUseId, input: { color } });

  it("delivers a single frontend call and persists its placeholder", async () => {
    const dir = storageDir();
    const { agent } = bootAssembled(dir, [[frontendCall("red")]]);

    const events = await collect(agent, firstRun());

    // The re-delivery reading has to keep working: one sighting, one call.
    expectCompletedRun(events);
    expect(toolCallIds(events)).toEqual([NATIVE_ID]);
    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }],
      },
    ]);
  });

  it("refuses two frontend calls sharing one native id", async () => {
    const dir = storageDir();
    const { agent } = bootAssembled(dir, [
      [frontendCall("red"), frontendCall("blue")],
    ]);

    const events = await collect(agent, firstRun());

    // Without the guard the second call is mistaken for the first one's
    // re-delivery: the client is told about ONE call while the store ends up
    // holding two `toolUse` blocks and two placeholders under the same id, so
    // the client's single answer can never say which one it settles.
    expectContractErrors(events, ["FRONTEND_TOOL_IDENTITY_ERROR"]);
    // Refusing costs the turn: the abort that follows leaves the SDK's own
    // cancel turn and nothing else. No `toolUse`, no placeholder, so no half
    // of a pair for a later run to repair.
    expectDurableRecovery(dir, agent, {
      store: {
        messages: [
          { role: "user", blocks: ["text:make it red"] },
          { role: "assistant", blocks: ["text:Cancelled by user"] },
        ],
        toolResults: [],
        frontendCallIds: [NATIVE_ID],
        checkpoint: IDLE_CHECKPOINT,
      },
      live: IDLE_CHECKPOINT,
    });
  });

  it("keeps a closed call's recorded arguments off a later call's block", async () => {
    const dir = storageDir();
    const BACKEND_TOOL = "read_temperature";
    const backend = recordingTool(BACKEND_TOOL);
    const seenArgs: string[] = [];
    const { agent } = bootAssembled(
      dir,
      [
        [
          new ToolUseBlock({
            name: BACKEND_TOOL,
            toolUseId: NATIVE_ID,
            input: { probe: "first" },
          }),
          new ToolUseBlock({
            name: BACKEND_TOOL,
            toolUseId: NATIVE_ID,
            input: { probe: "second" },
          }),
        ],
      ],
      {
        tools: [backend.tool],
        config: {
          toolBehaviors: {
            [BACKEND_TOOL]: {
              stateFromResult: ({ argsStr }) => {
                seenArgs.push(argsStr);
                return null;
              },
            },
          },
        },
      },
    );

    const events = await collect(agent, firstRun());

    // The identity guard is a frontend-only rule, so a backend pair reaching
    // the same branch is where the recorded arguments can still be overwritten.
    // Both results belong to the call whose envelope went out, and its
    // arguments are the ones its hooks must be handed.
    expectNoRunError(events);
    expect(toolCallIds(events)).toEqual([NATIVE_ID]);
    expect(seenArgs).toEqual([
      JSON.stringify({ probe: "first" }),
      JSON.stringify({ probe: "first" }),
    ]);
  });
});

/**
 * A proxy tool this adapter registered for an EARLIER turn, still in the
 * registry when the client no longer declares it.
 *
 * `agentsByThread` exists so per-thread agents survive adapter
 * re-instantiation, which is the documented shape for a request-scoped wrapper.
 * The proxy names the adapter tracks do NOT survive with them, so the next
 * request's tool sync has nothing telling it to unregister the proxy and a
 * model that calls it gets the proxy's placeholder back. Suppressing that
 * placeholder therefore cannot be keyed on the names the request declared.
 */
describe("a proxy left over from an earlier turn", () => {
  /** Two adapters over one shared agent cache, as request scoping gives. */
  function sharedProcesses(
    dir: string,
    turns: ModelStreamEvent[][],
    extra: { tools?: unknown[] } = {},
  ) {
    const built = realStrandsAgent(turns, { tools: extra.tools });
    const options = {
      agent: built.template,
      name: "test",
      config: {
        sessionManagerProvider: () =>
          new SessionManager({
            sessionId: SESSION_ID,
            storage: { snapshot: new FileStorage(dir) },
          }),
      },
      agentsByThread: new Map<string, StrandsAgentCore>(),
    };
    return {
      model: built.model,
      first: new StrandsAgent(options),
      second: new StrandsAgent(options),
      shared: options.agentsByThread,
    };
  }

  const resultContents = (events: BaseEvent[]) =>
    events
      .filter((e) => e.type === EventType.TOOL_CALL_RESULT)
      .map((e) => (e as unknown as { content: string }).content);

  const CALLS_THE_LEFTOVER = [
    modelTurn.text("noted"),
    modelTurn.toolUse({
      toolUseId: NATIVE_ID,
      name: TOOL,
      input: { color: "red" },
    }),
  ];

  function undeclaredSecondTurn(): RunAgentInput {
    return minimalRunInput({
      runId: "run-2",
      messages: [{ id: "u2", role: "user", content: "again" } as never],
      tools: [],
    });
  }

  it("keeps the placeholder off the wire when the client no longer declares it", async () => {
    const dir = storageDir();
    const { first, second, shared } = sharedProcesses(dir, CALLS_THE_LEFTOVER);

    await collect(first, firstRun());
    // The proxy outlives the adapter that registered it, by design.
    expect(
      shared
        .get("thread-1")!
        .toolRegistry.list()
        .map((t) => t.name),
    ).toEqual([TOOL]);

    const events = await collect(second, undeclaredSecondTurn());

    // The leftover really was called, so the empty wire below is a suppression
    // and not a call that never happened: the call itself was streamed, and the
    // placeholder is in the store, where only the proxy's own body puts it.
    expectNoRunError(events);
    expect(toolCallIds(events)).toEqual([NATIVE_ID]);
    expect(persistedToolResults(dir)).toEqual([
      {
        toolUseId: NATIVE_ID,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }],
      },
    ]);
    // `"Forwarded to client"` stands in for an answer the client is going to
    // produce. Handing it back as that answer is the one thing it must never do.
    expect(resultContents(events)).toEqual([]);
  });

  it("delivers a native tool's result under a client-declared name", async () => {
    const dir = storageDir();
    const native = recordingTool(TOOL);
    const { first } = sharedProcesses(
      dir,
      [
        modelTurn.toolUse({
          toolUseId: NATIVE_ID,
          name: TOOL,
          input: { color: "red" },
        }),
      ],
      { tools: [native.tool] },
    );

    // A native tool shadows the client's declaration, so the tool sync refuses
    // to register the proxy and the NATIVE tool is what runs. Its result is a
    // real answer and belongs on the wire; suppressing it by name dropped it.
    const events = await collect(first, firstRun());

    expect(native.calls).toHaveLength(1);
    expect(resultContents(events)).toEqual([JSON.stringify({ ran: TOOL })]);
  });
});

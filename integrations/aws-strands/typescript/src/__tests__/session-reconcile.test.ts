/**
 * Unit coverage for the reconciliation primitives.
 *
 * Messages are real SDK `Message` / `ToolResultBlock` instances, because the
 * whole point of these functions is to recognise and rewrite the exact shapes
 * Strands persists. The interrupt checkpoint is described structurally: the SDK
 * exports no way to construct one, so the end-to-end behaviour of that surface
 * is pinned by a real mixed-checkpoint run in
 * `frontend-tool-restart.test.ts` instead.
 */

import { describe, expect, it, vi } from "vitest";
import {
  JsonBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@strands-agents/sdk";

import { PROXY_RESULT_PLACEHOLDER } from "../client-proxy-tool";
import {
  AG_UI_FRONTEND_CALL_IDS_STATE_KEY,
  FRONTEND_CALL_IDS_MAX,
  activeProxyPlaceholderIds,
  proxyPlaceholderProvenanceIds,
  recordFrontendCallId,
  recordedFrontendCallIds,
  reconcileFrontendToolResults,
  supportsSnapshotReconciliation,
  uncorrectableProxyPlaceholderIds,
  writeFrontendCallIds,
  type PendingFrontendResult,
} from "../session-reconcile";
import {
  expectStoreMatchesMemory,
  memoryPicture,
  type StorePicture,
} from "./helpers";
import type { Logger } from "../logger";
import type { SessionManager } from "@strands-agents/sdk";

/**
 * A logger that captures instead of printing.
 *
 * A case that drives a refused store write passes one in: the module reports
 * such a write through its logger, and leaving that to the fallback logger both
 * loses the assertion and prints to the suite's output. The cases that are
 * ABOUT the fallback being audible read it through `withCapturedConsole` below
 * instead.
 */
function capturingLogger(): {
  log: Logger;
  warnings: unknown[][];
  errors: unknown[][];
} {
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  return {
    log: {
      debug: () => {},
      warn: (...args: unknown[]) => warnings.push(args),
      error: (...args: unknown[]) => errors.push(args),
    },
    warnings,
    errors,
  };
}

/**
 * Run `body` with the console's warn and error substituted, and return what they
 * were handed.
 *
 * The adapter records and reconciles without passing a logger, so the fallback
 * logger's own output is what a deployment actually sees, and the cases that
 * assert a refusal is audible have to read it there. Substituting the methods
 * captures that whether the fallback resolved them at import time or reaches
 * them per call, so it does not depend on which.
 */
async function withCapturedConsole(
  body: () => unknown,
): Promise<{ warnings: unknown[][]; errors: unknown[][] }> {
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await body();
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
  return { warnings, errors };
}

/**
 * An in-memory stand-in for the SDK's `StateStore` get/set pair. The real store
 * deep copies on both, so copying here too keeps a test from passing on a
 * shared reference production would never hand back.
 */
function appState(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(structuredClone(initial)));
  return {
    get: (key: string) => structuredClone(store.get(key)),
    set: (key: string, value: unknown) => {
      store.set(key, structuredClone(value));
    },
  };
}

function placeholderResult(toolUseId: string): ToolResultBlock {
  return new ToolResultBlock({
    toolUseId,
    status: "success",
    content: [new TextBlock(PROXY_RESULT_PLACEHOLDER)],
  });
}

function resultMessage(...blocks: ToolResultBlock[]): Message {
  return new Message({ role: "user", content: blocks });
}

/**
 * The proxy stub in the SDK's serialized `{ toolResult: ... }` form, which is
 * what `ToolResultBlock.toJSON()` writes and a checkpoint parks.
 */
function wrappedPlaceholder(toolUseId: string) {
  return {
    toolResult: {
      toolUseId,
      status: "success",
      content: [{ text: PROXY_RESULT_PLACEHOLDER }] as unknown[],
    },
  };
}

/** A message whose content blocks were never turned into class instances. */
function dataMessage(...blocks: unknown[]) {
  return { role: "user", content: blocks };
}

function pending(
  entries: Record<string, PendingFrontendResult>,
): Map<string, PendingFrontendResult> {
  return new Map(Object.entries(entries));
}

/** An agent with the surfaces reconciliation reads, and nothing else. */
function agentWith(options: {
  messages?: unknown[];
  state?: Record<string, unknown>;
  parked?: Record<string, unknown>;
  activated?: boolean;
}) {
  const parked = options.parked;
  return {
    messages: options.messages ?? [],
    appState: appState(options.state ?? {}),
    _interruptState:
      parked === undefined
        ? undefined
        : {
            activated: options.activated ?? true,
            pendingToolExecution: { completedToolResults: parked },
          },
  };
}

type StoreBackedManager = SessionManager & {
  saveSnapshot: ReturnType<typeof vi.fn>;
  stored: () => StorePicture;
};

/**
 * A session manager over an in-memory stand-in for the session store.
 *
 * Each successful write captures the agent's memory as the store's new
 * content, and a `rejectWith` write captures nothing, the way a real store
 * keeps nothing from a write that failed. `stored()` is therefore what a
 * restart would find, which is what the agreement check below compares against.
 */
function storeBackedSessionManager(
  agent: unknown,
  options: { rejectWith?: Error; onSave?: () => void } = {},
): StoreBackedManager {
  let stored = memoryPicture(agent);
  const saveSnapshot = vi.fn(async () => {
    options.onSave?.();
    if (options.rejectWith) throw options.rejectWith;
    stored = memoryPicture(agent);
  });
  return {
    saveSnapshot,
    stored: () => stored,
  } as unknown as StoreBackedManager;
}

/** The store picture behind a session manager, or a loud failure. */
function storedPicture(sessionManager: SessionManager): StorePicture {
  const stored = (sessionManager as unknown as { stored?: () => StorePicture })
    .stored;
  if (typeof stored !== "function") {
    throw new Error(
      "reconcile() needs a store-backed session manager so the " +
        "store-versus-memory check has a store to read",
    );
  }
  return stored();
}

/**
 * `reconcileFrontendToolResults`, wrapped so every reconcile-path case below
 * shares one check.
 *
 * Every reconcile-path case goes through here, so all of them also assert that
 * the store and the agent's memory agree once the attempt is over, however it
 * ended. A correction or a prune that only ever existed in memory fails right
 * here, whatever else the case happens to be about.
 */
const reconcile = async (
  sessionManager: SessionManager,
  agent: unknown,
  pendingResults: ReadonlyMap<string, PendingFrontendResult>,
  log?: Logger,
) => {
  try {
    return await reconcileFrontendToolResults(
      sessionManager,
      agent,
      pendingResults,
      log,
    );
  } finally {
    expectStoreMatchesMemory(
      storedPicture(sessionManager),
      agent,
      "store versus memory after reconciliation",
    );
  }
};

const savingSessionManager = (agent: unknown = {}): StoreBackedManager =>
  storeBackedSessionManager(agent);

/**
 * A session manager that records the frontend-call-id store as each snapshot
 * write saw it, which is how a prune applied AFTER the write is told apart from
 * one carried by it.
 */
function snapshotWatchingSessionManager(agent: unknown) {
  const sawCallIds: string[][] = [];
  const manager = storeBackedSessionManager(agent, {
    onSave: () => sawCallIds.push(recordedFrontendCallIds(agent)),
  });
  return { manager, sawCallIds };
}

const toolResultsOf = (message: unknown): ToolResultBlock[] =>
  ((message as Message).content as unknown[]).filter(
    (block) => (block as { type?: string }).type === "toolResultBlock",
  ) as ToolResultBlock[];

describe("recordedFrontendCallIds", () => {
  it("reads back the ids this adapter wrote", () => {
    const agent = agentWith({
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a", "b"] },
    });
    expect(recordedFrontendCallIds(agent)).toEqual(["a", "b"]);
  });

  it.each([
    ["an object left by another writer", { minted: "native-1" }],
    ["a bare string", "native-1"],
    ["a number", 7],
    ["null", null],
  ])("discards %s", (_label, stored) => {
    const agent = agentWith({
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: stored },
    });
    expect(recordedFrontendCallIds(agent)).toEqual([]);
  });

  it("drops entries that are not usable ids", () => {
    const agent = agentWith({
      state: {
        [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a", "", "  ", 3, null, "b"],
      },
    });
    expect(recordedFrontendCallIds(agent)).toEqual(["a", "b"]);
  });

  it("returns nothing when the agent has no app state", () => {
    expect(recordedFrontendCallIds({})).toEqual([]);
  });
});

describe("recordFrontendCallId", () => {
  it("appends in recorded order and does not duplicate", () => {
    const agent = agentWith({});
    recordFrontendCallId(agent, "a");
    recordFrontendCallId(agent, "b");
    recordFrontendCallId(agent, "a");
    expect(recordedFrontendCallIds(agent)).toEqual(["a", "b"]);
  });

  it("evicts oldest first at the size cap", () => {
    const agent = agentWith({});
    for (let i = 0; i < FRONTEND_CALL_IDS_MAX + 2; i++) {
      recordFrontendCallId(agent, `id-${i}`);
    }
    const stored = recordedFrontendCallIds(agent);
    expect(stored).toHaveLength(FRONTEND_CALL_IDS_MAX);
    expect(stored[0]).toBe("id-2");
    expect(stored.at(-1)).toBe(`id-${FRONTEND_CALL_IDS_MAX + 1}`);
  });

  it("survives an agent with no writable app state", () => {
    const { log } = capturingLogger();
    expect(() => recordFrontendCallId({}, "a", log)).not.toThrow();
    expect(() => writeFrontendCallIds({}, ["a"], log)).not.toThrow();
  });

  it.each([
    ["an empty id", ""],
    ["a blank id", "   "],
  ])("refuses to record %s", (_label, toolUseId) => {
    // `recordedFrontendCallIds` discards such an entry on the way back out, so
    // storing one leaves the store holding a record of a call whose client
    // answer nothing can admit, with nothing anywhere saying so.
    const agent = agentWith({
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a"] },
    });

    recordFrontendCallId(agent, toolUseId);

    // Read as the store holds it, not through the filtering reader.
    expect(memoryPicture(agent).frontendCallIds).toEqual(["a"]);
  });

  it("reports a write the app state refused by throwing", () => {
    // A store that throws did not write. Reporting success for a write that
    // did not happen is what lets a correction be saved against ids the store
    // never took, and the throw escaping reaches the reconciler outside the one
    // branch that knows how to undo what is already in memory.
    const agent = {
      appState: {
        get: () => [],
        set: () => {
          throw new Error("state store offline");
        },
      },
    };

    const { log } = capturingLogger();
    expect(writeFrontendCallIds(agent, ["a"], log)).toBe(false);
    expect(() => recordFrontendCallId(agent, "a", log)).not.toThrow();
  });

  it("reports a refused write of a newly recorded call", () => {
    // The recorded id is the ONLY thing that ever admits this call's client
    // answer, so a refused write here loses the answer for the life of the
    // thread: the persisted placeholder can never be corrected afterwards.
    // Reported to the caller and said out loud, with the store's own failure
    // attached, rather than dropped.
    const agent = {
      appState: {
        get: () => ["a"],
        set: () => {
          throw new Error("state store offline");
        },
      },
    };
    const { log, warnings } = capturingLogger();

    expect(recordFrontendCallId(agent, "b", log)).toBe(false);

    expect(
      warnings.some((args) =>
        String(args[0]).includes("can never be admitted"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (args) =>
          (args[1] as Error | undefined)?.message === "state store offline",
      ),
    ).toBe(true);
  });

  it("refuses to record against an app state whose read throws", () => {
    // Recording runs mid-stream on the emission path, where nothing catches a
    // throw. A store whose read throws also leaves the existing ids unknown, so
    // writing this one alone would replace the record rather than extend it:
    // the `set` below is there to fail the case if it is reached at all.
    const agent = {
      appState: {
        get: () => {
          throw new Error("state store offline");
        },
        set: () => {
          throw new Error("nothing should be written");
        },
      },
    };
    const { log, warnings } = capturingLogger();

    expect(recordFrontendCallId(agent, "a", log)).toBe(false);

    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain("can never be admitted");
    expect((warnings[0]![1] as Error).message).toBe("state store offline");
  });

  it("reports a refused write through the fallback logger too", async () => {
    // The adapter records without passing a logger, so a fallback that stays
    // silent leaves the refusal unreported at the one place it is emitted.
    const agent = {
      appState: {
        get: () => [],
        set: () => {
          throw new Error("state store offline");
        },
      },
    };
    let answer: boolean | undefined;

    const { warnings } = await withCapturedConsole(() => {
      answer = recordFrontendCallId(agent, "a");
    });

    expect(answer).toBe(false);
    expect(
      warnings.some(([message]) =>
        String(message).includes("can never be admitted"),
      ),
    ).toBe(true);
  });

  it("reports a write the app state took", () => {
    const agent = agentWith({});
    const { log, warnings } = capturingLogger();

    expect(recordFrontendCallId(agent, "a", log)).toBe(true);

    expect(memoryPicture(agent).frontendCallIds).toEqual(["a"]);
    expect(warnings).toEqual([]);
  });
});

describe("supportsSnapshotReconciliation", () => {
  it("accepts a session manager that can write a snapshot", () => {
    expect(
      supportsSnapshotReconciliation(savingSessionManager(), agentWith({})),
    ).toBe(true);
  });

  it.each([
    ["no session manager", null, agentWith({})],
    ["no saveSnapshot", {}, agentWith({})],
    ["a non-callable saveSnapshot", { saveSnapshot: 1 }, agentWith({})],
    ["an agent with no messages array", savingSessionManager(), {}],
  ])("refuses %s", (_label, sessionManager, agent) => {
    expect(supportsSnapshotReconciliation(sessionManager, agent)).toBe(false);
  });

  it("fails closed when reading the agent throws", () => {
    const agent = {
      get messages(): unknown {
        throw new Error("unreadable");
      },
    };
    expect(supportsSnapshotReconciliation(savingSessionManager(), agent)).toBe(
      false,
    );
  });

  it("says so when it fails closed on a throwing agent", () => {
    // Failing closed is right, but a capability that cannot even be read is a
    // real problem, and the fallback path it selects looks like a normal turn.
    const agent = {
      get messages(): unknown {
        throw new Error("unreadable");
      },
    };
    const warnings: unknown[][] = [];
    const log = {
      debug: () => {},
      warn: (...args: unknown[]) => warnings.push(args),
      error: () => {},
    };

    expect(
      supportsSnapshotReconciliation(savingSessionManager(), agent, log),
    ).toBe(false);

    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain("snapshot reconciliation");
    expect((warnings[0]![1] as Error).message).toBe("unreadable");
  });

  it("refuses an agent whose app state cannot be read", () => {
    // Reading the recorded ids back is the other half of the same capability:
    // membership there is the only thing that tells a client-executed result
    // apart, so a write-only store can never admit one and reconciliation would
    // prune and save against a list it cannot see.
    expect(
      supportsSnapshotReconciliation(savingSessionManager(), {
        messages: [],
        appState: { set: () => {} },
      }),
    ).toBe(false);
  });

  it("refuses an agent whose app state read throws", () => {
    // Type-checking the read function is not the same as being able to read it.
    // A store whose read throws satisfies a probe that only looks at the type,
    // and then throws on the emission path, where nothing is set up to catch it.
    // The write half is already answered by exercising it, so the read is too.
    const agent = {
      messages: [],
      appState: {
        get: () => {
          throw new Error("state store offline");
        },
        set: () => {},
      },
    };
    const { log, warnings } = capturingLogger();

    expect(
      supportsSnapshotReconciliation(savingSessionManager(), agent, log),
    ).toBe(false);

    expect(warnings).toHaveLength(1);
    expect((warnings[0]![1] as Error).message).toBe("state store offline");
  });

  it("refuses an agent whose app state cannot be written", () => {
    // Pruning the recorded call ids is half of every reconciliation. Accepting
    // an agent that cannot record the prune saves the correction while the id
    // stays recorded forever, which is the capability problem this reports.
    expect(
      supportsSnapshotReconciliation(savingSessionManager(), {
        messages: [],
        appState: { get: () => undefined },
      }),
    ).toBe(false);
  });
});

/**
 * The two parked sets are asserted together in every case below.
 *
 * Every gate the adapter runs before a resume reads one set or the other, so a
 * parked placeholder in neither is invisible to all of them and gets consumed
 * on resume as the tool's answer. Asserting only the set a case is "about"
 * cannot tell "reported as uncorrectable" from "reported nowhere".
 */
describe("activeProxyPlaceholderIds and uncorrectableProxyPlaceholderIds", () => {
  const exact = {
    toolResult: {
      toolUseId: "a",
      status: "success",
      content: [{ text: PROXY_RESULT_PLACEHOLDER }],
    },
  };

  /** Both parked sets, as arrays, for one agent. */
  const parkedSets = (agent: unknown) => ({
    correctable: [...activeProxyPlaceholderIds(agent)],
    uncorrectable: [...uncorrectableProxyPlaceholderIds(agent)],
  });

  it("finds an exact parked placeholder", () => {
    const agent = agentWith({ parked: { a: exact } });
    expect(parkedSets(agent)).toEqual({
      correctable: ["a"],
      uncorrectable: [],
    });
  });

  it("returns nothing when the checkpoint is not activated", () => {
    const agent = agentWith({ parked: { a: exact }, activated: false });
    expect(parkedSets(agent)).toEqual({ correctable: [], uncorrectable: [] });
  });

  it("claims a placeholder carrying a field a later SDK version may add", () => {
    // Requiring an exact key set would empty the parked set on any such field,
    // and an empty set silently disables the resume gates that read it. The
    // substantive checks below are what make the claim safe.
    const agent = agentWith({
      parked: {
        a: { toolResult: { ...exact.toolResult, unknownSdkField: 1 } },
      },
    });
    expect(parkedSets(agent)).toEqual({
      correctable: ["a"],
      uncorrectable: [],
    });
  });

  it("claims a placeholder carrying a status the proxy never wrote", () => {
    // These sets exist to predict the rewrite, and the rewrite replaces the
    // status wholesale with the client's own, so an odd status is not out of
    // its reach. Filing it as uncorrectable would refuse a resume over a stub
    // the rewrite would in fact have repaired.
    const agent = agentWith({
      parked: { a: { toolResult: { ...exact.toolResult, status: "error" } } },
    });
    expect(parkedSets(agent)).toEqual({
      correctable: ["a"],
      uncorrectable: [],
    });
  });

  it.each([
    [
      "extra content",
      {
        ...exact.toolResult,
        content: [{ text: PROXY_RESULT_PLACEHOLDER }, { text: "and more" }],
      },
    ],
    [
      "a decorated content block",
      {
        ...exact.toolResult,
        content: [{ text: PROXY_RESULT_PLACEHOLDER, extra: 1 }],
      },
    ],
    ["a blank id", { ...exact.toolResult, toolUseId: "  " }],
    ["an id that is not a string", { ...exact.toolResult, toolUseId: 7 }],
    [
      "content that is not a block array",
      { ...exact.toolResult, content: PROXY_RESULT_PLACEHOLDER },
    ],
  ])("reports a stub with %s as uncorrectable", (_label, toolResult) => {
    // The last two are shapes no reader here can take apart. Dropped from both
    // sets they would be invisible to every gate at once, and the resume would
    // feed whatever they hold to the model. Reported under the id the
    // checkpoint parked them at, which is the only name a result whose own id
    // is unreadable still has.
    const agent = agentWith({ parked: { a: { toolResult } } });
    expect(parkedSets(agent)).toEqual({
      correctable: [],
      uncorrectable: ["a"],
    });
  });

  it("reports a parked entry holding no result at all as uncorrectable", () => {
    const agent = agentWith({ parked: { a: null } });
    expect(parkedSets(agent)).toEqual({
      correctable: [],
      uncorrectable: ["a"],
    });
  });

  it("leaves an unreadable native result out of both sets", () => {
    // Failing closed is about stubs. A parked result whose shape this cannot
    // read, but whose content is readable and holds no stub, is not one:
    // reporting it would refuse every resume of a thread over an ordinary
    // native answer.
    const agent = agentWith({
      parked: {
        a: {
          toolResult: {
            toolUseId: 7,
            status: "success",
            content: [{ text: "native answer" }],
          },
        },
      },
    });
    expect(parkedSets(agent)).toEqual({ correctable: [], uncorrectable: [] });
  });
});

/**
 * The parked sets and the rewrite cannot hold different opinions.
 *
 * The sets exist to be read BEFORE a resume writes anything: one refuses the run
 * outright, the other demands a mapped client result for every id it claims and
 * takes the correction as guaranteed from there. So an id the sets call
 * correctable and the rewrite then refuses fails the run after the gates are
 * behind it, with no path left to carry the client's answer.
 *
 * Each shape below is put to both: the sets, and a real reconcile carrying a
 * client answer under the same id. The answers have to match, for every answer,
 * which is what running the sets THROUGH the rewrite buys.
 */
describe("the parked sets and the rewrite agree", () => {
  const stub = (over: Record<string, unknown> = {}) => ({
    toolUseId: "a",
    status: "success",
    content: [{ text: PROXY_RESULT_PLACEHOLDER }],
    ...over,
  });

  it.each<[string, unknown, PendingFrontendResult]>([
    ["an exact stub", stub(), { text: "real", isError: false }],
    [
      "an exact stub answered with the stub's own text",
      stub(),
      { text: PROXY_RESULT_PLACEHOLDER, isError: false },
    ],
    [
      "an exact stub answered with nothing",
      stub(),
      { text: "", isError: false },
    ],
    [
      "an exact stub answered with a failure",
      stub(),
      { text: "", isError: true, errorReason: "user cancelled" },
    ],
    [
      "a stub carrying a status the proxy never wrote",
      stub({ status: "error" }),
      { text: "real", isError: false },
    ],
    [
      "a stub carrying a field a later SDK version may add",
      stub({ unknownSdkField: 1 }),
      { text: "real", isError: false },
    ],
    [
      "a stub with a sibling block",
      stub({ content: [{ text: PROXY_RESULT_PLACEHOLDER }, { text: "note" }] }),
      { text: "real", isError: false },
    ],
    [
      "a decorated stub block",
      stub({ content: [{ text: PROXY_RESULT_PLACEHOLDER, extra: 1 }] }),
      { text: "real", isError: false },
    ],
    [
      "a stub under a blank id",
      stub({ toolUseId: "  " }),
      { text: "real", isError: false },
    ],
    [
      "a stub under an id that is not a string",
      stub({ toolUseId: 7 }),
      { text: "real", isError: false },
    ],
    [
      "a stub whose content is not a block array",
      stub({ content: PROXY_RESULT_PLACEHOLDER }),
      { text: "real", isError: false },
    ],
  ])("agree about %s", async (_label, toolResult, result) => {
    const scanned = agentWith({ parked: { a: { toolResult } } });
    const claimed = activeProxyPlaceholderIds(scanned).has("a");

    const agent = agentWith({
      parked: { a: { toolResult: structuredClone(toolResult) } },
    });
    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: result }),
    );

    expect(corrected.has("a")).toBe(claimed);
  });
});

/**
 * Provenance says who EXECUTED a result, and it is the signal that admits a
 * client answer once the size cap has evicted the recorded call id. A backend
 * call reported here has its answer filed as client-executed context.
 */
describe("proxyPlaceholderProvenanceIds", () => {
  it("claims only ids a stub was actually seen under", () => {
    // A parked entry no reader can take apart is reported to the resume gates so
    // none of them is blind to it, but nothing about it says a stub is in there:
    // its content was never scanned. Unioning the fail-closed report into
    // provenance is how a native call id gets claimed as client-executed.
    const agent = agentWith({
      parked: {
        "native-1": null,
        "native-2": {
          toolResult: {
            toolUseId: "native-2",
            status: "success",
            content: "not a block array",
          },
        },
        b: wrappedPlaceholder("b"),
      },
    });

    expect([...proxyPlaceholderProvenanceIds(agent)]).toEqual(["b"]);
    // Still reported to the gates that must fail closed on them.
    expect([...uncorrectableProxyPlaceholderIds(agent)].sort()).toEqual([
      "native-1",
      "native-2",
    ]);
  });

  it("claims a parked stub no rewrite can correct, and one in the history", () => {
    // Permissive where a stub is merely REPORTED: only this adapter's proxy
    // writes the stub, so its presence is proof of who executed the call, even
    // where the exact rewrite may not touch it.
    const agent = agentWith({
      messages: [dataMessage(wrappedPlaceholder("historic"))],
      parked: {
        decorated: {
          toolResult: {
            toolUseId: "decorated",
            status: "success",
            content: [{ text: PROXY_RESULT_PLACEHOLDER }, { text: "note" }],
          },
        },
      },
    });

    expect([...proxyPlaceholderProvenanceIds(agent)].sort()).toEqual([
      "decorated",
      "historic",
    ]);
  });
});

/**
 * The failure object, and where it can actually be.
 *
 * The SDK cannot put a failure object on the serialized wrapper, so a rewrite
 * dropping a stale one guards a state nothing reaches while slipping past the
 * exactness check that gates every other rewrite here.
 */
describe("a failure object inside the serialized wrapper", () => {
  it("is a state the SDK does not produce", () => {
    const block = new ToolResultBlock({
      toolUseId: "a",
      status: "error",
      content: [new TextBlock("boom")],
      error: new Error("boom"),
    });

    // Every write into a checkpoint's parked results, and every message a
    // snapshot holds, goes through this serializer.
    expect(block.error).toBeInstanceOf(Error);
    expect(block.toJSON()).toEqual({
      toolResult: {
        toolUseId: "a",
        status: "error",
        content: [{ text: "boom" }],
      },
    });
    // And the restore never puts one back.
    expect(ToolResultBlock.fromJSON(block.toJSON()).error).toBeUndefined();
  });
});

describe("reconcileFrontendToolResults", () => {
  it("overwrites the placeholder and reports the id", async () => {
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({ messages: [message] });
    const sessionManager = savingSessionManager(agent);

    const corrected = await reconcile(
      sessionManager,
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect([...corrected]).toEqual(["a"]);
    expect(toolResultsOf(message)[0]!.content).toEqual([new TextBlock("real")]);
    expect(sessionManager.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it("builds a non-empty result for a void client answer", async () => {
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({ messages: [message] });

    await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "", isError: false } }),
    );

    // An empty tool-result block is rejected by OpenAI (HTTP 400), so the
    // persisted result must carry the same synthesized acknowledgement the
    // replay path builds, and must not read as a failure.
    expect(toolResultsOf(message)[0]!.status).toBe("success");
    const [block] = toolResultsOf(message)[0]!.content as TextBlock[];
    expect(block!.text).toBe(
      "Tool executed successfully with no return value.",
    );
  });

  it("persists a JSON client answer as a json block", async () => {
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({ messages: [message] });

    await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: '{"accepted":true}', isError: false } }),
    );

    expect(toolResultsOf(message)[0]!.content).toEqual([
      new JsonBlock({ json: { accepted: true } }),
    ]);
  });

  it("stamps a client failure as an error result", async () => {
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({ messages: [message] });

    await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "", isError: true } }),
    );

    expect(toolResultsOf(message)[0]!.status).toBe("error");
  });

  it("carries the client's failure reason into the result content", async () => {
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({ messages: [message] });

    await reconcile(
      savingSessionManager(agent),
      agent,
      pending({
        a: { text: "", isError: true, errorReason: "user cancelled" },
      }),
    );

    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock("Failed: user cancelled"),
    ]);
  });

  it("keeps the returned body alongside the failure reason", async () => {
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({ messages: [message] });

    await reconcile(
      savingSessionManager(agent),
      agent,
      pending({
        a: { text: "half done", isError: true, errorReason: "timed out" },
      }),
    );

    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock("Failed: timed out (returned: half done)"),
    ]);
  });

  it("recognises an already-correct result without writing again", async () => {
    const message = resultMessage(
      new ToolResultBlock({
        toolUseId: "a",
        status: "success",
        content: [new TextBlock("real")],
      }),
    );
    const agent = agentWith({ messages: [message] });
    const sessionManager = savingSessionManager(agent);

    const corrected = await reconcile(
      sessionManager,
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect([...corrected]).toEqual(["a"]);
    expect(sessionManager.saveSnapshot).not.toHaveBeenCalled();
  });

  it("recognises an already-correct json result without writing again", async () => {
    const message = resultMessage(
      new ToolResultBlock({
        toolUseId: "a",
        status: "success",
        content: [new JsonBlock({ json: { accepted: true } })],
      }),
    );
    const agent = agentWith({ messages: [message] });
    const sessionManager = savingSessionManager(agent);

    const corrected = await reconcile(
      sessionManager,
      agent,
      pending({ a: { text: '{"accepted":true}', isError: false } }),
    );

    expect([...corrected]).toEqual(["a"]);
    expect(sessionManager.saveSnapshot).not.toHaveBeenCalled();
  });

  it("accepts an answer whose body is the stub's own text", async () => {
    // Refusing this wedged the thread for good. The resume gate demands a mapped
    // client result for every placeholder the parked set claims, and this one is
    // claimed, so the resume got its result and the rewrite then refused it. The
    // run failed with the checkpoint still activated, which leaves a plain run
    // refused for pending interrupts and a resume carrying the same answer
    // refused again, forever.
    //
    // Accepting it costs nothing. The persisted result says exactly what the
    // client answered, and a later reader taking it for an uncorrected stub
    // reaches this same decision against the same answer and reports it handled
    // again.
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({
      messages: [message],
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a"] },
    });
    const sessionManager = savingSessionManager(agent);

    const corrected = await reconcile(
      sessionManager,
      agent,
      pending({ a: { text: PROXY_RESULT_PLACEHOLDER, isError: false } }),
    );

    expect([...corrected]).toEqual(["a"]);
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock(PROXY_RESULT_PLACEHOLDER),
    ]);
    // Retiring the id is a write of its own, so it is saved even though the
    // content needed no change.
    expect(recordedFrontendCallIds(agent)).toEqual([]);
    expect(sessionManager.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it("stamps a failed answer whose body is the stub's own text", async () => {
    // Same body, different status, so the persisted result is not the stub at
    // all: leaving the proxy's hardcoded "success" would report a frontend tool
    // the client says failed as a success.
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({ messages: [message] });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: PROXY_RESULT_PLACEHOLDER, isError: true } }),
    );

    expect([...corrected]).toEqual(["a"]);
    expect(toolResultsOf(message)[0]!.status).toBe("error");
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock(PROXY_RESULT_PLACEHOLDER),
    ]);
  });

  it("does not mistake a different json result for the persisted one", async () => {
    const message = resultMessage(
      new ToolResultBlock({
        toolUseId: "a",
        status: "success",
        content: [new JsonBlock({ json: { accepted: true } })],
      }),
    );
    const agent = agentWith({ messages: [message] });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: '{"accepted":false}', isError: false } }),
    );

    expect([...corrected]).toEqual([]);
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new JsonBlock({ json: { accepted: true } }),
    ]);
  });

  it("leaves a real result alone when a different one is offered", async () => {
    const message = resultMessage(
      new ToolResultBlock({
        toolUseId: "a",
        status: "success",
        content: [new TextBlock("first")],
      }),
    );
    const agent = agentWith({ messages: [message] });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "second", isError: false } }),
    );

    expect([...corrected]).toEqual([]);
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock("first"),
    ]);
  });

  it("corrects each parallel result in one message independently", async () => {
    const message = resultMessage(
      placeholderResult("a"),
      placeholderResult("b"),
    );
    const agent = agentWith({ messages: [message] });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({
        a: { text: "ok", isError: false },
        b: { text: "boom", isError: true },
      }),
    );

    expect([...corrected].sort()).toEqual(["a", "b"]);
    const [first, second] = toolResultsOf(message);
    expect(first!.status).toBe("success");
    expect(second!.status).toBe("error");
  });

  it("ignores an id it was not given a result for", async () => {
    const message = resultMessage(placeholderResult("other"));
    const agent = agentWith({ messages: [message] });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect([...corrected]).toEqual([]);
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock(PROXY_RESULT_PLACEHOLDER),
    ]);
  });

  it("corrects a placeholder parked by an active checkpoint", async () => {
    const parked = {
      a: {
        toolResult: {
          toolUseId: "a",
          status: "success",
          content: [{ text: PROXY_RESULT_PLACEHOLDER }],
        },
      },
    };
    const agent = agentWith({ parked });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "real", isError: true } }),
    );

    expect([...corrected]).toEqual(["a"]);
    expect(parked.a.toolResult).toEqual({
      toolUseId: "a",
      status: "error",
      content: [{ text: "real" }],
    });
  });

  it("corrects a parked stub carrying a status the proxy never wrote", async () => {
    // The rewrite gates on the content alone, because that is what it replaces;
    // the status it overwrites. So a stub with an odd status is repaired here,
    // and the parked sets above have to claim it for the same reason.
    const parked = {
      a: {
        toolResult: {
          toolUseId: "a",
          status: "error",
          content: [{ text: PROXY_RESULT_PLACEHOLDER }],
        },
      },
    };
    const agent = agentWith({ parked });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect([...corrected]).toEqual(["a"]);
    expect(parked.a.toolResult).toEqual({
      toolUseId: "a",
      status: "success",
      content: [{ text: "real" }],
    });
  });

  it("never rewrites a result whose content is not exactly the stub", async () => {
    // The exactness check is this module's only permission to replace a content
    // array, and it gates every rewrite here. A result that already says exactly
    // what the client answered is reported as handled and left untouched, rather
    // than rewritten to the value it already holds: the shape below is the one
    // Strands writes for a tool that threw, carrying the failure object hooks,
    // error handlers and the agent loop read, and a rewrite past the permission
    // is a rewrite over content this adapter did not write.
    const block = new ToolResultBlock({
      toolUseId: "a",
      status: "error",
      content: [new TextBlock("boom")],
      error: new Error("boom"),
    });
    const message = resultMessage(block);
    const agent = agentWith({ messages: [message] });
    const sessionManager = savingSessionManager(agent);

    const corrected = await reconcile(
      sessionManager,
      agent,
      pending({ a: { text: "boom", isError: true } }),
    );

    expect([...corrected]).toEqual(["a"]);
    // The same block, not a fresh one substituted at the same index.
    expect(toolResultsOf(message)[0]).toBe(block);
    expect(sessionManager.saveSnapshot).not.toHaveBeenCalled();
  });

  it("persists a parked JSON client answer as a json block", async () => {
    const parked = {
      a: {
        toolResult: {
          toolUseId: "a",
          status: "success",
          content: [{ text: PROXY_RESULT_PLACEHOLDER }],
        },
      },
    };
    const agent = agentWith({ parked });

    await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: '{"accepted":true}', isError: false } }),
    );

    expect(parked.a.toolResult.content as unknown[]).toEqual([
      { json: { accepted: true } },
    ]);
  });

  it("corrects a stub held in the SDK's serialized wrapper form", async () => {
    const wrapped = wrappedPlaceholder("a");
    const agent = agentWith({ messages: [dataMessage(wrapped)] });
    const sessionManager = savingSessionManager(agent);

    const corrected = await reconcile(
      sessionManager,
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect([...corrected]).toEqual(["a"]);
    // Rewritten in the shape it was found in, so a plain-data history does not
    // gain a class instance where the snapshot writer expects data.
    expect(wrapped.toolResult).toEqual({
      toolUseId: "a",
      status: "success",
      content: [{ text: "real" }],
    });
    expect(sessionManager.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it("leaves a decorated stub and the content beside it alone", async () => {
    // Overwriting the whole content array would destroy the sibling block,
    // which is unrecoverable, so the rewrite refuses and the caller falls back
    // to forwarding the real result as a prompt.
    const message = resultMessage(
      new ToolResultBlock({
        toolUseId: "a",
        status: "success",
        content: [
          new TextBlock(PROXY_RESULT_PLACEHOLDER),
          new TextBlock("note"),
        ],
      }),
    );
    const agent = agentWith({ messages: [message] });
    const sessionManager = savingSessionManager(agent);

    const corrected = await reconcile(
      sessionManager,
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect([...corrected]).toEqual([]);
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock(PROXY_RESULT_PLACEHOLDER),
      new TextBlock("note"),
    ]);
    expect(sessionManager.saveSnapshot).not.toHaveBeenCalled();
  });

  it("leaves a decorated parked stub alone", async () => {
    const parked = {
      a: {
        toolResult: {
          toolUseId: "a",
          status: "success",
          content: [{ text: PROXY_RESULT_PLACEHOLDER }, { text: "note" }],
        },
      },
    };
    const agent = agentWith({ parked });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect([...corrected]).toEqual([]);
    expect(parked.a.toolResult.content as unknown[]).toEqual([
      { text: PROXY_RESULT_PLACEHOLDER },
      { text: "note" },
    ]);
  });

  it.each([
    ["no reason at all", undefined],
    ["a blank reason", "   "],
  ])(
    "does not acknowledge a failure with %s as a success",
    async (_label, errorReason) => {
      const message = resultMessage(placeholderResult("a"));
      const agent = agentWith({ messages: [message] });

      await reconcile(
        savingSessionManager(agent),
        agent,
        pending({
          a: {
            text: "",
            isError: true,
            ...(errorReason ? { errorReason } : {}),
          },
        }),
      );

      // An empty error body would otherwise reach the void-result
      // acknowledgement and assert success under `status: "error"`.
      expect(toolResultsOf(message)[0]!.status).toBe("error");
      expect(toolResultsOf(message)[0]!.content).toEqual([
        new TextBlock("Failed: no reason given."),
      ]);
    },
  );

  it("keeps the returned body when a failure names no reason", async () => {
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({ messages: [message] });

    await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "half done", isError: true } }),
    );

    expect(toolResultsOf(message)[0]!.status).toBe("error");
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock("half done"),
    ]);
  });

  it("refuses the whole attempt when the prune cannot be written", async () => {
    // An app state that cannot be written would leave the id recorded while the
    // snapshot saved the correction, so the attempt fails instead and nothing
    // it did in memory survives.
    const message = resultMessage(placeholderResult("a"));
    const agent = {
      messages: [message],
      appState: { get: () => ["a"] },
    };
    const sessionManager = savingSessionManager(agent);

    await expect(
      reconcile(
        sessionManager,
        agent,
        pending({ a: { text: "real", isError: false } }),
      ),
    ).rejects.toThrow(/app state/);

    expect(sessionManager.saveSnapshot).not.toHaveBeenCalled();
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock(PROXY_RESULT_PLACEHOLDER),
    ]);
  });

  it("refuses the whole attempt when writing the prune throws", async () => {
    // A store that throws recorded nothing, so saving the correction would
    // leave the call outstanding forever. The throw must not escape past the
    // rollback either: the caller's fallback carries the client's answer to the
    // model as a prompt, which a correction left in the history would make the
    // second telling of the same answer.
    const message = resultMessage(placeholderResult("a"));
    const agent = {
      messages: [message],
      appState: {
        get: () => ["a"],
        set: () => {
          throw new Error("state store offline");
        },
      },
    };
    const sessionManager = savingSessionManager(agent);
    const { log, warnings } = capturingLogger();

    await expect(
      reconcile(
        sessionManager,
        agent,
        pending({ a: { text: "real", isError: false } }),
        log,
      ),
    ).rejects.toThrow(/app state/);

    expect(sessionManager.saveSnapshot).not.toHaveBeenCalled();
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock(PROXY_RESULT_PLACEHOLDER),
    ]);
    // The refusal reads as a boolean, so the store's own failure has to reach
    // the log to be attributable at all.
    expect((warnings[0]![1] as Error).message).toBe("state store offline");
  });

  it("propagates a failing snapshot write", async () => {
    // Recorded ids on purpose: the prune is half of what a refused save has to
    // undo, and with none recorded that half is never exercised at all.
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({
      messages: [message],
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["old", "a"] },
    });
    const sessionManager = storeBackedSessionManager(agent, {
      rejectWith: new Error("disk full"),
    });

    await expect(
      reconcile(
        sessionManager,
        agent,
        pending({ a: { text: "real", isError: false } }),
      ),
    ).rejects.toThrow("disk full");

    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock(PROXY_RESULT_PLACEHOLDER),
    ]);
    expect(recordedFrontendCallIds(agent)).toEqual(["old", "a"]);
  });

  it("rolls back every correction a refused save made, not just one", async () => {
    // A refused save has to leave nothing behind on either surface. Rolling
    // back only the newest rewrite would strand the rest in the history while
    // the caller forwards the same answers to the model as a prompt.
    const message = resultMessage(
      placeholderResult("a"),
      placeholderResult("b"),
    );
    const parked = { c: wrappedPlaceholder("c") };
    const agent = agentWith({ messages: [message], parked });
    const sessionManager = storeBackedSessionManager(agent, {
      rejectWith: new Error("disk full"),
    });

    await expect(
      reconcile(
        sessionManager,
        agent,
        pending({
          a: { text: "one", isError: false },
          b: { text: "two", isError: false },
          c: { text: "three", isError: false },
        }),
      ),
    ).rejects.toThrow("disk full");

    expect(toolResultsOf(message).map((block) => block.content)).toEqual([
      [new TextBlock(PROXY_RESULT_PLACEHOLDER)],
      [new TextBlock(PROXY_RESULT_PLACEHOLDER)],
    ]);
    expect(parked.c.toolResult.content).toEqual([
      { text: PROXY_RESULT_PLACEHOLDER },
    ]);
  });

  it("unwinds stacked corrections newest first", async () => {
    // One result rewritten twice in a single pass. Every view of a message is
    // built before the first rewrite lands, so a content array holding the same
    // block twice hands the second view the stub the first one already
    // replaced, and the result is corrected again. Each undo restores what its
    // own rewrite found: the older holds the stub, the newer holds the first
    // correction. Replayed forward the newer one lands last and the correction
    // outlives the save that refused it.
    const wrapper = wrappedPlaceholder("a");
    const agent = agentWith({ messages: [dataMessage(wrapper, wrapper)] });
    const sessionManager = storeBackedSessionManager(agent, {
      rejectWith: new Error("disk full"),
    });

    await expect(
      reconcile(
        sessionManager,
        agent,
        pending({ a: { text: "real", isError: false } }),
      ),
    ).rejects.toThrow("disk full");

    expect(wrapper.toolResult.content).toEqual([
      { text: PROXY_RESULT_PLACEHOLDER },
    ]);
  });

  it("restores the corrected content before it puts the pruned ids back", async () => {
    // The id restore is the one undo that writes back through the app state.
    // Run first, a store that refuses it strands every content rollback behind
    // it and masks the error that brought the rollback here.
    const parked = {
      a: {
        toolResult: {
          toolUseId: "a",
          status: "success",
          content: [{ text: PROXY_RESULT_PLACEHOLDER }] as unknown[],
        },
      },
    };
    const state = appState({ [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a"] });
    const contentAtEachWrite: unknown[][] = [];
    const agent = {
      messages: [],
      appState: {
        get: state.get,
        set: (key: string, value: unknown) => {
          contentAtEachWrite.push(
            structuredClone(parked.a.toolResult.content) as unknown[],
          );
          state.set(key, value);
        },
      },
      _interruptState: {
        activated: true,
        pendingToolExecution: { completedToolResults: parked },
      },
    };
    const sessionManager = storeBackedSessionManager(agent, {
      rejectWith: new Error("disk full"),
    });

    await expect(
      reconcile(
        sessionManager,
        agent,
        pending({ a: { text: "real", isError: false } }),
      ),
    ).rejects.toThrow("disk full");

    // The prune saw the corrected content; the restore saw the stub already
    // back in its place.
    expect(contentAtEachWrite).toEqual([
      [{ text: "real" }],
      [{ text: PROXY_RESULT_PLACEHOLDER }],
    ]);
  });

  it("reports a rollback the app state refused", async () => {
    // The one write whose refusal this module cannot itself undo: restoring the
    // pruned ids is an app-state write like the prune was, so a store that takes
    // the prune and then refuses the restore leaves the shorter list where the
    // next successful save flushes it, with the stubs already back in memory and
    // the ids that admit their answers gone. The caller's fallback says nothing
    // of the attempt survived, so this is the module's only chance to say
    // otherwise.
    //
    // Called directly rather than through `reconcile`: the store and memory
    // genuinely cannot be brought back into agreement here, which is the whole
    // content of the report, so the two are compared explicitly below instead.
    const message = resultMessage(placeholderResult("a"));
    const state = appState({ [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a"] });
    let writes = 0;
    const agent = {
      messages: [message],
      appState: {
        get: state.get,
        set: (key: string, value: unknown) => {
          if (++writes > 1) throw new Error("state store offline");
          state.set(key, value);
        },
      },
    };
    const sessionManager = storeBackedSessionManager(agent, {
      rejectWith: new Error("disk full"),
    });

    // Read off the fallback logger, with none passed: the adapter reconciles
    // without one, so that is where a deployment would see this.
    const { warnings, errors } = await withCapturedConsole(async () => {
      await expect(
        reconcileFrontendToolResults(
          sessionManager,
          agent,
          pending({ a: { text: "real", isError: false } }),
        ),
      ).rejects.toThrow("disk full");
    });

    // The content rollback still landed, and it is the id restore alone that
    // did not.
    expect(toolResultsOf(message)[0]!.content).toEqual([
      new TextBlock(PROXY_RESULT_PLACEHOLDER),
    ]);
    expect(memoryPicture(agent).frontendCallIds).toEqual([]);
    expect(storedPicture(sessionManager).frontendCallIds).toEqual(["a"]);

    // The consequence is named, and the store's own failure is attributable
    // beside it, rather than the pair passing for a clean undo.
    expect(errors).toHaveLength(1);
    expect(String(errors[0]![0])).toContain(
      "could not put the pruned frontend call ids back",
    );
    expect(String(errors[0]![0])).toContain("the calls a can no longer");
    expect(warnings).toHaveLength(1);
    expect((warnings[0]![1] as Error).message).toBe("state store offline");
  });

  it("does not invent a status key the parked result never had", async () => {
    // The undo owes the result back exactly as it was found. Assigning the
    // captured status back recreates an absent key as `undefined`, so the
    // rolled-back result is no longer the object the store handed over: a reader
    // that tells an absent key from an undefined one now sees a status where
    // there was none. The instance path beside this one puts the original block
    // back whole and owes nothing here.
    const parked: Record<string, { toolResult: Record<string, unknown> }> = {
      a: {
        toolResult: {
          toolUseId: "a",
          content: [{ text: PROXY_RESULT_PLACEHOLDER }] as unknown[],
        },
      },
    };
    const agent = agentWith({ parked });
    const sessionManager = storeBackedSessionManager(agent, {
      rejectWith: new Error("disk full"),
    });

    await expect(
      reconcile(
        sessionManager,
        agent,
        pending({ a: { text: "real", isError: false } }),
      ),
    ).rejects.toThrow("disk full");

    expect("status" in parked.a!.toolResult).toBe(false);
    expect(parked.a!.toolResult.content).toEqual([
      { text: PROXY_RESULT_PLACEHOLDER },
    ]);
  });
});

/**
 * Shapes the message-path reader refuses.
 *
 * A block claiming a shape it does not carry is refused rather than trusted:
 * every reader of one calls array methods on its content and matches on its id,
 * some from call sites outside reconciliation's own error handling. Refusing
 * means the result is not reported as corrected, which is what sends the
 * client's answer to the model as a prompt instead.
 */
describe("reconcileFrontendToolResults over unusual message shapes", () => {
  /** Reconcile one message against a client result for "a". */
  const reconcileOne = async (message: unknown): Promise<string[]> => {
    const agent = agentWith({ messages: [message] });
    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "real", isError: false } }),
    );
    return [...corrected];
  };

  it.each([
    [
      "a toolUse block, which answers nothing",
      new Message({
        role: "assistant",
        content: [new ToolUseBlock({ name: "t", toolUseId: "a", input: {} })],
      }),
    ],
    [
      "a serialized toolUse block",
      dataMessage({ toolUse: { toolUseId: "a", name: "t", input: {} } }),
    ],
    ["a message with no content array", { role: "user" }],
    [
      "a wrapper whose content is not a block array",
      dataMessage({
        toolResult: {
          toolUseId: "a",
          status: "success",
          content: PROXY_RESULT_PLACEHOLDER,
        },
      }),
    ],
    [
      "an instance-shaped block whose content is not a block array",
      dataMessage({
        type: "toolResultBlock",
        toolUseId: "a",
        status: "success",
        content: PROXY_RESULT_PLACEHOLDER,
      }),
    ],
    [
      "an instance-shaped block whose id is not a string",
      dataMessage({
        type: "toolResultBlock",
        toolUseId: 7,
        status: "success",
        content: [{ text: PROXY_RESULT_PLACEHOLDER }],
      }),
    ],
  ])("corrects nothing in %s", async (_label, message) => {
    expect(await reconcileOne(message)).toEqual([]);
  });

  it("corrects a stub sitting behind a hole in the content array", async () => {
    expect(
      await reconcileOne(dataMessage(null, wrappedPlaceholder("a"))),
    ).toEqual(["a"]);
  });
});

/**
 * The structural comparison, at the two places it can quietly say "equal".
 *
 * It answers both "is this exactly the stub, so may the rewrite replace it?" and
 * "does this already carry the client's answer?". A comparison that is too
 * generous on the first replaces content this adapter never wrote; too generous
 * on the second, it drops the client's answer and retires the call id.
 */
describe("reconcileFrontendToolResults comparing content structurally", () => {
  it("does not read a block with no keys as the stub", async () => {
    // The walk visits only the left side's keys, so a block with none at all
    // matches every block unless the key counts are compared too.
    const wrapped = {
      toolResult: {
        toolUseId: "a",
        status: "success",
        content: [{}] as unknown[],
      },
    };
    const agent = agentWith({ messages: [dataMessage(wrapped)] });
    const sessionManager = savingSessionManager(agent);

    const corrected = await reconcile(
      sessionManager,
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect([...corrected]).toEqual([]);
    expect(wrapped.toolResult.content).toEqual([{}]);
    expect(sessionManager.saveSnapshot).not.toHaveBeenCalled();
  });

  it("does not read a sparse array as equal to a dense one", async () => {
    // A callback iterator skips array holes, which makes a sparse array equal to
    // any array of the same length. The persisted result below is then read as
    // already carrying the client's answer, and the answer is thrown away.
    const sparse: unknown[] = [1, 2];
    delete sparse[0];
    const wrapped = {
      toolResult: {
        toolUseId: "a",
        status: "success",
        content: [{ json: sparse }] as unknown[],
      },
    };
    const agent = agentWith({
      messages: [dataMessage(wrapped)],
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a"] },
    });

    const corrected = await reconcile(
      savingSessionManager(agent),
      agent,
      pending({ a: { text: "[1,2]", isError: false } }),
    );

    expect([...corrected]).toEqual([]);
    // Not this adapter's content to replace either, so the id stays recorded for
    // a later turn to retry against.
    expect(recordedFrontendCallIds(agent)).toEqual(["a"]);
  });
});

/**
 * Pruning the recorded call ids is part of reconciliation, not a follow-up the
 * caller performs: an id dropped after the snapshot write only reaches the
 * store if some later save happens to fire, and until then a restart restores a
 * store that still claims the call is outstanding.
 */
describe("reconcileFrontendToolResults pruning the recorded call ids", () => {
  it("drops a corrected id in the same snapshot as the correction", async () => {
    const message = resultMessage(placeholderResult("a"));
    const agent = agentWith({
      messages: [message],
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["old", "a", "b"] },
    });
    const { manager, sawCallIds } = snapshotWatchingSessionManager(agent);

    await reconcile(
      manager,
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    // One write, and the shorter list was already in place when it happened.
    // Order survives, because the emission-time size cap drops oldest first.
    expect(sawCallIds).toEqual([["old", "b"]]);
    expect(recordedFrontendCallIds(agent)).toEqual(["old", "b"]);
  });

  it("saves the prune even when nothing needed rewriting", async () => {
    // An exact client retry corrects nothing, so there is no content change to
    // carry the prune: without a write of its own the id would stay recorded.
    const message = resultMessage(
      new ToolResultBlock({
        toolUseId: "a",
        status: "success",
        content: [new TextBlock("real")],
      }),
    );
    const agent = agentWith({
      messages: [message],
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a"] },
    });
    const { manager, sawCallIds } = snapshotWatchingSessionManager(agent);

    await reconcile(
      manager,
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect(sawCallIds).toEqual([[]]);
    expect(recordedFrontendCallIds(agent)).toEqual([]);
  });

  it("keeps an id whose placeholder was not corrected", async () => {
    // A stub carrying content this adapter did not write is never overwritten,
    // so its id has to stay recorded for a later turn to retry against.
    const message = resultMessage(
      new ToolResultBlock({
        toolUseId: "a",
        status: "success",
        content: [
          new TextBlock(PROXY_RESULT_PLACEHOLDER),
          new TextBlock("note"),
        ],
      }),
    );
    const agent = agentWith({
      messages: [message],
      state: { [AG_UI_FRONTEND_CALL_IDS_STATE_KEY]: ["a"] },
    });
    const { manager, sawCallIds } = snapshotWatchingSessionManager(agent);

    await reconcile(
      manager,
      agent,
      pending({ a: { text: "real", isError: false } }),
    );

    expect(sawCallIds).toEqual([]);
    expect(recordedFrontendCallIds(agent)).toEqual(["a"]);
  });
});

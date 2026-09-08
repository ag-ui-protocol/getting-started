/**
 * Parity between the two paths that carry a client tool result to the model.
 *
 * A frontend tool runs on the client, so its answer arrives on the NEXT request
 * as an AG-UI `tool` message, and the adapter has two ways to put that answer
 * in front of the model. With no session manager it replays the request's own
 * history (`_buildStrandsHistory`); with one it rewrites the placeholder it
 * persisted (`reconcileFrontendToolResults`). Which one runs is a deployment
 * detail the client cannot see, so the same answer owes the model the same
 * `toolResult`: the same status, and the same content block.
 *
 * Both halves of the table are driven end to end through `agent.run()` over a
 * real Strands `Agent`, on ONE continuation payload per row: the only
 * difference between the two runs is whether a session manager is wired. So
 * what is compared is what each path actually installs, not what a helper
 * called directly returns.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileStorage, SessionManager } from "@strands-agents/sdk";
import type { RunAgentInput } from "@ag-ui/core";

import {
  collect,
  expectNoRunError,
  minimalRunInput,
  modelTurn,
  persistedToolResults,
  realStrandsAgent,
  type PersistedResultContent,
  type PersistedToolResult,
} from "./helpers";

const TOOL = "set_color";
const NATIVE_ID = "native-tool-use-1";
const SESSION_ID = "parity-session";
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
  const dir = mkdtempSync(join(tmpdir(), "agui-strands-parity-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Turn 1: the model calls the frontend tool, so the adapter halts. */
const CALLS_FRONTEND_TOOL = [
  modelTurn.toolUse({
    toolUseId: NATIVE_ID,
    name: TOOL,
    input: { color: "red" },
  }),
];

/** Turn 2: the model answers once it can see the client's result. */
const ANSWERS = [modelTurn.text("The color is now red.")];

/** One `toolResult`, in the form both the store and the model-facing history
 * report it. */
function toolResult(
  status: "success" | "error",
  ...content: PersistedResultContent[]
): PersistedToolResult {
  return { toolUseId: NATIVE_ID, status, content };
}

/** One client answer, and the single `toolResult` both paths owe the model. */
interface ClientAnswer {
  label: string;
  content: string;
  /** The client's failure reason. Absent means the call succeeded. */
  error?: string;
  expected: PersistedToolResult;
  /**
   * The line the prompt path restates this answer as. A third producer, and the
   * only one that names the tool, so its wording differs by design while its
   * branching must not.
   */
  expectedPrompt: string;
}

const ANSWER_TABLE: ClientAnswer[] = [
  {
    label: "a plain answer",
    content: "color applied",
    expected: toolResult("success", { text: "color applied" }),
    expectedPrompt: `${TOOL} returned: color applied`,
  },
  {
    label: "a JSON answer",
    content: '{"applied":true}',
    expected: toolResult("success", { json: { applied: true } }),
    expectedPrompt: `${TOOL} returned: {"applied":true}`,
  },
  {
    label: "a void answer",
    content: "",
    expected: toolResult("success", {
      text: "Tool executed successfully with no return value.",
    }),
    expectedPrompt: `${TOOL} executed successfully with no return value.`,
  },
  {
    label: "a failure with a body",
    content: "half applied",
    error: "the user declined",
    expected: toolResult("error", {
      text: "Failed: the user declined (returned: half applied)",
    }),
    expectedPrompt: `${TOOL} failed: the user declined (returned: half applied)`,
  },
  {
    label: "a failure with no body",
    content: "",
    error: "the user declined",
    expected: toolResult("error", { text: "Failed: the user declined" }),
    expectedPrompt: `${TOOL} failed: the user declined`,
  },
  {
    label: "a failure with neither a body nor a reason",
    content: "",
    error: "   ",
    expected: toolResult("error", { text: "Failed: no reason given." }),
    expectedPrompt: `${TOOL} failed: no reason given.`,
  },
  // A reason of "" is the one failure signal that is FALSY, so a reader testing
  // `error` for truth rather than for presence answers it as a success. Under
  // reconciliation that answer is a durable write, so the thread carries "the
  // frontend tool succeeded" for as long as it lives.
  {
    label: "a failure whose reason is the empty string, with a body",
    content: "half applied",
    error: "",
    expected: toolResult("error", { text: "half applied" }),
    expectedPrompt: `${TOOL} failed: half applied`,
  },
  {
    label: "a failure whose reason is the empty string and has no body",
    content: "",
    error: "",
    expected: toolResult("error", { text: "Failed: no reason given." }),
    expectedPrompt: `${TOOL} failed: no reason given.`,
  },
];

function firstRun(): RunAgentInput {
  return minimalRunInput({
    messages: [{ id: "u1", role: "user", content: "make it red" } as never],
    tools: CLIENT_TOOLS,
  });
}

/**
 * The continuation a client sends once the tool has run, in the form that
 * leaves nothing to deduce: the assistant tool call and the tool declarations
 * are both present, so only the answer itself is under test.
 */
function continuation(answer: ClientAnswer): RunAgentInput {
  return minimalRunInput({
    runId: "run-2",
    tools: CLIENT_TOOLS,
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
        content: answer.content,
        ...(answer.error !== undefined ? { error: answer.error } : {}),
      } as never,
    ],
  });
}

/**
 * The whole thread in ONE request, with a user turn after the answer.
 *
 * No earlier run, so the per-thread agent is built cold and its history is the
 * seed's rather than a session store's. The trailing user turn keeps the request
 * off the continuation path, so no prompt restates this answer either and what
 * the model reads is exactly what the seed installed.
 */
function seedRun(answer: ClientAnswer): RunAgentInput {
  return minimalRunInput({
    tools: CLIENT_TOOLS,
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
        content: answer.content,
        ...(answer.error !== undefined ? { error: answer.error } : {}),
      } as never,
      { id: "u2", role: "user", content: "and now?" } as never,
    ],
  });
}

type ScriptedModelLike = ReturnType<typeof realStrandsAgent>["model"];

/** One model turn per request, across the first run and the continuation. */
const MODEL_TURNS = 2;

/** The continuation's own turn, which is where the client's answer shows up. */
const CONTINUATION_TURN = 1;

/**
 * Every `toolResult` the model saw on the continuation's turn, read in the same
 * form the store holds: history carries SDK class instances, which report their
 * stored shape through `toJSON()`.
 *
 * The turn count is pinned rather than only the indexed turn's existence. An
 * index into a list nobody sized reads whatever turn happens to sit there, so a
 * path that invoked the provider a second time for the continuation would have
 * its FIRST attempt compared here and the extra call would go unremarked.
 */
function toolResultsSeen(
  model: ScriptedModelLike,
  turns = MODEL_TURNS,
  turn = CONTINUATION_TURN,
): PersistedToolResult[] {
  expect(model.seenMessages.length, "model turns taken by this path").toBe(
    turns,
  );
  const out: PersistedToolResult[] = [];
  for (const message of model.seenMessages[turn]!) {
    const data = ((message as { toJSON?: () => unknown }).toJSON?.() ??
      message) as { content?: unknown[] };
    for (const block of data.content ?? []) {
      const wrapped = (block as { toolResult?: unknown }).toolResult;
      if (wrapped) out.push(wrapped as PersistedToolResult);
    }
  }
  return out;
}

/** The replay path: no session manager, so the request's history is replayed. */
async function replayed(answer: ClientAnswer): Promise<PersistedToolResult[]> {
  const { agent, model } = realStrandsAgent([
    ...CALLS_FRONTEND_TOOL,
    ...ANSWERS,
  ]);
  expectNoRunError(await collect(agent, firstRun()), "replay first run");
  expectNoRunError(
    await collect(agent, continuation(answer)),
    "replay continuation",
  );
  return toolResultsSeen(model);
}

/** The reconcile path: a session manager owns the history and the placeholder. */
async function reconciled(answer: ClientAnswer): Promise<{
  seen: PersistedToolResult[];
  persisted: PersistedToolResult[];
}> {
  const dir = storageDir();
  const { agent, model } = realStrandsAgent(
    [...CALLS_FRONTEND_TOOL, ...ANSWERS],
    {
      config: {
        sessionManagerProvider: () =>
          new SessionManager({
            sessionId: SESSION_ID,
            storage: { snapshot: new FileStorage(dir) },
          }),
      },
    },
  );
  expectNoRunError(await collect(agent, firstRun()), "reconcile first run");
  expectNoRunError(
    await collect(agent, continuation(answer)),
    "reconcile continuation",
  );
  return {
    seen: toolResultsSeen(model),
    persisted: persistedToolResults(dir),
  };
}

/**
 * The prompt path: no session manager AND no history replay, so neither
 * producer above carries the answer and the continuation prompt is the only
 * thing that can. Returns the user-message texts the model saw on that turn.
 */
async function prompted(answer: ClientAnswer): Promise<string[]> {
  const { agent, model } = realStrandsAgent(
    [...CALLS_FRONTEND_TOOL, ...ANSWERS],
    { config: { replayHistoryIntoStrands: false } },
  );
  expectNoRunError(await collect(agent, firstRun()), "prompt first run");
  expectNoRunError(
    await collect(agent, continuation(answer)),
    "prompt continuation",
  );
  expect(
    model.seenMessages.length,
    "model turns taken across the first run and the continuation",
  ).toBe(MODEL_TURNS);
  // The LAST user turn only: earlier ones are the thread's own history, which
  // this path replays unchanged, and the run's own prompt is what is under test.
  const users = model.seenMessages[CONTINUATION_TURN]!.filter(
    (message) => (message as { role?: string }).role === "user",
  );
  const last = users.at(-1);
  return ((last as { content?: unknown[] })?.content ?? [])
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === "string");
}

/** One model turn: the seeded run is the only request this path makes. */
const SEEDED_TURNS = 1;

/**
 * The seed path: `buildStrandsSeed` is the producer, because the answer is
 * already in the request when the per-thread agent is constructed.
 *
 * The replay is off, which is what leaves the seed's own block in front of the
 * model: with it on, `_buildStrandsHistory` REPLACES the seeded history wholesale
 * on the same turn, so the seed's block is built and then thrown away. Off, the
 * cold start has nothing else to install and the seed is what the model reads.
 */
async function seeded(answer: ClientAnswer): Promise<PersistedToolResult[]> {
  const { agent, model } = realStrandsAgent(ANSWERS, {
    config: { replayHistoryIntoStrands: false },
  });
  expectNoRunError(await collect(agent, seedRun(answer)), "seeded run");
  return toolResultsSeen(model, SEEDED_TURNS, 0);
}

describe("a client tool result on every path that carries one", () => {
  it.each(ANSWER_TABLE)(
    "carries $label to the model identically",
    async (answer) => {
      const replay = await replayed(answer);
      const reconcile = await reconciled(answer);
      const prompt = await prompted(answer);
      const seed = await seeded(answer);

      // One assertion over all five facets, so a row's red output says which
      // path disagreed and how, and so no path can pass on its own. The prompt
      // is compared as the line it restates, since it is prose to the model
      // rather than a `toolResult`; what has to match is which branch it took.
      expect({
        replayed: replay,
        reconciled: reconcile.seen,
        persisted: reconcile.persisted,
        prompted: prompt,
        seeded: seed,
      }).toEqual({
        replayed: [answer.expected],
        reconciled: [answer.expected],
        persisted: [answer.expected],
        prompted: [answer.expectedPrompt],
        seeded: [answer.expected],
      });
    },
  );
});

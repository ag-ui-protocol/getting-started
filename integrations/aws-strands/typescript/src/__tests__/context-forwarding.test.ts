/**
 * `RunAgentInput.context` must reach the model for one call and nowhere else.
 *
 * The block the application's context renders to is shown to the model from a
 * before-model-call hook and withdrawn from the after-hook, so these tests sit
 * at the real model boundary: a `ScriptedModel` records exactly the history the
 * SDK handed it, and the durable history, the `MESSAGES_SNAPSHOT` and the
 * session store are read back afterwards to prove the block stayed out of all
 * three. Mirrors the Python bridge's `tests/test_context_forwarding.py` case
 * for case, and adds the arms that file leaves to other suites: concurrent
 * runs, orchestrators, the refusal on an agent with no hook registry, and the
 * A2UI render-guide exclusion.
 *
 * The native history is only half the contract: a turn can look right and
 * still serialize into a request the provider rejects, which is what shipped.
 * So the tool-continuation cases also run the recorded history through the
 * real OpenAI and Anthropic clients and assert on the request body itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AfterInvocationEvent,
  Agent,
  FileStorage,
  Graph,
  Message as StrandsMessage,
  SessionManager,
  tool,
} from "@strands-agents/sdk";
import { A2UI_SCHEMA_CONTEXT_DESCRIPTION } from "@ag-ui/a2ui-toolkit";
import {
  EventType,
  type InputContent,
  type Message as AguiMessage,
  type RunAgentInput,
} from "@ag-ui/core";
import { z } from "zod";

import { StrandsAgent } from "../agent";
import {
  a2uiRenderGuideDescription,
  buildA2UISubagentState,
  withoutA2UIRenderGuides,
} from "../a2ui-tool";
import {
  MODEL_CONTEXT_HEADER,
  describeModelBoundHistory,
  formatAguiContext,
  modelBoundHistoryOutline,
  normalizeAguiContext,
} from "../model-context";
import {
  ScriptedModel,
  collect,
  errorCodes,
  expectCompletedRun,
  anthropicRequestMessages,
  expectRolesAlternate,
  expectToolCallsAnsweredImmediately,
  historyShape,
  historyTexts,
  minimalRunInput,
  modelSawShape,
  modelSawTexts,
  modelTurn,
  openAIChatRequestMessages,
  openAIResponsesRequestItems,
  openAIRoleSequence,
  persistedSnapshot,
  realStrandsAgent,
  scriptedStrandsAgent,
  snapshotsOf,
  threadAgent,
} from "./helpers";

/** Pinned as a literal so a drift in the header is a failing test, not a rename. */
const HEADER = "Context provided by the application:";

/** The block for the given lines, in the shape both bridges emit. */
function blockOf(...lines: string[]): string {
  return `${HEADER}\n${lines.join("\n")}`;
}

type ContextEntry = RunAgentInput["context"][number];

/** One user turn plus the given context, the shape every case starts from. */
function contextRun(
  context: ContextEntry[],
  options: {
    threadId?: string;
    content?: string | InputContent[];
    messages?: AguiMessage[];
    forwardedProps?: Record<string, unknown>;
  } = {},
): RunAgentInput {
  return minimalRunInput({
    threadId: options.threadId,
    context,
    messages: options.messages ?? [
      {
        id: "u1",
        role: "user",
        content: options.content ?? "hello",
      } as AguiMessage,
    ],
    ...(options.forwardedProps
      ? { forwardedProps: options.forwardedProps }
      : {}),
  });
}

/**
 * An agent whose first turn calls a backend tool, so its second model call is a
 * tool continuation: the latest user turn is the one answering the call.
 * `parallel` opens two calls in that turn so the adjacency assertions cover
 * more than one result.
 */
function toolContinuationAgent(options: { parallel?: boolean } = {}) {
  const lookup = tool({
    name: "lookup",
    description: "d",
    inputSchema: z.object({}).passthrough(),
    callback: async () => ({ invoice: 42 }),
  });
  const audit = tool({
    name: "audit",
    description: "d",
    inputSchema: z.object({}).passthrough(),
    callback: async () => ({ ok: true }),
  });
  const calls = options.parallel
    ? [
        { toolUseId: "t1", name: "lookup", input: {} },
        { toolUseId: "t2", name: "audit", input: {} },
      ]
    : [{ toolUseId: "t1", name: "lookup", input: {} }];
  return realStrandsAgent(
    [modelTurn.toolUse(...calls), modelTurn.text("done")],
    {
      tools: options.parallel ? [lookup, audit] : [lookup],
    },
  );
}

/** Run `context` through a tool continuation, returning the recorded turns. */
async function continuationTurns(
  context: ContextEntry[],
  options: { parallel?: boolean } = {},
) {
  const { agent, model } = toolContinuationAgent(options);
  const events = await collect(agent, contextRun(context));
  expectCompletedRun(events);
  expect(
    model.seenMessages.length,
    "the tool result did not bring the loop back to the model",
  ).toBe(2);
  return model.seenMessages[1]!;
}

/** A logger that swallows the injection warning a Graph run prints. */
const quiet = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("model context block rendering", () => {
  it("pins the header the Python bridge emits", () => {
    expect(MODEL_CONTEXT_HEADER).toBe(HEADER);
  });

  it("renders one line per entry, with the description dropped when blank", () => {
    const block = formatAguiContext(
      normalizeAguiContext([
        { description: "account", value: "premium" },
        { description: "   ", value: "no description" },
        { value: "missing description" },
      ]),
    );
    expect(block).toBe(
      blockOf(
        "- account: premium",
        "- no description",
        "- missing description",
      ),
    );
  });

  it("JSON-serializes non-string values the way json.dumps does for scalars", () => {
    // Integers, booleans and null serialize identically on both bridges; the
    // shapes that do not (objects, arrays, integral floats, non-ASCII) are
    // documented on `formatAguiContext` rather than emulated.
    const block = formatAguiContext(
      normalizeAguiContext([
        { description: "count", value: 42 },
        { description: "enabled", value: true },
        { description: "nothing", value: null },
      ]),
    );
    expect(block).toBe(
      blockOf("- count: 42", "- enabled: true", "- nothing: null"),
    );
  });

  it("renders nothing for an empty or schema-only context", () => {
    expect(formatAguiContext(normalizeAguiContext([]))).toBe("");
    expect(formatAguiContext(normalizeAguiContext(undefined))).toBe("");
    expect(
      formatAguiContext(
        normalizeAguiContext([
          { description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: "catalog" },
        ]),
      ),
    ).toBe("");
  });
});

describe("context forwarding to the model", () => {
  it("joins the context onto the latest user turn and excludes the A2UI schema entry", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")]);
    const lookalike = "A2UI Component Schema for customer preferences";

    const events = await collect(
      agent,
      contextRun([
        { description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: "raw catalog" },
        { description: lookalike, value: "keep me" },
        { description: "user_id", value: "u-42" },
      ]),
    );

    expectCompletedRun(events);
    expect(modelSawTexts(model, 0)).toEqual([
      blockOf(`- ${lookalike}: keep me`, "- user_id: u-42"),
      "hello",
    ]);
    // One turn, not two: a second user message in a row is what the
    // block-level formatters refuse. See the provider-bound cases below.
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock", "textBlock"] },
    ]);
    // The block was for the model only: the durable history holds the turn
    // and the answer, and no snapshot the client received carries it.
    expect(historyTexts(threadAgent(agent)!.messages)).toEqual(["hello", "ok"]);
    for (const snapshot of snapshotsOf(events)) {
      expect(JSON.stringify(snapshot)).not.toContain(HEADER);
    }
  });

  it("changes nothing when the context is empty", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")]);

    const events = await collect(agent, contextRun([]));

    expectCompletedRun(events);
    expect(modelSawTexts(model, 0)).toEqual(["hello"]);
    expect(JSON.stringify(model.seenMessages[0])).not.toContain(HEADER);
  });

  it("is transient when history replay is disabled", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")], {
      config: { replayHistoryIntoStrands: false },
    });

    const events = await collect(
      agent,
      contextRun([{ description: "account", value: "premium" }]),
    );

    expectCompletedRun(events);
    expect(modelSawTexts(model, 0)).toEqual([
      blockOf("- account: premium"),
      "hello",
    ]);
    expect(historyTexts(threadAgent(agent)!.messages)).toEqual(["hello", "ok"]);
  });

  it("is transient for a multimodal direct prompt", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")], {
      config: { replayHistoryIntoStrands: false },
    });
    const content: InputContent[] = [
      { type: "text", text: "hello" },
      {
        type: "image",
        source: {
          type: "data",
          value: Buffer.from("fake-image").toString("base64"),
          mimeType: "image/png",
        },
      },
    ];

    const events = await collect(
      agent,
      contextRun([{ description: "locale", value: "nl-NL" }], { content }),
    );

    expectCompletedRun(events);
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock", "textBlock", "imageBlock"] },
    ]);
    expect(modelSawTexts(model, 0)).toEqual([
      blockOf("- locale: nl-NL"),
      "hello",
    ]);
    expect(historyShape(threadAgent(agent)!.messages)).toEqual([
      { role: "user", blocks: ["textBlock", "imageBlock"] },
      { role: "assistant", blocks: ["textBlock"] },
    ]);
  });

  it("leaves the prompt alone when the only entry is the A2UI schema", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")], {
      config: { replayHistoryIntoStrands: false },
    });

    const events = await collect(
      agent,
      contextRun([
        { description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: "raw catalog" },
      ]),
    );

    expectCompletedRun(events);
    expect(modelSawTexts(model, 0)).toEqual(["hello"]);
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock"] },
    ]);
  });

  it("joins the current question rather than the head of stale history", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")]);

    const events = await collect(
      agent,
      contextRun([{ description: "selected invoice", value: "123" }], {
        messages: [
          { id: "u1", role: "user", content: "selected invoice 456" },
          { id: "a1", role: "assistant", content: "noted" },
          { id: "u2", role: "user", content: "which invoice is selected?" },
        ],
      }),
    );

    expectCompletedRun(events);
    expect(modelSawTexts(model, 0)).toEqual([
      "selected invoice 456",
      "noted",
      blockOf("- selected invoice: 123"),
      "which invoice is selected?",
    ]);
    // The block rides on the question being asked now, so the stale turns
    // mentioning an older invoice are handed over untouched. Read from the
    // model-call-time copy: the live array has since grown by the answer. Only
    // the role and the content are compared, because that is all a provider is
    // sent; the SDK is free to add bookkeeping fields to a serialized message
    // and does across releases.
    const seen = model.seenMessages[0]!;
    const latest = seen[seen.length - 1]!;
    expect(latest.role).toBe("user");
    expect(latest.toJSON().content).toEqual([
      { text: blockOf("- selected invoice: 123") },
      { text: "which invoice is selected?" },
    ]);
    expect(seen[0]!.toJSON().content).toEqual([
      { text: "selected invoice 456" },
    ]);
    expect(historyTexts(threadAgent(agent)!.messages)).toEqual([
      "selected invoice 456",
      "noted",
      "which invoice is selected?",
      "ok",
    ]);
  });

  it("joins the question turn when the latest user turn carries a tool result", async () => {
    const { agent, model } = toolContinuationAgent();

    const events = await collect(
      agent,
      contextRun([{ description: "selected invoice", value: "123" }]),
    );

    expectCompletedRun(events);
    // First call: joined onto the question, one turn.
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock", "textBlock"] },
    ]);
    // Second call: the latest user turn is now the tool result. The block still
    // joins the question, because neither that turn nor a turn beside it can
    // take it without breaking the request. See the provider-bound cases below.
    expect(modelSawShape(model, 1)).toEqual([
      { role: "user", blocks: ["textBlock", "textBlock"] },
      { role: "assistant", blocks: ["toolUseBlock"] },
      { role: "user", blocks: ["toolResultBlock"] },
    ]);
    expect(modelSawTexts(model, 1)[0]).toBe(blockOf("- selected invoice: 123"));
    // Withdrawn again: the durable question turn is only the question.
    expect(historyShape(threadAgent(agent)!.messages)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["toolUseBlock"] },
      { role: "user", blocks: ["toolResultBlock"] },
      { role: "assistant", blocks: ["textBlock"] },
    ]);
    expect(JSON.stringify(threadAgent(agent)!.messages)).not.toContain(HEADER);
  });

  it("is withdrawn when the consumer abandons the run mid-model-call", async () => {
    const { agent } = realStrandsAgent([modelTurn.text("a long answer")]);

    // Break out on the first token: the model call is still in flight, so the
    // after-hook has not run and only the run-loop teardown can restore.
    for await (const event of agent.run(
      contextRun([{ description: "account", value: "premium" }]),
    )) {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) break;
    }

    expect(JSON.stringify(threadAgent(agent)!.messages)).not.toContain(HEADER);
  });

  it("keeps two in-flight runs' context apart", async () => {
    const { agent, model } = realStrandsAgent([
      modelTurn.text("one"),
      modelTurn.text("two"),
    ]);

    await Promise.all([
      collect(
        agent,
        contextRun([{ description: "thread", value: "A" }], {
          threadId: "thread-A",
          content: "question A",
        }),
      ),
      collect(
        agent,
        contextRun([{ description: "thread", value: "B" }], {
          threadId: "thread-B",
          content: "question B",
        }),
      ),
    ]);

    expect(model.seenMessages).toHaveLength(2);
    for (const seen of model.seenMessages) {
      const texts = historyTexts(seen);
      expect(texts).toHaveLength(2);
      const which = texts[1]!.endsWith("A") ? "A" : "B";
      expect(texts).toEqual([
        blockOf(`- thread: ${which}`),
        `question ${which}`,
      ]);
    }
  });

  it("refuses a run with context on an agent that exposes no hook registry", async () => {
    const agent = scriptedStrandsAgent([], {
      stubOverrides: { addHook: undefined },
    });

    const events = await collect(
      agent,
      contextRun([{ description: "account", value: "premium" }]),
    );

    expect(errorCodes(events)).toEqual(["STRANDS_ERROR"]);
    const error = events.find((e) => e.type === EventType.RUN_ERROR) as
      | { message?: string }
      | undefined;
    expect(error?.message).toBe(
      "Strands agent does not expose a hook registry for transient context",
    );
  });

  it("does not need a hook registry when there is no context to show", async () => {
    const agent = scriptedStrandsAgent([], {
      stubOverrides: { addHook: undefined },
    });

    const events = await collect(agent, contextRun([]));

    expect(errorCodes(events)).toEqual([]);
  });
});

describe("context forwarding with a session manager", () => {
  it("is visible for one model call but never persisted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agui-strands-context-"));
    dirs.push(dir);
    const threadId = "context-session";
    const { agent, model } = realStrandsAgent(
      [modelTurn.text("ok"), modelTurn.text("ok again")],
      {
        config: {
          sessionManagerProvider: () =>
            new SessionManager({
              sessionId: threadId,
              storage: { snapshot: new FileStorage(dir) },
            }),
        },
      },
    );

    const first = await collect(
      agent,
      contextRun([{ description: "token", value: "secret-value" }], {
        threadId,
        content: "first question",
      }),
    );
    expectCompletedRun(first);

    const instance = threadAgent(agent, threadId)!;
    expect(JSON.stringify(model.seenMessages[0])).toContain("secret-value");
    expect(JSON.stringify(instance.messages)).not.toContain("secret-value");
    expect(JSON.stringify(persistedSnapshot(dir))).not.toContain(
      "secret-value",
    );

    const second = await collect(
      agent,
      contextRun([], { threadId, content: "second question" }),
    );
    expectCompletedRun(second);

    expect(JSON.stringify(model.seenMessages[1])).toContain("second question");
    expect(JSON.stringify(model.seenMessages[1])).not.toContain("secret-value");
    expect(JSON.stringify(instance.messages)).not.toContain("secret-value");
    expect(JSON.stringify(persistedSnapshot(dir))).not.toContain(
      "secret-value",
    );
  });

  it("is not persisted when the consumer abandons the run mid-model-call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agui-strands-context-"));
    dirs.push(dir);
    const threadId = "context-cancel-session";
    const { agent } = realStrandsAgent([modelTurn.text("a long answer")], {
      config: {
        sessionManagerProvider: () =>
          new SessionManager({
            sessionId: threadId,
            storage: { snapshot: new FileStorage(dir) },
          }),
      },
    });

    // Returning the Strands stream is not a silent close: its own cleanup
    // runs the after-invocation hooks, and the session manager saves
    // `agent.messages` from there. Record what those hooks see at that
    // moment, then break with the model call still in flight.
    const messagesAtAfterInvocation: string[] = [];
    for await (const event of agent.run(
      contextRun([{ description: "token", value: "secret-value" }], {
        threadId,
        content: "first question",
      }),
    )) {
      if (event.type === EventType.TEXT_MESSAGE_START) {
        threadAgent(agent, threadId)!.addHook(
          AfterInvocationEvent,
          (hookEvent: AfterInvocationEvent) => {
            messagesAtAfterInvocation.push(
              JSON.stringify(hookEvent.agent.messages),
            );
          },
        );
      }
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) break;
    }

    expect(messagesAtAfterInvocation).toHaveLength(1);
    expect(messagesAtAfterInvocation[0]).not.toContain("secret-value");
    expect(
      JSON.stringify(threadAgent(agent, threadId)!.messages),
    ).not.toContain("secret-value");
    expect(JSON.stringify(persistedSnapshot(dir))).not.toContain(
      "secret-value",
    );
  });
});

describe("context forwarding through an orchestrator", () => {
  it("shows the context to each leaf agent's model and withdraws it again", async () => {
    const model = new ScriptedModel([modelTurn.text("short answer")]);
    const leaf = new Agent({ id: "writer", model, printer: false });
    const graph = new Graph({ nodes: [leaf], edges: [] });
    const agent = new StrandsAgent({
      agent: graph as never,
      name: "graph",
      config: { logger: quiet },
    });

    const events = await collect(
      agent,
      contextRun([{ description: "selected invoice", value: "123" }], {
        content: "which invoice?",
      }),
    );

    expectCompletedRun(events);
    expect(modelSawTexts(model, 0)).toEqual([
      blockOf("- selected invoice: 123"),
      "which invoice?",
    ]);
    expect(JSON.stringify(leaf.messages)).not.toContain(HEADER);
  });

  it("prefixes the prompt when the orchestrator exposes no leaf to hook", async () => {
    const prompts: string[] = [];
    const bare = {
      id: "bare",
      // No `model` field: this is the orchestrator code path. No `nodes`
      // either, so there is nothing to install a hook on.
      async *stream(input: string) {
        prompts.push(input);
      },
    };
    const agent = new StrandsAgent({ agent: bare as never, name: "bare" });

    await collect(
      agent,
      contextRun([{ description: "account", value: "premium" }]),
    );
    await collect(agent, contextRun([]));

    expect(prompts).toEqual([
      `${blockOf("- account: premium")}\n\nhello`,
      "hello",
    ]);
  });
});

describe("A2UI render-guide exclusion", () => {
  const renderGuide = a2uiRenderGuideDescription("render_a2ui");

  it("spells the middleware's marker exactly as the Python bridge does", () => {
    expect(renderGuide).toBe(
      "A2UI render tool usage guide — how to call render_a2ui with valid arguments.",
    );
  });

  it("drops only the guides for the tools that were replaced", () => {
    const kept = withoutA2UIRenderGuides(
      [
        { description: renderGuide, value: "stale" },
        { description: "user_id", value: "u-42" },
        {
          description: a2uiRenderGuideDescription("other_tool"),
          value: "keep",
        },
      ],
      ["render_a2ui"],
    );
    expect(kept.map((entry) => entry.value)).toEqual(["u-42", "keep"]);
  });

  it("narrows the subagent's context the same way", () => {
    const state = buildA2UISubagentState(
      minimalRunInput({
        state: { plan: "x" },
        context: [
          { description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: "schema" },
          { description: renderGuide, value: "stale" },
          { description: "user_id", value: "u-42" },
        ],
      }),
      ["render_a2ui"],
    );
    expect(state).toEqual({
      plan: "x",
      "ag-ui": {
        context: [{ description: "user_id", value: "u-42" }],
        a2ui_schema: "schema",
      },
    });
  });

  it("keeps the guide out of the model block once generate_a2ui is injected", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")], {
      config: { logger: quiet },
    });

    const events = await collect(
      agent,
      contextRun(
        [
          { description: renderGuide, value: "stale guide" },
          { description: "user_id", value: "u-42" },
        ],
        { forwardedProps: { injectA2UITool: true } },
      ),
    );

    expectCompletedRun(events);
    expect(modelSawTexts(model, 0)).toEqual([
      blockOf("- user_id: u-42"),
      "hello",
    ]);
  });

  it("keeps the guide in the model block when nothing was injected", async () => {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")]);

    const events = await collect(
      agent,
      contextRun([
        { description: renderGuide, value: "live guide" },
        { description: "user_id", value: "u-42" },
      ]),
    );

    expectCompletedRun(events);
    expect(modelSawTexts(model, 0)).toEqual([
      blockOf(`- ${renderGuide}: live guide`, "- user_id: u-42"),
      "hello",
    ]);
  });
});

describe("provider-bound ordering during a tool continuation", () => {
  // Strands carries a tool result in a message whose role is `user`, so the
  // turn the block would naturally join during a continuation is the one
  // answering a tool call. Both provider families refuse that, for different
  // reasons, and neither refusal shows up in the native history: the
  // OpenAI-compatible formatters emit a turn's non-tool content as its own
  // `user` message ahead of the `tool` messages they append, whatever order
  // the blocks sit in; and the block-level formatters map messages one to one,
  // so a separate context turn beside the results repeats a role.

  it("still has every tool call answered immediately", async () => {
    const turns = await continuationTurns(
      [{ description: "selected invoice", value: "123" }],
      { parallel: true },
    );

    await expectToolCallsAnsweredImmediately(turns);
    expect(openAIRoleSequence(await openAIChatRequestMessages(turns))).toEqual([
      "user",
      "assistant(tool_calls=t1,t2)",
      "tool(t1)",
      "tool(t2)",
    ]);
  });

  it("still alternates roles for the block-level formatters", async () => {
    const turns = await continuationTurns(
      [{ description: "selected invoice", value: "123" }],
      { parallel: true },
    );

    await expectRolesAlternate(turns);
  });

  it("does not change the provider-bound sequence at all", async () => {
    // A/B control: the same continuation with no context and with one entry.
    // The sequence is what the provider validates, so a fix that keeps it
    // identical cannot reintroduce the rejection for any entry count.
    const without = await continuationTurns([], { parallel: true });
    const withContext = await continuationTurns(
      [{ description: "selected invoice", value: "123" }],
      { parallel: true },
    );

    expect(
      openAIRoleSequence(await openAIChatRequestMessages(withContext)),
    ).toEqual(openAIRoleSequence(await openAIChatRequestMessages(without)));
  });

  it("does not change the Responses-API item sequence either", async () => {
    // The SDK's default OpenAI mode is the Responses API, which splits tool
    // calls and results into their own `input` items and pushes a message's
    // content ahead of both. So it needs its own control, not the Chat one.
    const without = await continuationTurns([], { parallel: true });
    const withContext = await continuationTurns(
      [{ description: "selected invoice", value: "123" }],
      { parallel: true },
    );

    expect(await openAIResponsesRequestItems(withContext)).toEqual(
      await openAIResponsesRequestItems(without),
    );
  });
});

describe("a tool continuation carrying context finishes the run", () => {
  /**
   * A model boundary that enforces the rule the provider enforces.
   *
   * The real formatter decides the request, and OpenAI rejects one whose
   * assistant `tool_calls` message is not answered immediately. Throwing the
   * provider's own message here reproduces the reported failure end to end
   * offline: the bridge turns a throw out of `agent.stream()` into a terminal
   * RUN_ERROR under `STRANDS_FORCE_STOP`, which is what the run died of. It
   * stands in for the rule the provider applies, not for a live provider run.
   */
  class ProviderRuleModel extends ScriptedModel {
    static readonly PROVIDER_400 =
      "An assistant message with 'tool_calls' must be followed by tool " +
      "messages responding to each 'tool_call_id'";

    override async *stream(
      messages: StrandsMessage[],
      options?: Parameters<ScriptedModel["stream"]>[1],
    ) {
      const formatted = await openAIChatRequestMessages(messages);
      const sequence = openAIRoleSequence(formatted);
      formatted.forEach((message, index) => {
        const calls = message.tool_calls;
        if (!calls || calls.length === 0) return;
        const answers = sequence.slice(index + 1, index + 1 + calls.length);
        const expected = calls.map((call) => `tool(${call.id})`);
        if (answers.join("|") !== expected.join("|")) {
          throw new Error(ProviderRuleModel.PROVIDER_400);
        }
      });
      yield* super.stream(messages, options);
    }
  }

  it("ends on RUN_FINISHED with no forced stop", async () => {
    // The run-level symptom: the tool call and its result are already on the
    // wire when the provider rejects the continuation, so the UI shows a
    // healthy tool card while the run terminates. Only the terminal event
    // tells the two apart, which is why this asserts on it rather than on what
    // was rendered.
    const lookup = tool({
      name: "lookup",
      description: "d",
      inputSchema: z.object({}).passthrough(),
      callback: async () => ({ invoice: 42 }),
    });
    const model = new ProviderRuleModel([
      modelTurn.toolUse({ toolUseId: "t1", name: "lookup", input: {} }),
      modelTurn.text("done"),
    ]);
    const { agent } = realStrandsAgent([], { tools: [lookup], model });

    const events = await collect(
      agent,
      contextRun([{ description: "selected invoice", value: "123" }]),
    );

    expect(errorCodes(events)).toEqual([]);
    expectCompletedRun(events);
    expect(
      model.seenMessages.length,
      "the continuation call never happened",
    ).toBe(2);
  });
});

describe("provider-bound ordering for an ordinary turn", () => {
  // The plain path is the default one and has to survive the same two checks
  // as a continuation. It used to place the block as its own user message next
  // to the question, which reads fine as native history and is two
  // consecutive user messages once a block-level formatter maps it one to one.

  const stale: AguiMessage[] = [
    { id: "u1", role: "user", content: "selected invoice 456" },
    { id: "a1", role: "assistant", content: "noted" },
    { id: "u2", role: "user", content: "which invoice is selected?" },
  ] as AguiMessage[];

  async function ordinaryTurn(context: ContextEntry[]) {
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")]);
    const events = await collect(
      agent,
      contextRun(context, { messages: stale }),
    );
    expectCompletedRun(events);
    return model.seenMessages[0]!;
  }

  it("still alternates roles for the block-level formatters", async () => {
    await expectRolesAlternate(
      await ordinaryTurn([{ description: "selected invoice", value: "123" }]),
    );
  });

  it("does not change the provider-bound sequence at all", async () => {
    const without = await ordinaryTurn([]);
    const withContext = await ordinaryTurn([
      { description: "selected invoice", value: "123" },
    ]);

    expect(
      openAIRoleSequence(await openAIChatRequestMessages(withContext)),
    ).toEqual(openAIRoleSequence(await openAIChatRequestMessages(without)));
    expect(
      (await anthropicRequestMessages(withContext)).map((m) => m.role),
    ).toEqual((await anthropicRequestMessages(without)).map((m) => m.role));
  });
});

describe("context placement with no question turn", () => {
  it("appends a trailing turn when nothing in the history can host the block", async () => {
    // No user turn at all, so there is no question to join and the history
    // ends on an assistant turn. A new trailing user turn both alternates and
    // sits closest to the generation it informs. Mutating the placement to the
    // head instead leaves this red.
    const { agent, model } = realStrandsAgent([modelTurn.text("ok")]);

    const events = await collect(
      agent,
      contextRun([{ description: "locale", value: "en-US" }], {
        messages: [
          { id: "a1", role: "assistant", content: "anything else?" },
        ] as AguiMessage[],
      }),
    );

    expectCompletedRun(events);
    const seen = model.seenMessages[0]!;
    expect(historyShape(seen)).toEqual([
      { role: "assistant", blocks: ["textBlock"] },
      { role: "user", blocks: ["textBlock"] },
    ]);
    expect(modelSawTexts(model, 0)).toEqual([
      "anything else?",
      blockOf("- locale: en-US"),
    ]);
    await expectRolesAlternate(seen);
  });

  it("gives a replayed tool exchange the block as its opening turn", async () => {
    const { agent, model } = toolContinuationAgent();
    const events = await collect(
      agent,
      contextRun([{ description: "locale", value: "en-US" }], {
        // No user question on the wire, only the exchange, which is the cold
        // continuation the opt-out replays.
        messages: [
          {
            id: "a1",
            role: "assistant",
            toolCalls: [
              {
                id: "t1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          { id: "m1", role: "tool", content: "42", toolCallId: "t1" },
        ] as AguiMessage[],
      }),
    );

    expectCompletedRun(events);
    const seen = model.seenMessages[0]!;
    expect(historyShape(seen)[0]).toEqual({
      role: "user",
      blocks: ["textBlock"],
    });
    await expectToolCallsAnsweredImmediately(seen);
    await expectRolesAlternate(seen);
  });
});

describe("the model-bound history outline", () => {
  const toolUse = (id: string) => ({
    toolUse: { toolUseId: id, name: "a", input: {} },
  });
  const toolResult = (id: string) => ({
    toolResult: { toolUseId: id, content: [{ text: "r" }] },
  });
  const turn = (role: "user" | "assistant", content: unknown[]) =>
    StrandsMessage.fromMessageData({ role, content: content as never });

  it("renders the sequence the real formatter builds", async () => {
    // A diagnostic describing a request the provider never saw is worse than
    // none, so the whole line is pinned against the formatter.
    const turns = await continuationTurns(
      [{ description: "selected invoice", value: "123" }],
      { parallel: true },
    );
    const sequence = openAIRoleSequence(await openAIChatRequestMessages(turns));

    expect(describeModelBoundHistory(turns).replace(/\[[^\]]*\]/g, "")).toBe(
      sequence.join(" -> "),
    );
  });

  it("makes a wedged message visible in the line", () => {
    // The whole point: the reader sees the break without re-deriving it. Same
    // line the Python bridge emits for the same history.
    expect(
      describeModelBoundHistory([
        turn("user", [{ text: "q" }]),
        turn("assistant", [toolUse("t1")]),
        turn("user", [{ text: "ctx" }, toolResult("t1")]),
      ]),
    ).toBe("user[text] -> assistant(tool_calls=t1) -> user[text] -> tool(t1)");
  });

  it("keeps a tool id carrying punctuation intact", () => {
    const weird = "a,b)c";

    expect(
      describeModelBoundHistory([
        turn("assistant", [toolUse(weird)]),
        turn("user", [toolResult(weird)]),
      ]),
    ).toBe(`assistant(tool_calls=${weird}) -> tool(${weird})`);
  });

  it("treats a block naming a call with nothing in it as a tool block", () => {
    // Placement reads the same predicate, so the two cannot disagree about a
    // block's kind. Python pins the placement half via `_carries_tool_result`.
    // A plain object, not a `Message`: the SDK's own constructor rejects this
    // shape, so it can only arrive as the wrapped-data form the outline and
    // the placement predicate both have to read the same way.
    expect(
      describeModelBoundHistory([
        { role: "user", content: [{ toolResult: undefined }] },
      ]),
      // `<none>`, not the word undefined: two unrelated malformed blocks must
      // not read as a matched call and answer.
    ).toBe("tool(<none>)");
  });

  it("carries no message text", async () => {
    const turns = await continuationTurns([
      { description: "token", value: "s3cret" },
    ]);

    const outline = describeModelBoundHistory(turns);

    expect(outline).not.toContain("s3cret");
    expect(outline).not.toContain("hello");
  });

  it("is dropped by a later run that carries no context", async () => {
    // Per-thread agents are reused, so a stale outline would name another run.
    const { agent } = realStrandsAgent([
      modelTurn.text("one"),
      modelTurn.text("two"),
    ]);

    await collect(agent, contextRun([{ description: "locale", value: "en" }]));
    const instance = threadAgent(agent)!;
    expect(modelBoundHistoryOutline(instance)).not.toBe("unrecorded");

    await collect(agent, contextRun([], { content: "second question" }));

    expect(modelBoundHistoryOutline(instance)).toBe("unrecorded");
  });
});

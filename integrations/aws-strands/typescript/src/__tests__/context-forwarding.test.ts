/**
 * `RunAgentInput.context` must reach the model for one call and nowhere else.
 *
 * The block the application's context renders to is shown to the model from a
 * before-model-call hook and withdrawn from the after-hook, so these tests sit
 * at the real model boundary: a `ScriptedModel` records exactly the history the
 * SDK handed it, and the durable history, the `MESSAGES_SNAPSHOT` and the
 * session store are read back afterwards to prove the block stayed out of all
 * three. Mirrors the Python bridge's `tests/test_context_forwarding.py` case
 * for case, then covers the arms that file leaves to other suites: the
 * tool-result turn, cancellation, concurrent runs, orchestrators, the refusal
 * on an agent with no hook registry, and the A2UI render-guide exclusion.
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
  formatAguiContext,
  normalizeAguiContext,
} from "../model-context";
import {
  ScriptedModel,
  collect,
  errorCodes,
  expectCompletedRun,
  historyShape,
  historyTexts,
  minimalRunInput,
  modelSawShape,
  modelSawTexts,
  modelTurn,
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
  it("shows the context to the model immediately before the latest user turn and excludes the A2UI schema entry", async () => {
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
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "user", blocks: ["textBlock"] },
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
      { role: "user", blocks: ["textBlock"] },
      { role: "user", blocks: ["textBlock", "imageBlock"] },
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

  it("follows stale history but keeps the latest user turn byte-identical", async () => {
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
    // The turn the model routed on is the turn the client sent, unchanged.
    // Read from the model-call-time copy: the live array has since grown by
    // the answer. Only the role and the content are compared, because that is
    // all a provider is sent; the SDK is free to add bookkeeping fields to a
    // serialized message and does across releases.
    const seen = model.seenMessages[0]!;
    const latest = seen[seen.length - 1]!;
    expect(latest.role).toBe("user");
    expect(latest.toJSON().content).toEqual([
      { text: "which invoice is selected?" },
    ]);
    expect(historyTexts(threadAgent(agent)!.messages)).toEqual([
      "selected invoice 456",
      "noted",
      "which invoice is selected?",
      "ok",
    ]);
  });

  it("rides inside the latest user turn when that turn carries a tool result", async () => {
    const lookup = tool({
      name: "lookup",
      description: "d",
      inputSchema: z.object({}).passthrough(),
      callback: async () => ({ invoice: 42 }),
    });
    const { agent, model } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "t1", name: "lookup", input: {} }),
        modelTurn.text("done"),
      ],
      { tools: [lookup] },
    );

    const events = await collect(
      agent,
      contextRun([{ description: "selected invoice", value: "123" }]),
    );

    expectCompletedRun(events);
    // First call: the usual separate turn before the question.
    expect(modelSawShape(model, 0)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "user", blocks: ["textBlock"] },
    ]);
    // Second call: the latest user turn is the tool result, and a user
    // message between a toolUse and its toolResult is a shape providers
    // reject, so the block is prepended into that same turn instead.
    expect(modelSawShape(model, 1)).toEqual([
      { role: "user", blocks: ["textBlock"] },
      { role: "assistant", blocks: ["toolUseBlock"] },
      { role: "user", blocks: ["textBlock", "toolResultBlock"] },
    ]);
    expect(modelSawTexts(model, 1)[1]).toBe(blockOf("- selected invoice: 123"));
    // Withdrawn again: the durable tool-result turn is only the tool result.
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

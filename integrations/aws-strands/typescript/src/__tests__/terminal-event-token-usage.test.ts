/**
 * Provider-reported token usage on the terminal event.
 *
 * Strands reports usage per model invocation on `modelMetadataEvent`, and the
 * adapter aggregates those per `(provider, model)` onto RUN_FINISHED, onto the
 * interrupt-variant RUN_FINISHED, and onto a RUN_ERROR raised after a model
 * call already reported. The field is omitted entirely when nothing was
 * reported, so a consumer can tell "not measured" from "measured as nothing".
 *
 * Driven through the real SDK wherever the shape is what is under test: the
 * metadata event has to survive `Model.streamAggregated` and the agent loop to
 * reach the adapter at all, and a fabricated stream would assert the adapter's
 * arithmetic while assuming the channel it reads from.
 */

import { describe, expect, it } from "vitest";
import {
  Agent as StrandsAgentCore,
  BedrockModel as SdkBedrockModel,
  Graph,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  ModelMetadataEvent,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { EventType, type BaseEvent, type TokenUsage } from "@ag-ui/core";
import { RunErrorEventSchema, RunFinishedEventSchema } from "@ag-ui/core/schemas";

import { StrandsAgent } from "../agent";
import {
  strandsModelIdentity,
  tokenUsageFromStrandsUsage,
} from "../token-usage";
import {
  collect,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  recordingTool,
} from "./helpers";

/** The only keys an emitted entry may carry. Nothing content-bearing. */
const ALLOWED_USAGE_KEYS = new Set([
  "provider",
  "model",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "reasoningTokens",
  "cachedInputTokens",
]);

/** A provider metadata frame, as Strands yields it after the message stops. */
function metadataFrame(usage: Record<string, unknown>): ModelStreamEvent {
  return { type: "modelMetadataEvent", usage } as unknown as ModelStreamEvent;
}

function textTurn(
  text: string,
  usage?: Record<string, unknown>,
): ModelStreamEvent[] {
  const turn = modelTurn.text(text);
  return usage ? [...turn, metadataFrame(usage)] : turn;
}

function terminal(events: BaseEvent[]): BaseEvent {
  const last = events[events.length - 1];
  if (!last) throw new Error("the run emitted nothing");
  return last;
}

function usageOf(event: BaseEvent): TokenUsage[] | undefined {
  return (event as { usage?: TokenUsage[] }).usage;
}

describe("terminal-event token usage", () => {
  it("reports usage on a normal completion", async () => {
    const { agent } = realStrandsAgent([
      textTurn("done", { inputTokens: 12, outputTokens: 4, totalTokens: 16 }),
    ]);

    const events = await collect(agent);
    const finish = terminal(events);
    expect(finish.type).toBe(EventType.RUN_FINISHED);
    expect(usageOf(finish)).toEqual([
      {
        provider: undefined,
        // `ScriptedModel` is not one of the SDK's provider classes, so it gets
        // no provider label; its config's `modelId` is still read.
        model: "scripted-model",
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      },
    ]);
    // The emitted event has to validate, or the run's last event would be
    // rejected by every consumer.
    expect(RunFinishedEventSchema.safeParse(finish).success).toBe(true);
  });

  it("maps the cache-read count and drops the cache-write one", async () => {
    const { agent } = realStrandsAgent([
      textTurn("done", {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadInputTokens: 80,
        // No AG-UI slot. Folding it into another count would overstate that
        // count, so it is dropped.
        cacheWriteInputTokens: 20,
      }),
    ]);

    const usage = usageOf(terminal(await collect(agent)));
    expect(usage?.[0]?.cachedInputTokens).toBe(80);
    // Strands reports no reasoning-token count, so the field is never set.
    expect(usage?.[0]).not.toHaveProperty("reasoningTokens");
  });

  it("sums several model calls in one run per (provider, model)", async () => {
    const tool = recordingTool("noop");
    const { agent, model } = realStrandsAgent(
      [
        [
          ...modelTurn.toolUse({ toolUseId: "tu-1", name: "noop", input: {} }),
          metadataFrame({ inputTokens: 30, outputTokens: 6, totalTokens: 36 }),
        ],
        textTurn("done", { inputTokens: 50, outputTokens: 9, totalTokens: 59 }),
      ],
      { tools: [tool.tool] },
    );

    const usage = usageOf(terminal(await collect(agent)));
    expect(model.calls, "the run did not make two model calls").toBe(2);
    // One entry, because both calls went to the same model.
    expect(usage).toEqual([
      {
        provider: undefined,
        model: "scripted-model",
        inputTokens: 80,
        outputTokens: 15,
        totalTokens: 95,
      },
    ]);
  });

  it("carries the partial usage of a run that failed after a model call", async () => {
    const tool = recordingTool("noop");
    const { agent } = realStrandsAgent(
      [
        [
          ...modelTurn.toolUse({ toolUseId: "tu-1", name: "noop", input: {} }),
          metadataFrame({ inputTokens: 41, outputTokens: 7, totalTokens: 48 }),
        ],
        // Never reached: the second call throws before yielding.
        textTurn("unreachable"),
      ],
      { tools: [tool.tool], throwOnCall: 2 },
    );

    const error = terminal(await collect(agent));
    expect(error.type).toBe(EventType.RUN_ERROR);
    expect((error as { code?: string }).code).toBe("STRANDS_FORCE_STOP");
    expect(usageOf(error)).toEqual([
      {
        provider: undefined,
        model: "scripted-model",
        inputTokens: 41,
        outputTokens: 7,
        totalTokens: 48,
      },
    ]);
    expect(RunErrorEventSchema.safeParse(error).success).toBe(true);
  });

  it("drops a count above the wire ceiling and keeps the rest of the entry", async () => {
    const oversized = Number.MAX_SAFE_INTEGER + 1;
    const { agent } = realStrandsAgent([
      textTurn("done", {
        inputTokens: oversized,
        outputTokens: 7,
        totalTokens: oversized,
      }),
    ]);

    const finish = terminal(await collect(agent));
    expect(usageOf(finish)).toEqual([
      { provider: undefined, model: "scripted-model", outputTokens: 7 },
    ]);

    // What the guard is actually protecting, spelled out so the case above is
    // not mistaken for belt-and-braces. The generated `TokenUsageSchema` bounds
    // counts to the wire ceiling (the schema's `maximum`, 2^53 - 1), so an
    // oversized count on RUN_FINISHED is a MALFORMED known value — fatal at the
    // client's enforcement stage, ending the run over a number nobody can carry.
    // Dropping it at the source is what turns that into a run that finishes with
    // one count missing, and keeps the SSE and binary wires reporting the same
    // thing. This pins the premise: if the schema ever stops rejecting it, the
    // guard becomes belt-and-braces and this comment is wrong.
    expect(
      RunFinishedEventSchema.safeParse({
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "r",
        usage: [{ inputTokens: oversized }],
      }).success,
      "TokenUsageSchema no longer bounds counts; the guard is now belt-and-braces — revisit",
    ).toBe(false);
  });

  it("omits usage entirely when the provider reports none", async () => {
    const { agent } = realStrandsAgent([textTurn("done")]);

    const finish = terminal(await collect(agent));
    expect(finish.type).toBe(EventType.RUN_FINISHED);
    // Absent, not `[]` and not a zeroed entry: a consumer reads a missing
    // field as "not measured".
    expect(finish).not.toHaveProperty("usage");
  });

  it("omits usage when the metadata event carries no usable count", async () => {
    const { agent } = realStrandsAgent([
      // Every count unusable, and a labels-only entry is not usage.
      textTurn("done", {
        inputTokens: "12",
        outputTokens: -1,
        totalTokens: 1.5,
      }),
    ]);

    expect(terminal(await collect(agent))).not.toHaveProperty("usage");
  });

  it("does not let a second run inherit the first run's counts", async () => {
    const { agent } = realStrandsAgent([
      textTurn("first", { inputTokens: 10, outputTokens: 1, totalTokens: 11 }),
      textTurn("second", { inputTokens: 20, outputTokens: 2, totalTokens: 22 }),
    ]);

    const first = usageOf(terminal(await collect(agent)));
    const second = usageOf(
      terminal(await collect(agent, minimalRunInput({ runId: "run-2" }))),
    );

    expect(first?.[0]?.totalTokens).toBe(11);
    expect(second?.[0]?.totalTokens).toBe(22);
  });

  it("reports usage on the interrupt-variant RUN_FINISHED", async () => {
    const tool = recordingTool("approve_me");
    const { agent } = realStrandsAgent(
      [
        [
          ...modelTurn.toolUse({
            toolUseId: "tu-1",
            name: "approve_me",
            input: {},
          }),
          metadataFrame({ inputTokens: 33, outputTokens: 5, totalTokens: 38 }),
        ],
      ],
      {
        tools: [tool.tool],
        config: { toolBehaviors: { approve_me: { interruptOnCall: true } } },
      },
    );

    const finish = terminal(
      await collect(
        agent,
        minimalRunInput({
          messages: [{ id: "u1", role: "user", content: "go" } as never],
        }),
      ),
    );
    expect((finish as { outcome?: { type?: string } }).outcome?.type).toBe(
      "interrupt",
    );
    // An interrupted run is a finished run for usage purposes: the calls that
    // raised the interrupt were real.
    expect(usageOf(finish)?.[0]?.totalTokens).toBe(38);
    expect(RunFinishedEventSchema.safeParse(finish).success).toBe(true);
  });

  it("carries nothing beyond the allowed numeric and label keys", async () => {
    const { agent } = realStrandsAgent([
      textTurn("done", {
        inputTokens: 5,
        outputTokens: 6,
        totalTokens: 11,
        cacheReadInputTokens: 2,
        // Provider extras and anything content-bearing are never copied.
        latencyMs: 1234,
        prompt: "the user's question",
      }),
    ]);

    const usage = usageOf(terminal(await collect(agent)));
    expect(usage).toHaveLength(1);
    for (const key of Object.keys(usage![0]!)) {
      expect(ALLOWED_USAGE_KEYS, `unexpected key ${key}`).toContain(key);
    }
  });
});

/**
 * A `Model` that answers with one text block and then reports usage, used to
 * drive a real `Graph`.
 */
class UsageReportingModel extends Model {
  // Not `modelId`: the base `Model` exposes that as a getter, so a parameter
  // property of the same name fails at construction.
  constructor(
    private readonly id: string,
    private readonly usage: Record<string, unknown>,
  ) {
    super();
  }

  getConfig() {
    return { modelId: this.id };
  }

  updateConfig() {}

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield new ModelMessageStartEvent({
      type: "modelMessageStartEvent",
      role: "assistant",
    });
    yield new ModelContentBlockDeltaEvent({
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text: "answered" },
    });
    yield new ModelContentBlockStopEvent({
      type: "modelContentBlockStopEvent",
    });
    yield new ModelMessageStopEvent({
      type: "modelMessageStopEvent",
      stopReason: "endTurn",
    });
    yield new ModelMetadataEvent({
      type: "modelMetadataEvent",
      usage: this.usage as never,
    });
  }
}

describe("terminal-event token usage on the orchestrator path", () => {
  it("reports one entry per node model across a real Graph", async () => {
    const researcher = new StrandsAgentCore({
      id: "researcher",
      model: new UsageReportingModel("model-a", {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      }),
      printer: false,
    });
    const writer = new StrandsAgentCore({
      id: "writer",
      model: new UsageReportingModel("model-b", {
        inputTokens: 30,
        outputTokens: 4,
        totalTokens: 34,
      }),
      printer: false,
    });
    const graph = new Graph({
      nodes: [researcher, writer],
      edges: [["researcher", "writer"]],
    });
    const agent = new StrandsAgent({
      // A `Graph` is not an `Agent`; the adapter discriminates the two
      // structurally and the option type spells the narrower one.
      agent: graph as never,
      name: "usage-graph",
    });

    const finish = terminal(await collect(agent));
    expect(finish.type).toBe(EventType.RUN_FINISHED);
    // Separate entries, because a multi-model orchestrator run must not report
    // one node's spend against another node's model. Node identity reaches the
    // metadata event through the node's own `beforeModelCallEvent`.
    expect(usageOf(finish)).toEqual([
      {
        provider: undefined,
        model: "model-a",
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      {
        provider: undefined,
        model: "model-b",
        inputTokens: 30,
        outputTokens: 4,
        totalTokens: 34,
      },
    ]);
    expect(RunFinishedEventSchema.safeParse(finish).success).toBe(true);
  });

  it("sums repeat calls to one node's model into a single entry", async () => {
    const solo = new StrandsAgentCore({
      id: "solo",
      model: new UsageReportingModel("model-a", {
        inputTokens: 7,
        outputTokens: 1,
        totalTokens: 8,
      }),
      printer: false,
    });
    const graph = new Graph({ nodes: [solo], edges: [] });
    const agent = new StrandsAgent({
      agent: graph as never,
      name: "usage-graph",
    });

    const first = usageOf(terminal(await collect(agent)));
    expect(first).toEqual([
      {
        provider: undefined,
        model: "model-a",
        inputTokens: 7,
        outputTokens: 1,
        totalTokens: 8,
      },
    ]);
    // A second orchestrator run starts from nothing, same as the single-agent
    // path.
    const second = usageOf(
      terminal(await collect(agent, minimalRunInput({ runId: "run-2" }))),
    );
    expect(second?.[0]?.totalTokens).toBe(8);
  });
});

/**
 * A stand-in model whose class NAME is the thing the provider table is keyed
 * on, with the config reader the caller supplies.
 *
 * Built through a computed key rather than a `class` declaration because the
 * bundler renames a declaration that shadows an import, which would silently
 * defeat a lookup keyed on the name. Stand-ins rather than the real classes
 * because four of the five provider modules pull in an OPTIONAL peer this
 * package does not depend on.
 */
function modelNamed(className: string, getConfig?: () => unknown): unknown {
  const cls = {
    [className]: class {
      getConfig = getConfig;
    },
  }[className]!;
  return new cls();
}

describe("Strands model labelling", () => {
  /**
   * The canonical provider label per Strands model class.
   *
   * The Python bridge maps its own class names onto these same values, so a
   * change here is a wire-contract change that has to land on both bridges
   * together. `google` covers this SDK's `GoogleModel` and the Python SDK's
   * `GeminiModel`: one provider, one label.
   *
   */
  const CANONICAL_LABELS: [string, string][] = [
    ["AnthropicModel", "anthropic"],
    ["BedrockModel", "bedrock"],
    ["GoogleModel", "google"],
    ["OpenAIModel", "openai"],
    ["VercelModel", "vercel"],
  ];

  it.each(CANONICAL_LABELS)("labels %s as %s", (className, provider) => {
    expect(
      strandsModelIdentity(
        modelNamed(className, () => ({ modelId: "the-model" })),
      ),
    ).toEqual({ provider, model: "the-model" });
  });

  it("keys the table on the names the SDK actually ships", () => {
    // The one provider class importable without an optional peer. If the SDK
    // renames it, this fails rather than silently dropping the label.
    expect(SdkBedrockModel.name).toBe("BedrockModel");
  });

  it("omits the provider label for a class the table does not name", () => {
    expect(
      strandsModelIdentity(
        modelNamed("HomegrownModel", () => ({ modelId: "mine" })),
      ),
    ).toEqual({ model: "mine" });
  });

  it("omits the model label rather than failing when the config cannot be read", () => {
    expect(
      strandsModelIdentity(
        modelNamed("BedrockModel", () => {
          throw new Error("config unavailable");
        }),
      ),
    ).toEqual({ provider: "bedrock" });

    // A config that is not a mapping labels nothing rather than guessing, and
    // neither does a model with no readable config at all.
    expect(
      strandsModelIdentity(modelNamed("OpenAIModel", () => "not-a-config")),
    ).toEqual({ provider: "openai" });
    expect(strandsModelIdentity(modelNamed("VercelModel"))).toEqual({
      provider: "vercel",
    });
  });

  it("labels nothing for a model that is not an object", () => {
    expect(strandsModelIdentity(undefined)).toEqual({});
    expect(strandsModelIdentity(null)).toEqual({});
    expect(strandsModelIdentity("bedrock")).toEqual({});
  });
});

describe("Strands usage guard", () => {
  it("accepts a real, finite, non-negative whole number", () => {
    expect(
      tokenUsageFromStrandsUsage({
        inputTokens: 0,
        outputTokens: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER });
  });

  it.each([
    ["a string", "12"],
    ["undefined", undefined],
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative", -1],
    ["a fraction", 1.5],
    ["a boolean", true],
    ["an oversized integer", Number.MAX_SAFE_INTEGER + 1],
  ])("drops %s while keeping the rest of the entry", (_label, bad) => {
    expect(
      tokenUsageFromStrandsUsage({ inputTokens: bad, outputTokens: 3 }),
    ).toEqual({ outputTokens: 3 });
  });

  it("returns nothing when no count survives, labels notwithstanding", () => {
    expect(
      tokenUsageFromStrandsUsage(
        { inputTokens: "12" },
        { provider: "bedrock", model: "m" },
      ),
    ).toBeUndefined();
    expect(tokenUsageFromStrandsUsage(undefined)).toBeUndefined();
    expect(tokenUsageFromStrandsUsage({})).toBeUndefined();
  });
});

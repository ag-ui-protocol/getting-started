/**
 * Contracts the dojo depends on from the example demos.
 *
 * The dojo's code panel shows a demo's file under `server/api/` while
 * `server/server.ts` is what answers the request, so anything the browser
 * reads out of a demo has to be pinned somewhere both of them are bound by.
 * These tests pin it at the factory, which is the only definition of each
 * agent.
 *
 * `@strands-agents/sdk/models/openai` is mocked, and the mock RECORDS the
 * options it was built with, because which OpenAI API a demo asks for decides
 * whether its predict-state mapping streams at all.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

const builtModels = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("@strands-agents/sdk/models/openai", () => ({
  OpenAIModel: class {
    constructor(options: Record<string, unknown>) {
      builtModels.push(options);
    }
  },
}));

import { DEMOS, createDojoApp } from "./server";
import { getWeather, renderChart } from "./api/backend-tool-rendering";
import {
  createAgenticGenerativeUIAgent,
  fallbackSteps,
  generativeUIConfig,
  normalizeSteps,
  planTaskSteps,
} from "./api/agentic-generative-ui";
import {
  createSharedStateAgent,
  generateRecipe,
  sharedStateConfig,
} from "./api/shared-state";
import { predictiveStateConfig } from "./api/predictive-state-updates";
import { SYSTEM_PROMPT as HUMAN_IN_THE_LOOP_PROMPT } from "./api/human-in-the-loop";
import { SYSTEM_PROMPT as AGENTIC_CHAT_PROMPT } from "./api/agentic-chat";
import {
  createAgenticChatReasoningAgent,
  SYSTEM_PROMPT as REASONING_PROMPT,
} from "./api/agentic-chat-reasoning";
import { toolCallContext, toolResultContext, runAgentInput } from "./fixtures";
import type { PredictStateMapping } from "@ag-ui/aws-strands";

beforeEach(() => {
  builtModels.length = 0;
});

/**
 * The paths `apps/dojo/src/agents.ts` maps for the `aws-strands-typescript`
 * integration, copied because the dojo is a separate package. A copy cannot
 * notice the dojo adding a path on its own; what it does catch is this server
 * dropping or renaming one, which is the direction that takes a demo off air.
 */
const DOJO_PATHS = [
  "a2ui-dynamic-schema",
  "a2ui-fixed-schema",
  "a2ui-recovery",
  "agentic-chat",
  "agentic-chat-multimodal",
  "agentic-chat-reasoning",
  "agentic-generative-ui",
  "backend-tool-rendering",
  "human-in-the-loop",
  "interrupt",
  "multi-agent",
  "predictive-state-updates",
  "shared-state",
  "tool-based-generative-ui",
];

/**
 * The predict-state mappings as a list.
 *
 * The field is typed to accept any iterable, so it cannot simply be indexed.
 */
function mappings(behavior: {
  predictState?: PredictStateMapping | Iterable<PredictStateMapping>;
}): PredictStateMapping[] {
  const declared = behavior.predictState;
  if (!declared) return [];
  return Symbol.iterator in declared
    ? [...(declared as Iterable<PredictStateMapping>)]
    : [declared as PredictStateMapping];
}

/** Collapse runs of whitespace so an assertion survives a prompt being rewrapped. */
function unwrapped(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** JSON Schema properties the tool advertises to the model. */
function inputProperties(tool: { toolSpec: unknown }): Record<string, unknown> {
  const spec = tool.toolSpec as {
    inputSchema?: { properties?: Record<string, unknown> };
  };
  return spec.inputSchema?.properties ?? {};
}

function stubProviderEnv(): () => void {
  // Both matter. Without a key the OpenAI branch refuses to build a model at
  // all; without pinning the provider, an ambient MODEL_PROVIDER routes every
  // factory past the mock above and into a real client.
  vi.stubEnv("MODEL_PROVIDER", "openai");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  return () => vi.unstubAllEnvs();
}

describe("dojo demo mount table", () => {
  beforeAll(stubProviderEnv);

  it("mounts exactly the paths the dojo asks for", () => {
    expect(Object.keys(DEMOS).sort()).toEqual([...DOJO_PATHS].sort());
  });

  it("puts each path's own agent behind it", async () => {
    // Asserted first so an empty or truncated table fails here rather than
    // passing a loop that never runs.
    expect(Object.keys(DEMOS)).toHaveLength(DOJO_PATHS.length);

    for (const [path, createAgent] of Object.entries(DEMOS)) {
      const agent = await createAgent();
      expect(agent.name, `agent mounted at /${path}`).toBe(
        path.replace(/-/g, "_"),
      );
    }
  });

  it("answers on both the slashed and unslashed spelling of every path", async () => {
    const app = await createDojoApp();
    const server = await new Promise<import("node:http").Server>(
      (ready, fail) => {
        // Port 0 so this cannot collide, and the readiness check is
        // `listening` rather than the callback firing: express runs that
        // callback on a failed bind too, and passes it the error.
        const s = app.listen(0, "127.0.0.1", (error?: unknown) => {
          if (error) fail(error);
          else if (!s.listening)
            fail(new Error("listen reported no error but is not listening"));
          else ready(s);
        });
        s.on("error", fail);
      },
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error(`expected a bound TCP address, got ${String(address)}`);
    }
    const { port } = address as AddressInfo;

    try {
      for (const path of DOJO_PATHS) {
        for (const url of [
          `http://127.0.0.1:${port}/${path}`,
          `http://127.0.0.1:${port}/${path}/`,
        ]) {
          // POST a payload the endpoint rejects, and pin the rejection: the
          // adapter answers an unusable RunAgentInput with 400. Accepting
          // anything-but-404 would also pass on an app that 500s everywhere.
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          expect(response.status, url).toBe(400);
        }
      }
      expect((await fetch(`http://127.0.0.1:${port}/ping`)).status).toBe(200);
      expect(
        (await fetch(`http://127.0.0.1:${port}/capabilities`)).status,
      ).toBe(200);

      // Negative control: without it a catch-all mount would satisfy every
      // assertion above.
      for (const missing of ["/nope", "/agentic-chat/extra"]) {
        const response = await fetch(`http://127.0.0.1:${port}${missing}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(response.status, missing).toBe(404);
      }
    } finally {
      // Keep-alive sockets from fetch would otherwise hold close() open.
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 60_000);
});

describe("backend-tool-rendering weather card contract", () => {
  it("keeps the tool names the dojo page matches on", () => {
    // The page registers renderers by name, so these strings are as
    // load-bearing as the fields below.
    expect(getWeather.name).toBe("get_weather");
    expect(renderChart.name).toBe("render_chart");
  });

  it("takes the argument the card labels itself with", () => {
    expect(Object.keys(inputProperties(getWeather))).toEqual(["location"]);
  });

  it("returns every field the card reads, populated", async () => {
    // Both ends of the random range pinned: the conditions index is computed,
    // and an off-by-one there yields `undefined` on only some runs.
    const random = vi.spyOn(Math, "random");
    try {
      for (const roll of [0, 0.999999]) {
        random.mockReturnValue(roll);
        const sample = (await getWeather.invoke({
          location: "San Francisco",
        })) as Record<string, unknown>;
        expect(typeof sample.conditions, `random=${roll}`).toBe("string");
      }
    } finally {
      random.mockRestore();
    }

    const weather = (await getWeather.invoke({
      location: "San Francisco",
    })) as Record<string, unknown>;

    expect(Object.keys(weather).sort()).toEqual([
      "conditions",
      "feels_like",
      "humidity",
      "temperature",
      "wind_speed",
    ]);
    // Values, not just keys: an off-by-one on the conditions index would leave
    // `undefined` behind and still satisfy a key-name check.
    expect(typeof weather.conditions).toBe("string");
    for (const key of ["temperature", "humidity", "wind_speed", "feels_like"]) {
      expect(typeof weather[key], key).toBe("number");
    }
  });

  it("takes the chart arguments the Python reference declares", () => {
    expect(Object.keys(inputProperties(renderChart)).sort()).toEqual([
      "chart_type",
      "data",
    ]);
  });

  it("returns the chart fields the Python reference returns", async () => {
    expect(
      await renderChart.invoke({ chart_type: "bar", data: "1,2,3" }),
    ).toEqual({ chart_type: "bar", data: "1,2,3", status: "rendered" });
  });

  it("truncates chart data at a hundred characters", async () => {
    const result = (await renderChart.invoke({
      chart_type: "bar",
      data: "x".repeat(150),
    })) as { data: string };

    expect(result.data).toHaveLength(100);
  });
});

describe("agentic-generative-ui plans", () => {
  const behavior = generativeUIConfig.toolBehaviors!.plan_task_steps!;

  beforeAll(() => {
    // The tool sleeps between status transitions to make progress visible in
    // the UI, which would otherwise put seconds of real waiting in this file.
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("keeps the tool name its behaviour is keyed by", () => {
    // The config key, the tool's own name, and the predict-state mapping all
    // have to agree or the mapping silently applies to nothing.
    expect(planTaskSteps.name).toBe("plan_task_steps");
    expect(Object.keys(generativeUIConfig.toolBehaviors!)).toEqual([
      planTaskSteps.name,
    ]);
    expect(mappings(behavior).map((m) => m.tool)).toEqual([planTaskSteps.name]);
  });

  it("streams an argument the tool actually declares", () => {
    const [mapping] = mappings(behavior);
    expect(mapping!.stateKey).toBe("steps");
    expect(Object.keys(inputProperties(planTaskSteps))).toContain(
      mapping!.toolArgument,
    );
  });

  it("plans something when the model supplies no steps", async () => {
    const invocation = planTaskSteps.invoke({
      task: "ship the demo",
      context: "",
      steps: [],
    });
    await vi.runAllTimersAsync();
    const result = (await invocation) as { steps: { status: string }[] };

    expect(result.steps).toHaveLength(6);
    expect(result.steps.every((step) => step.status === "completed")).toBe(
      true,
    );
  });

  it("plans something when the model omits the steps argument", async () => {
    // Reachable only because the schema marks `steps` optional. A required
    // array fails validation before the callback runs and the fallback is
    // never asked.
    const invocation = planTaskSteps.invoke({ task: "ship the demo" } as never);
    await vi.runAllTimersAsync();
    const result = (await invocation) as { steps: unknown[] };

    expect(result.steps).toHaveLength(6);
  });

  it("accepts the loose step shapes the Python reference accepts", async () => {
    const invocation = planTaskSteps.invoke({
      task: "dig",
      context: "",
      steps: [
        "Dig hole",
        { description: "Open door" },
        { description: 42 },
        { junk: true },
        { description: "  " },
        "",
      ],
    } as never);
    await vi.runAllTimersAsync();
    const result = (await invocation) as {
      steps: { description: string; status: string }[];
    };

    // Bare strings, status-less objects and a non-string description are all
    // kept, the last coerced the way Python's `str()` coerces it, and none of
    // it errors the call. Blank descriptions are dropped, which is stricter
    // than Python on purpose: it keeps them, and they render as empty rows.
    expect(result.steps.map((step) => step.description)).toEqual([
      "Dig hole",
      "Open door",
      "42",
    ]);
  });

  it("keeps a status the model supplied rather than resetting it", async () => {
    // Not just that a status exists: normalization defaults a missing one to
    // pending, and hard-coding that default would keep every other assertion
    // green while losing whatever the model said.
    const steps = normalizeSteps([
      { description: "Packing", status: "in_progress" },
      { description: "Sealing" },
    ]);

    expect(steps).toEqual([
      { description: "Packing", status: "in_progress" },
      { description: "Sealing", status: "pending" },
    ]);
  });

  it("advertises steps as an optional array, the way Python does", () => {
    // Both halves matter. Without the array type the model is told nothing
    // about the shape; without being absent from `required` it cannot omit the
    // argument, which is the path to the fallback plan.
    const schema = planTaskSteps.toolSpec.inputSchema as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };

    expect(schema.properties.steps?.type).toBe("array");
    expect(schema.required).not.toContain("steps");
    // `context` too: Python advertises `task` as the only required argument.
    expect(schema.required).toEqual(["task"]);
  });

  it("defaults to six steps when the context names no count", () => {
    expect(fallbackSteps("ship the demo", "")).toHaveLength(6);
  });

  it("honours a step count named in the context", () => {
    expect(fallbackSteps("ship the demo", "make it 4 steps")).toHaveLength(4);
  });

  it("clamps a step count outside the supported range", () => {
    expect(fallbackSteps("ship the demo", "1 step")).toHaveLength(4);
    expect(fallbackSteps("ship the demo", "40 steps")).toHaveLength(10);
  });

  it("repeats a template past the eighth step", () => {
    // Not an aspiration, a record: the template list holds eight entries and
    // the clamp allows ten, so nine and ten wrap. The Python reference wraps at
    // the same point, and this pins the shared behaviour rather than implying
    // the descriptions are distinct.
    const plan = fallbackSteps("ship the demo", "10 steps");
    expect(plan).toHaveLength(10);
    expect(new Set(plan.map((step) => step.description)).size).toBe(8);
  });

  it("records no plan rather than an empty one", async () => {
    await expect(
      behavior.stateFromResult!(
        toolResultContext({ resultData: { steps: [] } }),
      ),
    ).resolves.toBeNull();
  });

  it("records the plan the tool finished with, normalized", async () => {
    await expect(
      behavior.stateFromResult!(
        toolResultContext({ resultData: { steps: ["Packing"] } }),
      ),
    ).resolves.toEqual({
      steps: [{ description: "Packing", status: "pending" }],
    });
  });

  it("lets the model plan again after an empty plan reaches state", () => {
    const build = generativeUIConfig.stateContextBuilder!;

    expect(build(runAgentInput({ steps: [] }), "plan my move")).toBe(
      "plan my move",
    );
    expect(
      build(runAgentInput({ steps: [{ description: "Packing" }] }), "and?"),
    ).toContain("A plan is already in progress");
  });

  it("asks for the API that can stream its arguments", async () => {
    const restore = stubProviderEnv();
    try {
      await createAgenticGenerativeUIAgent();
      expect(builtModels).toHaveLength(1);
      expect(builtModels[0]).toMatchObject({ api: "chat" });
    } finally {
      restore();
    }
  });
});

describe("shared-state recipe contract", () => {
  const behavior = sharedStateConfig.toolBehaviors!.generate_recipe!;

  it("keeps the tool name its behaviour is keyed by", () => {
    expect(generateRecipe.name).toBe("generate_recipe");
    expect(Object.keys(sharedStateConfig.toolBehaviors!)).toEqual([
      generateRecipe.name,
    ]);
    expect(mappings(behavior).map((m) => m.tool)).toEqual([
      generateRecipe.name,
    ]);
  });

  it("streams an argument the tool actually declares", () => {
    const [mapping] = mappings(behavior);
    expect(mapping!.stateKey).toBe("recipe");
    expect(Object.keys(inputProperties(generateRecipe))).toContain(
      mapping!.toolArgument,
    );
  });

  it("accepts an ingredient that is missing a field", async () => {
    // The card has already painted from the streamed arguments by the time the
    // call is validated, so rejecting a partial ingredient leaves the page
    // showing a recipe the agent then says it could not make.
    await expect(
      generateRecipe.invoke({
        recipe: {
          title: "Carrot Cake",
          skill_level: "Intermediate",
          special_preferences: [],
          cooking_time: "45 min",
          ingredients: [{ name: "Carrots" }],
          instructions: ["Grate the carrots"],
          changes: "",
        },
      } as never),
    ).resolves.toBe("Recipe updated successfully");
  });

  it("reads the recipe out of an object argument", async () => {
    const recipe = { title: "Carrot Cake" };

    await expect(
      behavior.stateFromArgs!(
        toolCallContext({
          toolName: generateRecipe.name,
          toolInput: { recipe },
        }),
      ),
    ).resolves.toEqual({ recipe });
  });

  it("reads a recipe whose value arrived as JSON text", async () => {
    const recipe = { title: "Carrot Cake" };

    await expect(
      behavior.stateFromArgs!(
        toolCallContext({
          toolName: generateRecipe.name,
          toolInput: { recipe: JSON.stringify(recipe) },
        }),
      ),
    ).resolves.toEqual({ recipe });
  });

  it("reads the recipe out of a JSON-string argument", async () => {
    const recipe = { title: "Carrot Cake" };

    await expect(
      behavior.stateFromArgs!(
        toolCallContext({ toolInput: JSON.stringify({ recipe }) }),
      ),
    ).resolves.toEqual({ recipe });
  });

  it("reads a recipe the model sent unwrapped", async () => {
    const recipe = { title: "Carrot Cake" };

    await expect(
      behavior.stateFromArgs!(toolCallContext({ toolInput: recipe })),
    ).resolves.toEqual({ recipe });
  });

  it("writes nothing rather than blanking the card", async () => {
    // Each of these used to reach state as a recipe and wipe the page: empty
    // arguments, an explicit null, and an object that is not a recipe at all.
    for (const toolInput of [
      {},
      { recipe: null },
      { unrelated: 1 },
      "not json",
    ]) {
      await expect(
        behavior.stateFromArgs!(toolCallContext({ toolInput })),
        JSON.stringify(toolInput),
      ).resolves.toBeNull();
    }
  });

  it("survives a state that is not an object at all", () => {
    // `RunAgentInput.state` is typed as any, so a client can send a primitive,
    // and `in` throws on those rather than returning false.
    const build = sharedStateConfig.stateContextBuilder!;

    for (const state of ["hello", 42, true, null]) {
      expect(build(runAgentInput(state), "hi"), JSON.stringify(state)).toBe(
        "hi",
      );
    }
  });

  it("leaves an ordinary message alone until the thread has a recipe", () => {
    const build = sharedStateConfig.stateContextBuilder!;

    // Keyed on presence, which is what Python checks, so a thread that has
    // never had a recipe keeps ordinary chat ordinary.
    expect(build(runAgentInput({}), "hello")).toBe("hello");
    expect(build(runAgentInput({ steps: [] }), "hello")).toBe("hello");
    expect(build(runAgentInput({ recipe: {} }), "hello")).toContain(
      "Current recipe state",
    );
    expect(
      build(runAgentInput({ recipe: { title: "Carrot Cake" } }), "add nuts"),
    ).toContain("Current recipe state");
  });

  it("asks for the API that can stream its arguments", async () => {
    const restore = stubProviderEnv();
    try {
      await createSharedStateAgent();
      expect(builtModels).toHaveLength(1);
      expect(builtModels[0]).toMatchObject({ api: "chat" });
    } finally {
      restore();
    }
  });
});

describe("predictive-state-updates document contract", () => {
  const behavior = predictiveStateConfig.toolBehaviors!.write_document!;

  it("keys its behaviour to the tool the page declares", () => {
    // `write_document` lives on the frontend, so there is no tool object here
    // to agree with; the dojo page's `useFrontendTool` name is the contract,
    // and the mapping has to name the same one.
    expect(Object.keys(predictiveStateConfig.toolBehaviors!)).toEqual([
      "write_document",
    ]);
    expect(mappings(behavior)).toEqual([
      {
        stateKey: "document",
        tool: "write_document",
        toolArgument: "document",
      },
    ]);
  });

  it("publishes the document the tool was called with", async () => {
    await expect(
      behavior.stateFromArgs!(
        toolCallContext({
          toolName: "write_document",
          toolInput: { document: "# Draft" },
        }),
      ),
    ).resolves.toEqual({ document: "# Draft" });
  });

  it("reads arguments that arrived as JSON text", async () => {
    await expect(
      behavior.stateFromArgs!(
        toolCallContext({
          toolName: "write_document",
          toolInput: JSON.stringify({ document: "# Draft" }),
        }),
      ),
    ).resolves.toEqual({ document: "# Draft" });
  });

  it("publishes nothing rather than something it cannot vouch for", async () => {
    // Each of these leaves the browser showing its own prediction with nothing
    // authoritative behind it, so the demo warns and declines.
    for (const toolInput of ["not json", 42, null, {}, { document: 42 }]) {
      await expect(
        behavior.stateFromArgs!(
          toolCallContext({ toolName: "write_document", toolInput }),
        ),
        JSON.stringify(toolInput),
      ).resolves.toBeNull();
    }
  });

  it("feeds an existing document back on the next turn", () => {
    const build = predictiveStateConfig.stateContextBuilder!;

    expect(build(runAgentInput({}), "write a poem")).toBe("write a poem");
    expect(build(runAgentInput({ document: "" }), "write a poem")).toBe(
      "write a poem",
    );
    expect(
      build(runAgentInput({ document: "# Draft" }), "add a verse"),
    ).toContain("# Draft");
  });
});

describe("prompts the dojo suites depend on", () => {
  it("tells the model what the human-in-the-loop page sends back", () => {
    // handleConfirm posts `{ accepted: true, steps }` with the disabled steps
    // removed; handleReject posts `{ accepted: false }` and no steps key. A
    // prompt that omits this reads back the model's own original list.
    const prompt = unwrapped(HUMAN_IN_THE_LOOP_PROMPT);
    expect(prompt).toContain('It always carries `"accepted": <bool>`');
    expect(prompt).toContain("When rejected there is no `steps` key at all");
    expect(prompt).toContain("SINGLE SOURCE OF TRUTH");
  });

  it("asks for the greeting the chat demos are supposed to give", () => {
    // What the end-to-end suites match is replayed fixture text, so they pass
    // whether or not the prompt asks for this. These clauses are the actual
    // instruction, they are what a real model would be following, and this
    // prompt is the only place they exist. The reasoning demo carries them for
    // parity with Python and has no suite checking them at all.
    for (const prompt of [AGENTIC_CHAT_PROMPT, REASONING_PROMPT]) {
      expect(unwrapped(prompt)).toContain(
        'Your greeting should always start with "Hello"',
      );
      expect(unwrapped(prompt)).toContain(
        'always ask (exact wording) "how can I assist you?"',
      );
    }
  });

  it("asks the reasoning demo for the API that returns reasoning", async () => {
    const restore = stubProviderEnv();
    try {
      await createAgenticChatReasoningAgent();
      expect(builtModels).toHaveLength(1);
      expect(builtModels[0]).toMatchObject({ api: "responses" });
      expect(builtModels[0]).toHaveProperty("params.reasoning");
    } finally {
      restore();
    }
  });
});

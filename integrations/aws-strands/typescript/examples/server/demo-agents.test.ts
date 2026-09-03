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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  "agentic-chat-citations",
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

// ---------------------------------------------------------------------------
// What the README says about this package, checked against this package
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, "api");
const EXAMPLES_DIR = resolve(HERE, "..");
const README = readFileSync(resolve(HERE, "../../README.md"), "utf8");

/**
 * The examples package's own README.
 *
 * It repeats the package README's claims about which demos exist and how they
 * start, so the same derived sets have to be held against both. A claim that is
 * machine-checked in one copy and prose in the other is the copy that goes
 * stale.
 */
const EXAMPLES_README = readFileSync(join(EXAMPLES_DIR, "README.md"), "utf8");

/** Every demo file under `server/api/`, by the name the README calls it. */
const apiDemos = readdirSync(API_DIR)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => file.replace(/\.ts$/, ""));

/**
 * The demos that can be started on their own, read off the files.
 *
 * `runIfMain` is the guard that turns a factory module into a server, so its
 * presence is the fact the README's "carry a standalone runner" describes.
 */
const runnerDemos = new Set(
  apiDemos.filter((demo) =>
    readFileSync(join(API_DIR, `${demo}.ts`), "utf8").includes("runIfMain"),
  ),
);

/**
 * The demos a `pnpm run <demo>` starts, read off the manifest.
 *
 * Derived from the relationship rather than counted: a script only belongs
 * here if its key is the basename its command runs, so `dojo` (which runs
 * `server/server.ts`) drops out on its own instead of by being listed as an
 * exception here.
 */
const exampleScripts: Record<string, string> = JSON.parse(
  readFileSync(resolve(HERE, "../package.json"), "utf8"),
).scripts;

const scriptedDemos = new Set(
  Object.entries(exampleScripts)
    .filter(([name, command]) => {
      const target = /server\/api\/([^\s]+)\.ts/.exec(command)?.[1];
      return target !== undefined && target === name;
    })
    .map(([name]) => name),
);

/**
 * English numerals the README uses, plus their neighbours.
 *
 * This table maps language, not facts, so it does not drift with the code. A
 * word missing from it fails rather than quietly matching nothing, which is
 * the whole reason the lookup exists.
 */
const NUMBER_WORDS: Record<string, number> = {
  // Ordinals as well as cardinals: the examples README names a file as the
  // eleventh runner, and the same lookup has to refuse an ordinal it does not
  // know rather than let the sentence go unchecked.
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
};

function numberWord(word: string, where: string): number {
  const value = NUMBER_WORDS[word.toLowerCase()];
  expect(
    value,
    `the README says "${word}" ${where}, which is not in this test's number-word table; add the word rather than leaving the count unchecked`,
  ).toBeDefined();
  return value!;
}

/** A README slice under one `##` heading. */
function section(doc: string, name: string): string {
  const start = doc.indexOf(`\n## ${name}\n`);
  expect(
    start,
    `the README has no "## ${name}" section, so the claims this test scopes to it cannot be found`,
  ).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * A README's lead-in, above its first `##` heading.
 *
 * A region like any other, so a numeral in the opening sentence is checked
 * against the same derived set rather than against a search of the whole file.
 */
function preamble(doc: string): string {
  const end = doc.indexOf("\n## ");
  expect(
    end,
    "the README has no `##` heading, so its lead-in cannot be told from the rest of the file",
  ).toBeGreaterThan(-1);
  return doc.slice(0, end);
}

/**
 * One blank-line-separated block of a region, whitespace-collapsed.
 *
 * Collapsed because the prose is hard-wrapped and the sentences below cross
 * line breaks; scoped to a block because an unscoped search for a numeral
 * would be satisfied by any incidental occurrence elsewhere in the file.
 *
 * The opening may be a pattern, which is how a paragraph that begins with a
 * numeral gets anchored without writing that numeral into the test.
 */
function block(region: string, opening: string | RegExp): string {
  const found = region
    .split(/\n{2,}/)
    .filter((part) =>
      typeof opening === "string"
        ? part.trimStart().startsWith(opening)
        : opening.test(part.trimStart()),
    );
  expect(
    found,
    `the README has no paragraph starting ${JSON.stringify(String(opening))}`,
  ).toHaveLength(1);
  return unwrapped(found[0]!);
}

/**
 * The data rows of a pipe table in a region, cell by cell.
 *
 * Anchored on the header's first cell and on the separator line under it, so a
 * table that is retitled or restructured fails here instead of yielding an
 * empty row list that every later assertion would pass over.
 */
function tableRows(region: string, headerCell: string): string[][] {
  const lines = region.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`| ${headerCell}`));
  expect(
    start,
    `the README has no table whose first column is "${headerCell}"`,
  ).toBeGreaterThan(-1);
  expect(
    lines[start + 1] ?? "",
    `the "${headerCell}" table has no separator row under its header`,
  ).toMatch(/^\|\s*-/);

  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.replace(/`/g, "").trim()),
    );
  }
  expect(
    rows.length,
    `the "${headerCell}" table has a header but no rows`,
  ).toBeGreaterThan(0);
  return rows;
}

/** The fenced blocks of a region, each as its content lines. */
function fences(region: string): string[][] {
  const parts = region.split(/^```.*$/m);
  // An odd number of fence markers leaves a block unterminated, and the odd
  // split below would then read prose as code.
  expect(
    parts.length % 2,
    "the README has an unterminated code fence in this region",
  ).toBe(1);
  return parts
    .filter((_, index) => index % 2 === 1)
    .map((part) => part.split("\n").filter((line) => line.trim().length > 0));
}

/** One row of the Key Files table, by the file it describes. */
function keyFilesRow(doc: string, file: string): string {
  const rows = section(doc, "Key Files")
    .split("\n")
    .filter((line) => line.startsWith(`| \`${file}\``));
  expect(rows, `the Key Files table has no row for \`${file}\``).toHaveLength(
    1,
  );
  return rows[0]!;
}

/**
 * Pull a claim out of a region, failing if the sentence itself has moved.
 *
 * An optional-chained match would turn a reworded sentence into a test that
 * silently stops asserting, which is worse than the drift it was added to
 * catch.
 */
function claim(
  region: string,
  pattern: RegExp,
  description: string,
): RegExpExecArray {
  const match = pattern.exec(region);
  expect(
    match,
    `the README no longer says ${description}; reword the assertion with it, because as written it now checks nothing`,
  ).not.toBeNull();
  return match!;
}

/** Route table rows: the first cell of every line that starts a `/` path. */
function documentedRoutes(doc: string): string[] {
  return doc
    .split("\n")
    .filter((line) => line.startsWith("| `/"))
    .map((line) => line.split("|")[1]!.replace(/`/g, "").trim());
}

describe("README claims about the demos", () => {
  it("advertises exactly the routes the dojo mounts", () => {
    const documented = documentedRoutes(README);
    const mounted = Object.keys(DEMOS).map((path) => `/${path}`);

    // Length as well as set membership, so a duplicated row cannot hide
    // inside the set comparison. Both directions matter: a row for a route
    // nothing serves sends readers at a 404, and a mounted route with no row
    // is a demo nobody can find.
    expect(documented).toHaveLength(mounted.length);
    expect(new Set(documented)).toEqual(new Set(mounted));
  });

  it("counts the runnable demos the way the scripts do", () => {
    const intro = block(
      section(README, "Quick Start"),
      "The `examples/` package ships a",
    );
    const [, word] = claim(
      intro,
      /a standalone server for each of the (\w+) demos that ship a run script/,
      "that it ships a standalone server for each of the N demos that ship a run script",
    );

    expect(
      numberWord(word!, "demos ship a run script"),
      "the Quick Start numeral disagrees with the scripts in examples/package.json",
    ).toBe(scriptedDemos.size);
  });

  it("counts the scripted demos the way the scripts do", () => {
    const [, word] = claim(
      block(
        section(README, "Quick Start"),
        "Every file under `examples/server/api/*.ts`",
      ),
      /The (\w+) with a `pnpm run <demo>` script/,
      "that N files carry a `pnpm run <demo>` script",
    );

    expect(
      numberWord(word!, "files have a `pnpm run <demo>` script"),
      "the file-pattern paragraph disagrees with the scripts in examples/package.json",
    ).toBe(scriptedDemos.size);
  });

  it("counts standalone runners the way the files do", () => {
    const [, runners, scripted] = claim(
      keyFilesRow(README, "examples/server/api/*.ts"),
      /(\w+) carry a standalone runner, (\w+) of those scripted/,
      "that N api files carry a standalone runner, M of those scripted",
    );

    expect(
      numberWord(runners!, "api files carry a standalone runner"),
      "the Key Files row disagrees with the files that call `runIfMain`",
    ).toBe(runnerDemos.size);
    expect(
      numberWord(scripted!, "of the runners are scripted"),
      "the Key Files row disagrees with the scripts in examples/package.json",
    ).toBe(scriptedDemos.size);
  });

  it("names every file that exports a factory and nothing else", () => {
    const factoryOnly = apiDemos.filter((demo) => !runnerDemos.has(demo));
    const [, word] = claim(
      block(
        section(README, "Quick Start"),
        "Every file under `examples/server/api/*.ts`",
      ),
      /The multi-agent and (\w+) a2ui files export the factory only/,
      "that multi-agent and N a2ui files export the factory only",
    );

    expect(
      numberWord(word!, "a2ui files export the factory only"),
      "the numeral disagrees with the a2ui files that carry no runner",
    ).toBe(factoryOnly.filter((demo) => demo.startsWith("a2ui")).length);
    // The sentence too, not just its numeral: a file that quietly loses its
    // runner would keep the count honest only by making the naming wrong, so
    // the derived complement has to match what the sentence names.
    expect(new Set(factoryOnly)).toEqual(
      new Set([
        "multi-agent",
        ...apiDemos.filter((demo) => demo.startsWith("a2ui")),
      ]),
    );
  });

  it("keeps true the one demo that runs standalone unscripted", () => {
    // The claim a bare count check would pass straight over: the totals stay
    // right whichever file is the unscripted one, and this is the file the
    // README tells the reader to start with `tsx` by hand.
    const [, file] = claim(
      block(
        section(README, "Quick Start"),
        "Every file under `examples/server/api/*.ts`",
      ),
      /`([\w.-]+)\.ts` sits between the two: it carries the same standalone runner, but no `pnpm` script points at it/,
      "that one named file carries a standalone runner with no `pnpm` script pointing at it",
    );

    expect(runnerDemos.has(file!), `${file}.ts calls runIfMain`).toBe(true);
    expect(
      scriptedDemos.has(file!),
      `a pnpm script now points at ${file}.ts, so the README should list it with the scripted demos`,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the examples README says about these demos, checked against them
// ---------------------------------------------------------------------------

/** The "Available agents" prose, which carries all of that page's counts. */
function agentsProse(): string {
  return block(
    section(EXAMPLES_README, "Available agents"),
    // Anchored on a pattern because the paragraph opens with the numeral this
    // test is here to check, and spelling that numeral into the anchor would
    // make the anchor agree with the claim by construction.
    /^\w+ demos have a `pnpm run <demo>` script/,
  );
}

/** The demo table's rows: which file, which route, how it starts alone. */
function demoRows(): { file: string; route: string; standalone: string }[] {
  return tableRows(section(EXAMPLES_README, "Available agents"), "File").map(
    (cells) => {
      expect(
        cells,
        `the demo table row ${JSON.stringify(cells.join(" | "))} does not have the three cells this test reads`,
      ).toHaveLength(3);
      return { file: cells[0]!, route: cells[1]!, standalone: cells[2]! };
    },
  );
}

/** The demo a table row is about, from the file it names. */
function demoOf(file: string): string {
  expect(
    file,
    `the demo table lists "${file}", which is not spelled as one of the .ts files under server/api/`,
  ).toMatch(/\.ts$/);
  return file.replace(/\.ts$/, "");
}

/**
 * The project tree, read out of its fence as paths plus what each one is.
 *
 * Indented one four-character unit per level, so an entry's name alone does not
 * say where it lives and the depth of its prefix has to be counted. A line this
 * cannot parse fails loudly rather than being skipped, because a skipped line
 * is a path nobody checks.
 */
function projectTree(): { path: string; directory: boolean }[] {
  const blocks = fences(section(EXAMPLES_README, "Project structure"));
  expect(
    blocks,
    'the "Project structure" section no longer holds exactly one code fence',
  ).toHaveLength(1);
  const [root, ...lines] = blocks[0]!;

  // The root line is a claim too: a package that moves leaves the tree naming
  // a path the repo no longer has.
  expect(
    EXAMPLES_DIR.endsWith(`/${root!.trim()}`),
    `the project tree is rooted at "${root?.trim()}", which is not where this package sits`,
  ).toBe(true);
  expect(
    lines.length,
    "the project tree fence has a root line and nothing under it",
  ).toBeGreaterThan(0);

  const parents: string[] = [];
  return lines.map((line) => {
    const parsed = /^((?:│   |    )*)(?:├──|└──) (\S+)/.exec(line);
    expect(
      parsed,
      `the project tree has a line this test cannot parse: ${JSON.stringify(line)}`,
    ).not.toBeNull();
    const depth = parsed![1]!.length / 4;
    const name = parsed![2]!;
    const directory = name.endsWith("/");
    const bare = directory ? name.slice(0, -1) : name;
    // Truncate first: the entry sits under however many levels its prefix
    // spelled, whatever the deeper listing before it was.
    parents.length = depth;
    const path = [...parents, bare].join("/");
    if (directory) parents.push(bare);
    return { path, directory };
  });
}

describe("examples README claims about the demos", () => {
  it("lists exactly the demos the dojo mounts", () => {
    const listed = demoRows().map((row) => demoOf(row.file));
    const mounted = Object.keys(DEMOS);

    // Length as well as set membership, the same way the package README's
    // route table is held: a row repeated for one demo, which is how a
    // hand-edited table drifts, vanishes inside a set comparison.
    expect(listed).toHaveLength(mounted.length);
    expect(new Set(listed)).toEqual(new Set(mounted));
  });

  it("points every row at the route its own demo is served on", () => {
    const rows = demoRows();
    const documented = rows.map((row) => row.route);
    const mounted = Object.keys(DEMOS).map((path) => `/${path}`);

    expect(documented).toHaveLength(mounted.length);
    expect(new Set(documented)).toEqual(new Set(mounted));
    // Row by row as well as column by column: two routes swapped between rows
    // leave both sets identical and still send the reader to another demo.
    for (const row of rows) {
      expect(row.route, row.file).toBe(`/${demoOf(row.file)}`);
    }
  });

  it("counts the demos the way the dojo mounts them", () => {
    const [, word] = claim(
      unwrapped(preamble(EXAMPLES_README)),
      /(\w+) runnable AG-UI demos built on/,
      "how many runnable demos it opens with",
    );

    expect(
      numberWord(word!, "runnable demos ship, in the examples README"),
      "the examples README's opening numeral disagrees with the demos the dojo mounts",
    ).toBe(Object.keys(DEMOS).length);
  });

  it("counts the scripted demos the way the scripts do", () => {
    const [, word] = claim(
      agentsProse(),
      /^(\w+) demos have a `pnpm run <demo>` script/,
      "that N demos have a `pnpm run <demo>` script",
    );

    expect(
      numberWord(word!, "demos have a run script, in the examples README"),
      "the examples README disagrees with the scripts in examples/package.json",
    ).toBe(scriptedDemos.size);
  });

  it("counts the standalone runners the way the files do", () => {
    const [, word] = claim(
      agentsProse(),
      /(\w+) carry a standalone runner, guarded so importing the file starts no server/,
      "that N files carry a standalone runner",
    );

    expect(
      numberWord(
        word!,
        "files carry a standalone runner, in the examples README",
      ),
      "the examples README disagrees with the files that call `runIfMain`",
    ).toBe(runnerDemos.size);
  });

  it("marks each row the way the scripts and the files start it", () => {
    const rows = demoRows();
    const marked = (pattern: RegExp, what: string): Set<string> => {
      const found = rows.filter((row) => pattern.test(row.standalone));
      expect(
        found.length,
        `the demo table marks no row as ${what}, so that column now says something this test cannot read`,
      ).toBeGreaterThan(0);
      return new Set(found.map((row) => demoOf(row.file)));
    };

    const scripted = marked(/pnpm/, "started by a `pnpm` script");
    const dojoOnly = marked(/dojo/, "reachable through the dojo only");
    const byHand = marked(/tsx/, "started with `tsx` by hand");

    // The three groups against the three derived sets, not against each
    // other's totals: a demo moved between two groups keeps every count in
    // this file right and still tells the reader to run it a way that fails.
    expect(
      scripted,
      "the demo table's scripted rows disagree with examples/package.json",
    ).toEqual(scriptedDemos);
    expect(
      dojoOnly,
      "the demo table's dojo-only rows disagree with the files that call `runIfMain`",
    ).toEqual(new Set(apiDemos.filter((demo) => !runnerDemos.has(demo))));
    expect(
      byHand,
      "the demo table's tsx rows disagree with the runners that have no script",
    ).toEqual(
      new Set([...runnerDemos].filter((demo) => !scriptedDemos.has(demo))),
    );

    // Exhaustive, so a row given some fourth marking is not quietly left out
    // of all three checks above.
    expect(
      scripted.size + dojoOnly.size + byHand.size,
      "some demo table row is marked in a way none of the three checks above read",
    ).toBe(rows.length);
  });

  it("names every file that exports a factory and nothing else", () => {
    const factoryOnly = apiDemos.filter((demo) => !runnerDemos.has(demo));
    const [, word] = claim(
      agentsProse(),
      /The multi-agent and (\w+) a2ui files export their factory only/,
      "that multi-agent and N a2ui files export their factory only",
    );

    expect(
      numberWord(
        word!,
        "a2ui files export the factory only, in the examples README",
      ),
      "the examples README disagrees with the a2ui files that carry no runner",
    ).toBe(factoryOnly.filter((demo) => demo.startsWith("a2ui")).length);
    // The naming too, not just its numeral: a file that quietly loses its
    // runner keeps the count honest only by making the sentence name the wrong
    // files.
    expect(new Set(factoryOnly)).toEqual(
      new Set([
        "multi-agent",
        ...apiDemos.filter((demo) => demo.startsWith("a2ui")),
      ]),
    );
  });

  it("keeps true the one demo that runs standalone unscripted", () => {
    const [, file, ordinal] = claim(
      agentsProse(),
      /`([\w.-]+)\.ts` is the (\w+), with no script pointing at it/,
      "that one named file is the last runner and has no `pnpm` script pointing at it",
    );

    expect(runnerDemos.has(file!), `${file}.ts calls runIfMain`).toBe(true);
    expect(
      scriptedDemos.has(file!),
      `a pnpm script now points at ${file}.ts, so the examples README should list it with the scripted demos`,
    ).toBe(false);
    // The ordinal says this file is the last of the runners, so it is a claim
    // about the runner count as well as about the file.
    expect(
      numberWord(ordinal!, "runners the unscripted demo is the last of"),
      "the examples README's ordinal disagrees with the files that call `runIfMain`",
    ).toBe(runnerDemos.size);
  });

  it("draws a project tree whose every entry is on disk", () => {
    for (const { path, directory } of projectTree()) {
      const full = join(EXAMPLES_DIR, path);
      expect(
        existsSync(full),
        `the project tree lists ${path}, which is not in this package`,
      ).toBe(true);
      expect(
        statSync(full).isDirectory(),
        `the project tree draws ${path} as a ${directory ? "directory" : "file"}`,
      ).toBe(directory);
    }
  });

  it("draws every file in the directories the tree opens up", () => {
    // The drift a per-path existence check cannot see, and the way the
    // LangGraph tree is wrong: right about everything it names, silent about
    // what has been added since. Only the directories the tree opens up are
    // held to this, and the package root is not one of them: the tree leaves
    // out this README on purpose, so the same rule there would fail on an
    // omission that is deliberate.
    const listed = new Map<string, Set<string>>();
    for (const { path } of projectTree()) {
      const cut = path.lastIndexOf("/");
      if (cut === -1) continue;
      const parent = path.slice(0, cut);
      const names = listed.get(parent) ?? new Set<string>();
      names.add(path.slice(cut + 1));
      listed.set(parent, names);
    }

    expect(
      listed.size,
      "the project tree opens up no directory at all, so this test would check nothing",
    ).toBeGreaterThan(0);
    for (const [parent, names] of listed) {
      expect(
        [...names].sort(),
        `the project tree's ${parent}/ listing`,
      ).toEqual(readdirSync(join(EXAMPLES_DIR, parent)).sort());
    }
  });

  it("names the flag every demo script actually passes", () => {
    const [, flag] = claim(
      block(section(EXAMPLES_README, "How to run"), "Create a `.env` beside"),
      /Every demo script passes `([^`]+)`/,
      "that every demo script passes a named flag",
    );

    // Which scripts those are is derived: a script that runs a file under
    // `server/` starts a demo, which leaves `test` and `typecheck` out
    // without either of them being named here.
    const demoScripts = Object.entries(exampleScripts).filter(([, command]) =>
      command.includes("server/"),
    );
    expect(
      demoScripts.length,
      "no script in examples/package.json runs anything under server/",
    ).toBeGreaterThan(0);
    for (const [name, command] of demoScripts) {
      expect(command, `the \`${name}\` script`).toContain(flag);
    }
  });

  it("runs the demos with commands this package defines", () => {
    const blocks = fences(section(EXAMPLES_README, "How to run"));
    // Scoped to the fences from the one that changes directory here onward.
    // The fences above it run from the repo root, where `pnpm install` is not
    // one of this package's scripts and should not be read as one.
    const arrived = blocks.findIndex((lines) =>
      lines.some((line) => line.startsWith("cd ")),
    );
    expect(
      arrived,
      "no fence under How to run changes directory into this package, so its `pnpm` lines cannot be scoped to these scripts",
    ).toBeGreaterThan(-1);

    const target = blocks[arrived]!.find((line) => line.startsWith("cd "))!
      .slice("cd ".length)
      .trim();
    expect(
      EXAMPLES_DIR.endsWith(`/${target}`),
      `How to run changes directory to "${target}", which is not where this package sits`,
    ).toBe(true);

    const named = blocks
      .slice(arrived)
      .flatMap((lines) =>
        lines.map((line) => /^pnpm ([\w-]+)$/.exec(line.trim())),
      )
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1]!);
    expect(
      named.length,
      "no fence under How to run runs a bare `pnpm <script>`, so this test would check nothing",
    ).toBeGreaterThan(0);
    for (const script of named) {
      expect(
        Object.keys(exampleScripts),
        `the examples README runs \`pnpm ${script}\``,
      ).toContain(script);
    }
  });
});

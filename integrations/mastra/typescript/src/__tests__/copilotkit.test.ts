import { beforeEach, describe, expect, it, vi } from "vitest";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";

/**
 * Unit tests for `registerCopilotKit` (src/copilotkit.ts) — the Mastra
 * server-route helper that mounts a CopilotKit v2 runtime for AG-UI agents.
 *
 * The CopilotKit v2 runtime + Mastra agent construction are mocked so we can
 * assert the wiring the helper is responsible for, without a live server:
 *   - the `authorization` header is stripped before the runtime sees the
 *     request (so a Mastra auth token can't leak into `modelSettings.headers`)
 *     while other forwardable headers (`x-*`) are preserved,
 *   - a middleware-set `MASTRA_RESOURCE_ID_KEY` takes precedence over the
 *     static `resourceId`, falling back to the static one otherwise,
 *   - extra `CopilotRuntimeOptions` are forwarded to `CopilotRuntime`,
 *   - `cors` / `basePath` / single-route mode reach the handler,
 *   - an explicit `agents` map bypasses `getLocalAgents`,
 *   - the deprecated `serviceAdapter` is accepted and never forwarded.
 */

const mocks = vi.hoisted(() => ({
  captured: {} as Record<string, any>,
}));

vi.mock("@copilotkit/runtime/v2", () => ({
  CopilotRuntime: class {
    constructor(options: any) {
      mocks.captured.runtimeOptions = options;
    }
  },
  createCopilotRuntimeHandler: (options: any) => {
    mocks.captured.handlerOptions = options;
    return (request: Request) => {
      mocks.captured.request = request;
      return Promise.resolve(new Response("ok"));
    };
  },
}));

// Only `ExperimentalEmptyAdapter` is used as a runtime value (the default for
// the deprecated `serviceAdapter`); `CopilotServiceAdapter` is type-only.
vi.mock("@copilotkit/runtime", () => ({
  ExperimentalEmptyAdapter: class {},
}));

vi.mock("../mastra", () => ({
  MastraAgent: {
    getLocalAgents: vi.fn((options: any) => {
      mocks.captured.getLocalAgentsOptions = options;
      return { localAgent: { id: "local" } };
    }),
  },
}));

// Imported after the mocks are declared (vi.mock is hoisted above imports).
import { registerCopilotKit } from "../copilotkit";
import { MastraAgent } from "../mastra";

const getLocalAgents = MastraAgent.getLocalAgents as unknown as ReturnType<
  typeof vi.fn
>;

/**
 * Minimal stand-in for the Hono `ContextWithMastra` the Mastra server hands to
 * a custom route handler: `c.get("mastra")`, `c.get("requestContext")`, and
 * `c.req.raw` (the raw fetch `Request`).
 */
function makeContext(opts: {
  authorization?: string;
  requestContextValues?: Array<[unknown, unknown]>;
} = {}) {
  const headers = new Headers({ "x-tenant-id": "acme" });
  if (opts.authorization) headers.set("authorization", opts.authorization);

  const raw = new Request("http://localhost/copilotkit", {
    method: "POST",
    headers,
    body: JSON.stringify({ method: "run", params: {}, body: {} }),
  });

  const store = new Map<unknown, unknown>(opts.requestContextValues ?? []);
  const requestContext = {
    get: (key: unknown) => store.get(key),
    set: (key: unknown, value: unknown) => store.set(key, value),
  };

  return {
    get: (name: string) => {
      if (name === "mastra") return { id: "mastra-instance" };
      if (name === "requestContext") return requestContext;
      return undefined;
    },
    req: { raw },
  } as any;
}

async function invoke(config: Parameters<typeof registerCopilotKit>[0]) {
  const route = registerCopilotKit(config) as any;
  return route as { path: string; method: string; handler: (c: any) => any };
}

beforeEach(() => {
  mocks.captured = {};
  vi.clearAllMocks();
});

describe("registerCopilotKit", () => {
  it("registers an ALL route at the given path", async () => {
    const route = await invoke({ path: "/copilotkit", resourceId: "static" });
    expect(route.path).toBe("/copilotkit");
    expect(route.method).toBe("ALL");
    expect(typeof route.handler).toBe("function");
  });

  it("strips the authorization header but preserves other forwardable headers", async () => {
    const route = await invoke({ path: "/copilotkit", resourceId: "static" });
    const res = await route.handler(
      makeContext({ authorization: "Bearer mastra-token" }),
    );

    expect(res).toBeInstanceOf(Response);
    const forwarded: Request = mocks.captured.request;
    expect(forwarded.headers.get("authorization")).toBeNull();
    expect(forwarded.headers.get("x-tenant-id")).toBe("acme");
  });

  it("prefers a middleware-set MASTRA_RESOURCE_ID_KEY over the static resourceId", async () => {
    const route = await invoke({ path: "/copilotkit", resourceId: "static" });
    await route.handler(
      makeContext({
        requestContextValues: [[MASTRA_RESOURCE_ID_KEY, "from-context"]],
      }),
    );

    expect(getLocalAgents).toHaveBeenCalledTimes(1);
    expect(mocks.captured.getLocalAgentsOptions.resourceId).toBe("from-context");
  });

  it("falls back to the static resourceId when the context has none", async () => {
    const route = await invoke({ path: "/copilotkit", resourceId: "static" });
    await route.handler(makeContext());

    expect(mocks.captured.getLocalAgentsOptions.resourceId).toBe("static");
    // The Mastra instance + shared requestContext are threaded through.
    expect(mocks.captured.getLocalAgentsOptions.mastra).toEqual({
      id: "mastra-instance",
    });
    expect(mocks.captured.getLocalAgentsOptions.requestContext).toBeDefined();
  });

  it("forwards extra CopilotRuntime options and single-route/cors handler config", async () => {
    const route = await invoke({
      path: "/copilotkit",
      resourceId: "static",
      cors: true,
      licenseToken: "test-license",
    } as any);
    await route.handler(makeContext());

    expect(mocks.captured.runtimeOptions.licenseToken).toBe("test-license");
    expect(mocks.captured.runtimeOptions.agents).toEqual({
      localAgent: { id: "local" },
    });
    // `cors` is a handler concern, not a runtime option — it must not leak in.
    expect(mocks.captured.runtimeOptions.cors).toBeUndefined();

    expect(mocks.captured.handlerOptions.cors).toBe(true);
    expect(mocks.captured.handlerOptions.basePath).toBe("/copilotkit");
    expect(mocks.captured.handlerOptions.mode).toBe("single-route");
  });

  it("uses an explicit agents map and skips getLocalAgents", async () => {
    const agents = { custom: { id: "custom" } } as any;
    const route = await invoke({
      path: "/copilotkit",
      resourceId: "static",
      agents,
    });
    await route.handler(makeContext());

    expect(getLocalAgents).not.toHaveBeenCalled();
    expect(mocks.captured.runtimeOptions.agents).toBe(agents);
  });

  it("accepts the deprecated serviceAdapter without forwarding it to the runtime", async () => {
    const route = await invoke({
      path: "/copilotkit",
      resourceId: "static",
      serviceAdapter: { name: "legacy" } as any,
    });
    const res = await route.handler(makeContext());

    expect(res).toBeInstanceOf(Response);
    expect(mocks.captured.runtimeOptions.serviceAdapter).toBeUndefined();
  });

  it("runs setContext with the shared request context before building agents", async () => {
    const seen: string[] = [];
    const route = await invoke({
      path: "/copilotkit",
      resourceId: "static",
      setContext: (_c, requestContext) => {
        seen.push("setContext");
        requestContext.set("custom-key", "custom-value");
      },
    });
    await route.handler(makeContext());

    expect(seen).toEqual(["setContext"]);
    // getLocalAgents received the same requestContext setContext mutated.
    expect(
      mocks.captured.getLocalAgentsOptions.requestContext.get("custom-key"),
    ).toBe("custom-value");
  });
});

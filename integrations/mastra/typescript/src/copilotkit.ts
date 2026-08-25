import {
  CopilotServiceAdapter,
  ExperimentalEmptyAdapter,
} from "@copilotkit/runtime";
import {
  AgentsConfig,
  CopilotCorsConfig,
  CopilotRuntime,
  CopilotRuntimeOptions,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import {
  MASTRA_RESOURCE_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import { ContextWithMastra, registerApiRoute } from "@mastra/core/server";
import { MastraAgent, MastraTracingOptions } from "./mastra";

/**
 * `Omit` that distributes over each member of a union, so a discriminated union
 * (e.g. `CopilotRuntimeOptions`) keeps its discriminant correlation. Plain
 * `Omit<A | B, K>` collapses to `Omit<A & B, K>` because `keyof (A | B)` is only
 * the shared keys, which destroys the union.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Registers a CopilotKit endpoint that exposes Mastra agents through the AG-UI protocol.
 * This function creates an API route that handles CopilotKit requests and forwards them to Mastra agents, enabling seamless integration between CopilotKit's UI components and Mastra's agent framework.
 *
 * @example
 * ```ts
 * registerCopilotKit({
 *   path: "/api/copilotkit"
 * });
 * ```
 */
export function registerCopilotKit({
  path,
  resourceId,
  serviceAdapter = new ExperimentalEmptyAdapter(),
  setContext,
  agents,
  cors,
  tracingOptions,
  ...runtimeOptions
}: {
  path: string;
  resourceId: string;
  /**
   * Mastra tracing options forwarded to each agent run (default-agent path
   * only; ignored when `agents` is supplied since those are pre-constructed).
   * See MastraAgentConfig.tracingOptions.
   */
  tracingOptions?: MastraTracingOptions;
  /**
   * @deprecated The v2 CopilotKit runtime handler used internally has no
   * service-adapter slot (AG-UI agents don't use one), so this option is
   * accepted for backwards compatibility but ignored. Safe to remove.
   */
  serviceAdapter?: CopilotServiceAdapter;
  /**
   * Hook to populate the request context before agents run. It runs inside the
   * route handler, i.e. *after* any Mastra server middleware, so the
   * `requestContext` it receives already holds whatever keys that middleware
   * set. Be careful not to clobber those keys (e.g. `MASTRA_RESOURCE_ID_KEY`)
   * unless that is the intent.
   */
  setContext?: (
    c: ContextWithMastra,
    requestContext: RequestContext,
  ) => void | Promise<void>;
  cors?: boolean | CopilotCorsConfig;
} & DistributiveOmit<CopilotRuntimeOptions, "agents"> & {
    agents?: AgentsConfig;
  }) {
  // `serviceAdapter` is deprecated and intentionally unused (see its JSDoc):
  // the v2 runtime handler has no service-adapter slot. Referenced here to
  // keep it a supported, non-breaking option without a lint no-unused-vars.
  void serviceAdapter;

  return registerApiRoute(path, {
    method: `ALL`,
    handler: async (c) => {
      const mastra = c.get("mastra");
      const requestContext = c.get("requestContext");

      if (setContext) {
        await setContext(c, requestContext);
      }

      const aguiAgents =
        agents ||
        MastraAgent.getLocalAgents({
          resourceId:
            requestContext.get<
              typeof MASTRA_RESOURCE_ID_KEY,
              string | undefined
            >(MASTRA_RESOURCE_ID_KEY) ?? resourceId,
          mastra,
          requestContext,
          tracingOptions,
        });

      const runtime = new CopilotRuntime({
        ...runtimeOptions,
        agents: aguiAgents,
      });

      const handler = createCopilotRuntimeHandler({
        runtime,
        basePath: path,
        cors,
        mode: "single-route",
      });

      // CopilotKit forwards `authorization` and `x-*` headers onto the agent
      // (`configureAgentForRequest` → `extractForwardableHeaders`), and
      // `@ag-ui/mastra` then passes the agent's headers as
      // `modelSettings.headers` into the model call. That would forward our
      // Mastra Authorization to our AI provider and clobber the provider's real
      // Authorization header. Mastra has already authenticated this request by
      // now, so drop the header before the runtime sees it.
      const headers = new Headers(c.req.raw.headers);
      headers.delete("authorization");

      return handler(new Request(c.req.raw, { headers }));
    },
  });
}

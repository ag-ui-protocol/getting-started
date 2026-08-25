# A2UI Runtime and Renderer Wiring

A2UI needs three pieces to line up: a server-side AG-UI bridge, an A2UI
operation source, and a client renderer with the matching catalog.

## Server Bridge

AG-UI now provides `@ag-ui/a2ui-middleware`. It injects schema context, can
inject the `render_a2ui` tool, detects `a2ui_operations` tool results, emits
`ACTIVITY_SNAPSHOT` events with `activityType: "a2ui-surface"`, and forwards
user actions back to the agent as synthetic `log_a2ui_event` tool messages.

Apply it directly to one agent:

```ts
import { A2UIMiddleware } from "@ag-ui/a2ui-middleware";

agent.use(
  new A2UIMiddleware({
    injectA2UITool: true,
    defaultCatalogId: "https://example.com/catalogs/product-catalog.json",
  }),
);
```

When hosting behind CopilotRuntime v2, prefer the client-driven path: forward a
catalog to the provider (`<CopilotKit a2ui={{ catalog }}>`, see "Client Side").
With CopilotKit >= 1.61.2 this auto-enables A2UI, defaults tool injection on,
and auto-derives `defaultCatalogId` from the forwarded catalog's `catalogId`, so
no runtime `a2ui` block is required.

Use an explicit runtime `a2ui` block only to override that default — for
example, to scope injection to specific agents or pin a catalog id when the
client does not forward one:

```ts
import { CopilotRuntime, InMemoryAgentRunner } from "@copilotkit/runtime/v2";

const runtime = new CopilotRuntime({
  agents,
  runner: new InMemoryAgentRunner(),
  // Optional override; omit when the provider forwards a catalog.
  a2ui: {
    agents: ["a2ui_dynamic_schema"],
    injectA2UITool: true,
    defaultCatalogId: "https://example.com/catalogs/product-catalog.json",
  },
});
```

Do not apply the middleware twice to the same agent. If an integration needs
per-agent middleware because only some agents should get `injectA2UITool`,
exclude those agents from runtime-level A2UI config.

## Fixed Schema Mode

Use fixed schema mode when the app already knows the component tree. Backend
tools return an `a2ui_operations` envelope, and only the data changes per tool
call.

```ts
import {
  A2UI_OPERATIONS_KEY,
  createSurface,
  updateComponents,
  updateDataModel,
} from "@ag-ui/a2ui-toolkit";

const CATALOG_ID = "https://example.com/catalogs/travel.json";
const SURFACE_ID = "flight-search-results";

function searchFlights(flights: Array<Record<string, unknown>>) {
  return {
    [A2UI_OPERATIONS_KEY]: [
      createSurface(SURFACE_ID, CATALOG_ID),
      updateComponents(SURFACE_ID, FLIGHT_SCHEMA),
      updateDataModel(SURFACE_ID, { flights }),
    ],
  };
}
```

For Python adapters, use the equivalent helpers from `ag_ui_a2ui_toolkit`:
`A2UI_OPERATIONS_KEY`, `create_surface`, `update_components`, and
`update_data_model`. Return a dict/object envelope when the framework preserves
structured tool results. Only stringify when that specific adapter expects a
string result that the middleware can scan.

## Dynamic Schema Mode

Use dynamic schema mode when the model must compose a surface from the available
catalog. Current AG-UI adapters share this shape:

- Injection is enabled by forwarding a catalog from the client provider
  (`a2ui={{ catalog }}`, CopilotKit >= 1.61.2), or explicitly via runtime
  `a2ui.injectA2UITool` or per-agent `new A2UIMiddleware({ injectA2UITool: true })`.
- The framework adapter injects a planner-facing `generate_a2ui` tool when it
  sees the `injectA2UITool` flag.
- `generate_a2ui` runs a sub-agent that is forced to call `render_a2ui`.
- The sub-agent streams `render_a2ui` arguments (`surfaceId`, `components`,
  `data`) so `A2UIMiddleware` can show building/retry states and progressively
  paint.
- The adapter/toolkit validates and retries before committing the final
  `a2ui_operations` envelope.

For adapters that expose an explicit tool factory, use that rather than
hand-rolling prompts:

```ts
import { getA2UITools } from "@ag-ui/langgraph";

const a2uiTool = getA2UITools({
  model: subagentModel,
  defaultCatalogId: "https://example.com/catalogs/product-catalog.json",
  guidelines: {
    compositionGuide: "Use ProductCard for product comparisons.",
  },
});
```

Frameworks with auto-injection, such as ADK and Strands, can infer the model
and create `generate_a2ui` when the runtime/middleware forwards
`injectA2UITool`. Prefer explicit tool wiring only when the adapter cannot infer
the model, the developer has already wired a custom `generate_a2ui`, or the app
is not hosted behind CopilotRuntime.

## Client Side

Register the renderer and catalog on the app shell that owns the AG-UI
conversation.

```tsx
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { productCatalog } from "./a2ui-catalog";

export function AppShell() {
  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit/my-integration"
      agent="a2ui_dynamic_schema"
      a2ui={{ catalog: productCatalog }}
    >
      <CopilotChat agentId="a2ui_dynamic_schema" />
    </CopilotKit>
  );
}
```

The catalog registered here must match the `catalogId` stamped into
`createSurface`. With CopilotKit >= 1.61.2 the forwarded catalog supplies its
own `catalogId`, which the middleware uses to auto-derive `defaultCatalogId`, so
streamed `createSurface` operations resolve without any manual pin. Set
middleware/adapter `defaultCatalogId` explicitly only when you are not
forwarding a catalog from the provider.

## Component Catalog Pattern

Use a catalog when the agent needs app-specific components beyond the built-in
A2UI catalog. On the client, current AG-UI/CopilotKit examples register a
runtime `Catalog` instance that carries the catalog id, renderer
implementations, and component schemas.

```ts
import { Catalog } from "@copilotkit/a2ui-renderer";
import type { ReactComponentImplementation } from "@copilotkit/a2ui-renderer";
import { ProductCard, Row } from "./a2ui-renderers";

export const productCatalog = new Catalog<ReactComponentImplementation>(
  "https://example.com/catalogs/product-catalog.json",
  [Row, ProductCard],
  [],
);
```

Each renderer implementation should expose a runtime schema, usually from Zod
schemas that include the same component names and prop names the agent is
allowed to generate. TypeScript types alone are not enough; the middleware and
adapter need runtime schema data to instruct and validate generated components.

Server-side inline catalogs are still useful when the host owns validation
directly. When passing an inline catalog to `A2UIMiddleware.schema` or an
adapter's `a2ui.catalog`, use the v0.9 inline catalog shape:
`{ catalogId, components }`. The `catalogId` must match the client
`Catalog` id.

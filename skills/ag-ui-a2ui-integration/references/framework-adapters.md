# Framework Adapters

Start from the app's existing agent framework. Use the relevant AG-UI adapter
and its A2UI helpers instead of hand-rolling event translation when an adapter
exists.

The examples below are common adapter patterns, not the complete AG-UI support
matrix. For any other AG-UI-supported framework, search `integrations/`, the
AG-UI docs, the current CLI source, and any framework-specific skills before
choosing an implementation path.

## Choose Fixed or Dynamic A2UI

- **Fixed schema**: the app owns the component tree. Backend tools return an
  `a2ui_operations` envelope from `@ag-ui/a2ui-toolkit` /
  `ag_ui_a2ui_toolkit`. Use this for search results, dashboards, known cards,
  and workflows with stable layouts.
- **Dynamic schema**: the model composes a component tree from a catalog. Use
  the framework adapter's A2UI tool factory or auto-injection path so the main
  agent calls `generate_a2ui` and a sub-agent streams `render_a2ui`.

## ADK

AG-UI provides Python ADK middleware through `ag_ui_adk`.

For ordinary AG-UI serving, wrap the ADK agent and add the FastAPI endpoint:

```python
from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from google.adk.agents import LlmAgent

adk_agent = LlmAgent(
    model="gemini-2.5-pro",
    name="assistant",
    instruction="You are a helpful assistant.",
)

agent = ADKAgent(
    adk_agent=adk_agent,
    app_name="my_app",
    user_id="user123",
    use_in_memory_services=True,
)

app = FastAPI()
add_adk_fastapi_endpoint(app, agent, path="/chat")
```

For dynamic A2UI, keep the ADK agent's tool list free of manual A2UI tools and
configure the wrapper's `a2ui` options. The runtime or per-agent
`A2UIMiddleware` forwards `injectA2UITool`; the ADK adapter then injects
`generate_a2ui`, infers the sub-agent model, streams nested `render_a2ui`
events, and returns the final envelope.

```python
agent = ADKAgent(
    adk_agent=adk_agent,
    app_name="demo_app",
    user_id="demo_user",
    use_in_memory_services=True,
    a2ui={
        "default_catalog_id": "https://example.com/catalogs/product-catalog.json",
        "guidelines": {
            "composition_guide": "Use ProductCard for product comparisons.",
        },
    },
)
```

For fixed A2UI, define normal ADK backend tools that return a dict envelope
with `A2UI_OPERATIONS_KEY`, `create_surface`, `update_components`, and
`update_data_model`. Return a dict, not a JSON string, so ADK preserves the
envelope shape for the middleware.

## LangGraph

AG-UI provides Python and TypeScript LangGraph integrations. Keep the graph's
state model intact and add A2UI as tools/context around the graph.

Python FastAPI endpoint:

```python
from fastapi import FastAPI
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from my_langgraph_workflow import graph

app = FastAPI()
add_langgraph_fastapi_endpoint(app, graph, "/agent")
```

TypeScript dynamic A2UI tool:

```ts
import { getA2UITools } from "@ag-ui/langgraph";

const a2ui = getA2UITools({
  model: subagentModel,
  defaultCatalogId: "https://example.com/catalogs/product-catalog.json",
  guidelines: {
    compositionGuide: "Use ProductCard for product comparisons.",
  },
});

const modelWithTools = chatModel.bindTools([...state.tools, a2ui], {
  parallel_tool_calls: false,
});
```

LangGraph streams nested model tool-call deltas natively, so the adapter can
surface `render_a2ui` progress without custom events. Preserve that streaming
path; using a non-streaming invoke path removes progressive paint.

## Strands

AG-UI provides TypeScript and Python Strands integrations. For TypeScript,
`@ag-ui/aws-strands` exposes both explicit and auto-injected A2UI paths.

```ts
import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createStrandsApp } from "@ag-ui/aws-strands/server";

const strandsAgent = new Agent({
  model,
  systemPrompt,
});

const aguiAgent = new StrandsAgent({
  agent: strandsAgent,
  a2ui: {
    injectA2UITool: true,
    defaultCatalogId: "https://example.com/catalogs/product-catalog.json",
    guidelines: {
      compositionGuide: "Use ProductCard for product comparisons.",
    },
  },
});

const app = await createStrandsApp(aguiAgent, { path: "/invocations" });
app.listen(8080);
```

The adapter's auto-injection reads the runtime `injectA2UITool` flag or its
own `a2ui.injectA2UITool` config, registers `generate_a2ui`, drops the raw
`render_a2ui` tool, and streams nested render progress onto the AG-UI wire.
If the agent is a multi-agent orchestrator with no inferable model, wire
`getA2UITools()` explicitly.

For fixed Strands A2UI, return a plain object envelope from backend tools; the
adapter serializes it into the tool result the middleware scans for
`a2ui_operations`.

## .NET

AG-UI now includes a .NET SDK and framework-specific public skills under
`sdks/dotnet/plugins/ag-ui-dotnet/skills/`. For .NET apps, use the relevant
`agui-dotnet-*` skill first for client/server setup, tools, shared state,
interrupts, protobuf, or troubleshooting. Then apply this A2UI skill only for
the cross-framework A2UI decisions: fixed envelope vs dynamic generation,
catalog ids, and renderer wiring.

## Other AG-UI-Supported Frameworks

For frameworks not shown above, follow this order:

1. Search `integrations/` for the framework name and A2UI-specific files.
2. Check `sdks/typescript/packages/cli/src/index.ts` for a scaffold flag.
3. Check the AG-UI docs and framework README for package names and endpoint
   helpers.
4. If a framework A2UI tool factory exists, use it.
5. If no A2UI tool factory exists, return fixed `a2ui_operations` envelopes
   from backend tools or implement the custom AG-UI agent path.
6. Apply shared middleware, renderer, catalog, and verification steps from the
   other references in this skill.

## Custom AG-UI Agents

For a custom backend, keep the AG-UI stream valid:

- Start each run with `RUN_STARTED`.
- Emit text, tool, state, and A2UI-related events in order.
- End with `RUN_FINISHED` or `RUN_ERROR`.
- Preserve `threadId`, `runId`, message ids, and tool call ids consistently.
- Prefer `A2UIMiddleware` to translate A2UI tool results/actions into AG-UI
  events.
- Use the encoder packages where available instead of ad hoc SSE formatting.

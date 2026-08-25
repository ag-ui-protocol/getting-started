# Sources

This skill is based on the AG-UI repo sources and the public A2UI/CopilotKit
runtime docs.

## AG-UI Repository Sources

- `middlewares/a2ui-middleware/src/index.ts` - `A2UIMiddleware`, schema
  context, `a2ui-surface` activity snapshots, action forwarding, and runtime
  tool interception.
- `middlewares/a2ui-middleware/src/tools.ts` - `render_a2ui` and
  `log_a2ui_event` tool contracts.
- `middlewares/a2ui-middleware/src/types.ts` - middleware config, inline
  catalog schema, `injectA2UITool`, recognized A2UI tool names, and
  `defaultCatalogId`.
- `apps/dojo/src/app/api/copilotkit/[integrationId]/[[...slug]]/route.ts` -
  current CopilotRuntime v2 A2UI config shape.
- `apps/dojo/src/agents.ts` - per-agent `A2UIMiddleware` wiring for ADK and
  Strands dynamic A2UI agents.
- `integrations/` - AG-UI-supported framework integrations and examples.
- `sdks/typescript/packages/cli/src/index.ts` - supported `create-ag-ui-app`
  framework flags.
- `integrations/adk-middleware/python/src/ag_ui_adk/a2ui_tool.py` - ADK
  dynamic A2UI `generate_a2ui` adapter.
- `integrations/adk-middleware/python/examples/server/api/a2ui_dynamic_schema.py`
  - ADK dynamic schema example.
- `integrations/adk-middleware/python/examples/server/api/a2ui_fixed_schema.py`
  - ADK fixed schema `a2ui_operations` example.
- `integrations/langgraph/typescript/src/a2ui-tool.ts` - LangGraph TypeScript
  dynamic A2UI tool factory.
- `integrations/langgraph/python/ag_ui_langgraph/a2ui_tool.py` - LangGraph
  Python dynamic A2UI tool factory.
- `integrations/langgraph/python/README.md` - LangGraph FastAPI endpoint
  pattern.
- `integrations/aws-strands/typescript/src/a2ui-tool.ts` - Strands explicit and
  auto-injected A2UI tools.
- `integrations/aws-strands/typescript/src/config.ts` - Strands `a2ui` adapter
  config.
- `integrations/aws-strands/typescript/examples/server/api/a2ui-fixed-schema.ts`
  - Strands fixed schema `a2ui_operations` example.
- `sdks/dotnet/plugins/ag-ui-dotnet/skills/` - new framework-specific .NET
  skills that should be used before cross-framework A2UI guidance in .NET apps.

## External Sources

- CopilotKit public skills layout:
  <https://github.com/CopilotKit/CopilotKit/tree/main/skills>
- CopilotKit A2UI docs:
  <https://docs.copilotkit.ai/generative-ui/a2ui>
- A2UI docs:
  <https://a2ui.org/>
- AG-UI docs:
  <https://docs.ag-ui.com/>

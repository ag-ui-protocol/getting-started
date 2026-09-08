# ag-ui-a2ui-toolkit

Framework-agnostic helpers for building A2UI subagent tools.

Each per-framework adapter (LangGraph, ADK, Mastra, …) composes these helpers
with its own framework-specific glue: tool decorator, runtime accessor, model
binding + invoke. Nothing in this package depends on any agent framework.

## Surface

- Constants: `A2UI_OPERATIONS_KEY`, `BASIC_CATALOG_ID`, `DEFAULT_SURFACE_ID`,
  `GENERATE_A2UI_TOOL_NAME`, `GENERATE_A2UI_TOOL_DESCRIPTION`,
  `GENERATE_A2UI_ARG_DESCRIPTIONS`
- Op builders: `create_surface`, `update_components`, `update_data_model`
- `RENDER_A2UI_TOOL_DEF` — JSON schema for the inner structured-output tool
- State + history helpers: `build_context_prompt`, `find_prior_surface`
- Prompt composer: `build_subagent_prompt`
- High-level orchestration: `prepare_a2ui_request`, `build_a2ui_envelope`
- Output wrappers: `assemble_ops`, `wrap_as_operations_envelope`,
  `wrap_error_envelope`

## See also

The TypeScript counterpart lives in
[`@ag-ui/a2ui-toolkit`](../../typescript/packages/a2ui-toolkit) and exposes the
same surface in camelCase.

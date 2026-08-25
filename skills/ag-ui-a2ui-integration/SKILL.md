---
name: ag-ui-a2ui-integration
description: "Use when adding A2UI rendering to any AG-UI-supported framework or custom AG-UI application, scaffolding an AG-UI app that should render A2UI, adapting an AG-UI integration to emit A2UI surfaces, or wiring the AG-UI A2UI middleware/toolkit with a compatible renderer."
version: 1.1.0
---

# AG-UI + A2UI Integration Skill

## Overview

Use this skill to add A2UI rendering to an AG-UI application. Treat AG-UI as
the transport and agent integration layer, `@ag-ui/a2ui-middleware` as the
server-side bridge that detects and paints A2UI operations, and A2UI as the UI
payload format that the client renderer displays.

This is a developer-facing skill artifact. It is meant to be loaded by coding
agents and used against a real app or repo, not published as a docs page.

## When to Use

- Adding A2UI rendering to an existing AG-UI app.
- Creating an AG-UI quickstart that should display A2UI surfaces.
- Connecting any AG-UI-supported framework or custom AG-UI agent to an
  A2UI-capable frontend.
- Adding or extending an A2UI component catalog.
- Debugging why an A2UI surface does not render or why a user action does not
  flow back to the agent.

## When NOT to Use

- For AG-UI protocol event semantics only, use the AG-UI protocol skill or
  protocol docs.
- For A2UI renderer internals outside an AG-UI app, use the A2UI renderer
  docs or renderer-specific skills.
- For generic CopilotKit frontend work without A2UI, use CopilotKit-specific
  setup and React skills.

## Workflow

1. Inspect the app shape: framework adapter, AG-UI agent endpoint, runtime
   host, frontend shell, and any existing A2UI renderer/catalog.
2. Decide the A2UI mode before editing code:
   - Fixed schema: backend tools return an `a2ui_operations` envelope with
     `createSurface`, `updateComponents`, and `updateDataModel`.
   - Dynamic schema: a framework A2UI tool (`generate_a2ui`) delegates to a
     sub-agent that streams `render_a2ui` args through `A2UIMiddleware`.
3. Select framework-specific wiring from
   `references/framework-adapters.md`, or use that reference to find the
   closest AG-UI integration pattern. Preserve the app's existing agent
   architecture.
4. Wire server middleware/runtime and client renderer using
   `references/a2ui-runtime-and-renderer.md`. Avoid double-applying
   `A2UIMiddleware`; use either runtime-level A2UI config or per-agent
   `agent.use(new A2UIMiddleware(...))` for a given agent.
5. Register a catalog on the client. With CopilotKit >= 1.61.2, forwarding it to
   the provider (`a2ui={{ catalog }}`) auto-enables A2UI and auto-derives
   `defaultCatalogId` from the catalog's id. Only when you are not forwarding a
   catalog, ensure the middleware or adapter sets a `defaultCatalogId` matching
   the renderer-registered catalog.
6. Verify the streaming path with `references/verification.md`: AG-UI stream,
   `a2ui-surface` activity snapshots or `a2ui_operations`, rendered A2UI
   surface, and a user interaction flowing back through AG-UI.

## AG-UI Framework Support

This skill is not limited to the framework examples below. For any target
framework, first check the AG-UI repository's `integrations/` directory, the
AG-UI docs, the framework adapter's A2UI files, and the current CLI source. If
AG-UI supports the framework, use that integration's documented package,
endpoint helper, A2UI tool factory, or scaffold path. If there is no framework
A2UI adapter, implement the custom AG-UI agent path, return `a2ui_operations`
from backend tools for fixed layouts, and keep the middleware/client wiring the
same.

## Common AG-UI CLI Flags

Use the CLI flags that exist in `sdks/typescript/packages/cli/src/index.ts`.
The table is a quick reference for known scaffold paths, not the full AG-UI
support matrix. Do not invent flags.

| Framework            | CLI flag         |
| -------------------- | ---------------- |
| ADK                  | `--adk`          |
| LangGraph Python     | `--langgraph-py` |
| LangGraph JavaScript | `--langgraph-js` |
| CrewAI Flows         | `--crewai-flows` |
| Mastra               | `--mastra`       |
| Pydantic AI          | `--pydantic-ai`  |
| LlamaIndex           | `--llamaindex`   |
| Agno                 | `--agno`         |
| AG2                  | `--ag2`          |

Strands has AG-UI integration packages and examples, but no Strands CLI flag
is present in the current AG-UI CLI source. Use the Strands integration docs
instead of guessing a scaffold command.

## Key Rules

- Keep the integration AG-UI-first for every supported framework. CopilotKit is
  a common runtime/renderer path for web apps, but AG-UI owns the middleware,
  framework adapters, and wire events.
- Enable A2UI on both sides: `A2UIMiddleware` or runtime A2UI config on the
  server, and an A2UI-capable renderer/catalog on the client.
- For dynamic schema, prefer the framework adapter's A2UI tool factory or
  auto-injection path. The model should call `generate_a2ui`; the sub-agent
  should stream `render_a2ui` args so the middleware can progressively paint.
- For fixed schema, return an `a2ui_operations` envelope from backend tools
  rather than asking the model to invent component trees.
- Emit `createSurface` once per `surfaceId`; use update operations for later
  changes.
- Do not let the model invent catalog ids. When the client forwards a catalog to
  the provider (CopilotKit >= 1.61.2), its `catalogId` is derived automatically;
  otherwise the host/middleware/adapter should stamp a `defaultCatalogId` that
  matches the client-registered catalog.
- Preserve AG-UI run boundaries and error events. Do not swallow server or
  stream errors.
- Verify with a real browser or client run when possible. A static typecheck is
  not enough for streaming UI work.

## References

- `references/framework-adapters.md` - framework-specific AG-UI adapter
  patterns.
- `references/a2ui-runtime-and-renderer.md` - server/client A2UI wiring and
  catalog patterns.
- `references/verification.md` - checks to confirm the integration works.
- `sources.md` - source files and docs used by this skill.

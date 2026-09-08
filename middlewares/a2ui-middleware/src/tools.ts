import { Tool } from "@ag-ui/client";

/**
 * Tool name for the structured render_a2ui tool
 */
export const RENDER_A2UI_TOOL_NAME = "render_a2ui";

/**
 * Tool name for logging A2UI events (synthetic, used for context)
 */
export const LOG_A2UI_EVENT_TOOL_NAME = "log_a2ui_event";

/**
 * Tool definition for rendering A2UI surfaces.
 * This tool is injected into the agent's available tools when injectA2UITool is true.
 * Uses structured parameters (surfaceId, components, data) — the catalog id
 * is owned by the middleware config, not chosen by the model.
 */
export const RENDER_A2UI_TOOL: Tool = {
  name: RENDER_A2UI_TOOL_NAME,
  description:
    "Render a dynamic A2UI v0.9 surface with structured parameters. " +
    "Follow the A2UI render tool usage guide provided in context.",
  parameters: {
    type: "object",
    properties: {
      surfaceId: {
        type: "string",
        description: "Unique surface identifier.",
      },
      components: {
        type: "array",
        description:
          "A2UI v0.9 component array (flat format). The root component must have id \"root\".",
        items: { type: "object" },
      },
      data: {
        type: "object",
        description:
          "Initial data model for the surface. Written to the root path. " +
          "Use for pre-filling form values (e.g. {\"form\": {\"name\": \"Alice\"}}) " +
          "or providing data for components bound to data model paths.",
      },
    },
    required: ["surfaceId", "components"],
  },
};

/**
 * Usage guidelines injected as context when injectA2UITool is enabled.
 * Provides the LLM with protocol instructions and a minimal example
 * for calling render_a2ui correctly.
 */
export const RENDER_A2UI_TOOL_GUIDELINES = (toolName: string) => `\
## How to call ${toolName}

You MUST provide ALL required arguments when calling ${toolName}:

- **surfaceId** (string, required): Unique ID for the surface (e.g. "sales-dashboard").
- **components** (array, REQUIRED): A2UI v0.9 flat component array. NEVER omit this.
- **data** (object, optional): Initial data model for path-bound component values.

Note: the catalog id is set by the host, not by you. Do not include a catalogId argument.

### Component format (v0.9 flat)

Components are a flat array — children are referenced by ID, not nested:
- Every component has \`id\` (unique) and \`component\` (type name from the available catalog).
- The root component MUST have \`id: "root"\`.
- Properties go directly on the component object.
- Use \`children: ["id1", "id2"]\` for multiple children, \`child: "id"\` for a single child.

### Minimal example

\`\`\`json
{
  "surfaceId": "my-dashboard",
  "components": [
    { "id": "root", "component": "Column", "children": ["title", "row1"] },
    { "id": "title", "component": "Title", "text": "Overview" },
    { "id": "row1", "component": "Row", "children": ["m1", "m2"], "gap": 16 },
    { "id": "m1", "component": "Metric", "label": "Users", "value": "1,200" },
    { "id": "m2", "component": "Metric", "label": "Revenue", "value": "$50K" }
  ]
}
\`\`\`

### Key rules

1. NEVER call ${toolName} without the \`components\` array — the UI will be empty.
2. Root must be a layout component (Column, Row, Card) — not Text or Button.
3. Component IDs must be unique. A component must NOT reference itself as child.
4. Only use component names from the Available Components schema in context.
5. For data binding use \`{ "path": "/key" }\` (absolute) or \`{ "path": "key" }\` (relative inside templates).
6. For repeating content: \`children: { componentId: "card-id", path: "/items" }\` repeats per array item.
7. Button actions: \`"action": { "event": { "name": "action_name", "context": { ... } } }\` — event must be an object.
8. No placeholder images — only use real URLs or Icon components.`;

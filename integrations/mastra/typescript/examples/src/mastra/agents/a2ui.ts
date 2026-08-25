import { Agent } from "@mastra/core/agent";
// Bridge-free subpath: the remote Mastra server only needs the A2UI tool
// factory, not the AbstractAgent bridge (whose @ag-ui/client → uuid dep the
// Mastra CLI bundler can't resolve).
import { getA2UITools, type A2UIAttemptRecord } from "@ag-ui/mastra/a2ui";

/**
 * A2UI demo agents for the REMOTE Mastra server (accessed via MastraClient /
 * `MastraAgent.getRemoteAgents`). Unlike the in-process bridge — which
 * auto-injects `generate_a2ui` — a remote Mastra server owns its own agents, so
 * the tool is wired EXPLICITLY here via the shared `getA2UITools` factory
 * (backend-owned). This matches how LangGraph's REMOTE demos wire the tool in
 * the deployed graph. The render subagent streams its `render_a2ui` deltas over
 * the server `fullStream`, which MastraClient forwards to the AG-UI bridge, so
 * recovery + subagent + progressive streaming all work over the wire.
 */

const A2UI_MODEL = "openai/gpt-4.1";
const A2UI_DOJO_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

const COMPOSITION_GUIDE = `
## Available Pre-made Components

Use Row as the root with structural children to repeat a card per item.

### Row
Layout container. Repeat a card template via structural children:
  {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

### HotelCard / ProductCard / TeamMemberCard
Card components bound to per-item data (relative paths inside the template).

## RULES
- Root is ALWAYS a Row with structural children: {"componentId":"<card-id>","path":"/items"}
- ALWAYS include the referenced card component in the components array.
- Inside templates, use RELATIVE paths (no leading slash): {"path":"name"} not {"path":"/name"}
- Always provide data in the "data" argument as {"items":[...]}
- Generate 3-4 realistic items with diverse data.
`;

const SYSTEM_PROMPT = `You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (hotel/product comparisons, team rosters, lists, cards, etc.),
use the generate_a2ui tool to create a dynamic A2UI surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm what was rendered.`;

function makeGenerateA2uiTool() {
  return getA2UITools({
    model: A2UI_MODEL,
    defaultCatalogId: A2UI_DOJO_CATALOG_ID,
    guidelines: { compositionGuide: COMPOSITION_GUIDE },
    recovery: { maxAttempts: 3 },
    onA2UIAttempt: (rec: A2UIAttemptRecord) => {
      // eslint-disable-next-line no-console
      console.log(
        `[a2ui recovery] attempt ${rec.attempt}: ${rec.ok ? "valid" : "invalid"}`,
        rec.errors,
      );
    },
  });
}

export const a2uiDynamicSchemaAgent = new Agent({
  id: "a2ui_dynamic_schema",
  name: "a2ui_dynamic_schema",
  instructions: SYSTEM_PROMPT,
  model: A2UI_MODEL,
  tools: { generate_a2ui: makeGenerateA2uiTool() },
});

export const a2uiRecoveryAgent = new Agent({
  id: "a2ui_recovery",
  name: "a2ui_recovery",
  instructions: SYSTEM_PROMPT,
  model: A2UI_MODEL,
  tools: { generate_a2ui: makeGenerateA2uiTool() },
});

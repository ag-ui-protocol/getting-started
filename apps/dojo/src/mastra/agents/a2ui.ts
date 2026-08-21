import { Agent } from "@mastra/core/agent";
import type { A2UIAttemptRecord, A2UIInjectConfig } from "@ag-ui/mastra";

// Provider-string model, resolved by Mastra's model router (respects
// OPENAI_BASE_URL, so it targets aimock in e2e and a real key in dev). Matches
// the other dojo Mastra agents; the render subagent inside the auto-injected
// generate_a2ui tool resolves it the same way, so the package never couples to
// an @ai-sdk provider version.
const A2UI_MODEL = "openai/gpt-4.1";

/**
 * Mastra A2UI demo agents (dynamic-schema + error-recovery).
 *
 * These are PLAIN Mastra agents — they wire NO A2UI tool. The `@ag-ui/mastra`
 * bridge AUTO-INJECTS the backend-owned `generate_a2ui` tool per run (pillar 1:
 * easy devex) when the runtime forwards `injectA2UITool` (the dojo copilotkit
 * route sets it for mastra-agent-local). Injection carries the shared toolkit
 * recovery loop (validate→retry) + the render_a2ui subagent, and — with the
 * progressive-streaming path — paints incrementally. Customization (model,
 * catalog id, composition guide, recovery cap) rides the `a2ui` config on the
 * MastraAgent wrapper (see src/agents.ts), NOT hand-wired tools. This mirrors
 * the LangGraph / Strands ports.
 *
 * The dynamic demo is the happy path; the recovery demo is a byte-identical
 * agent whose demo prompts (frontend feature page + aimock fixtures) force a
 * structurally-invalid first render so the recovery loop is visible.
 */
export const a2uiDynamicSchemaAgent = new Agent({
  id: "a2ui_dynamic_schema",
  name: "a2ui_dynamic_schema",
  instructions: A2UI_INSTRUCTIONS(),
  model: A2UI_MODEL,
});

export const a2uiRecoveryAgent = new Agent({
  id: "a2ui_recovery",
  name: "a2ui_recovery",
  instructions: A2UI_INSTRUCTIONS(),
  model: A2UI_MODEL,
});

function A2UI_INSTRUCTIONS(): string {
  return `You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (hotel/product comparisons, team rosters, lists, cards, etc.),
use the generate_a2ui tool to create a dynamic A2UI surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm what was rendered.`;
}

// The dojo dynamic-A2UI catalog (HotelCard / ProductCard / TeamMemberCard /
// Row). The subagent never picks the catalog — the factory stamps this id onto
// every surface it creates. Matches `A2UI_DOJO_CATALOG_ID` in src/agents.ts and
// the LangGraph/Strands recovery demos so all frameworks render one catalog.
const A2UI_DOJO_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

// Grounds the render subagent on the dojo catalog's components so a REAL LLM
// (not just aimock) emits resolvable surfaces. Shared verbatim with the
// LangGraph/Strands recovery demos.
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

/**
 * A2UI auto-inject config passed to the MastraAgent wrapper (src/agents.ts). The
 * dev customizes via these PROPS (not hand-wired tools): model the render
 * subagent runs, catalog id stamped on surfaces, composition guide, recovery cap.
 */
export const a2uiInjectConfig: A2UIInjectConfig = {
  model: A2UI_MODEL,
  defaultCatalogId: A2UI_DOJO_CATALOG_ID,
  guidelines: { compositionGuide: COMPOSITION_GUIDE },
  recovery: { maxAttempts: 3 },
  onA2UIAttempt: (rec: A2UIAttemptRecord) => {
    // Dev observability: each attempt (incl. rejected ones) is logged.
    console.log(
      `[a2ui recovery] attempt ${rec.attempt}: ${rec.ok ? "valid" : "invalid"}`,
      rec.errors,
    );
  },
};

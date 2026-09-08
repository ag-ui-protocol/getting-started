/**
 * A2UI recovery agent (OSS-162) — DRAFT showcase, verify before wiring.
 *
 * A clone of `a2ui_dynamic_schema` that showcases the error-recovery loop. It
 * needs NO new mechanism: on this branch `getA2UITools` already runs
 * `runA2UIGenerationWithRecovery` (default 3 attempts) and the middleware gate
 * runs at the component-close boundary — both default to STRUCTURAL validation
 * when no catalog is supplied (missing root, dangling child reference,
 * unresolved binding, malformed/empty components). So this rides the exact same
 * runtime A2UI wiring as the existing demos (add it to the runtime `a2ui.agents`
 * list); no catalog/`schema` and no A/B middleware choice required.
 *
 * In the dojo demo the sub-agent's render_a2ui output is driven by aimock: the
 * first attempt emits a structurally-invalid surface (a Row whose repeated child
 * references a `card` component the model forgot to include → "unresolved child"),
 * which the gate suppresses (no wipe) and the loop regenerates with the error fed
 * back, then a valid surface paints. A second prompt forces repeated failure to
 * demonstrate the tasteful hard-failure state.
 *
 * (Catalog-aware SEMANTIC validation — unknown component / missing required prop —
 * is the separate, optional scope that would need the catalog wired; not used here.)
 */

import { createAgent } from "langchain";
import { copilotkitMiddleware } from "@copilotkit/sdk-js/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { getA2UITools, type A2UIAttemptRecord } from "@ag-ui/langgraph";

const CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

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

const a2uiTool = getA2UITools({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  defaultCatalogId: CUSTOM_CATALOG_ID,
  guidelines: { compositionGuide: COMPOSITION_GUIDE },
  // Recovery loop runs by default; set explicitly for the showcase. No catalog
  // → structural validation (which is all this demo's error needs).
  recovery: { maxAttempts: 3 },
  onA2UIAttempt: (rec: A2UIAttemptRecord) => {
    // Dev observability: each attempt (incl. rejected ones) is logged.
    // eslint-disable-next-line no-console
    console.log(
      `[a2ui recovery] attempt ${rec.attempt}: ${rec.ok ? "valid" : "invalid"}`,
      rec.errors,
    );
  },
});

export const a2uiRecoveryGraph = createAgent({
  model: "openai:gpt-4o",
  // Cast: tool typed against @ag-ui/langgraph's own @langchain/core peer.
  tools: [a2uiTool as any],
  middleware: [copilotkitMiddleware],
  systemPrompt: `You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (hotel/product comparisons, team rosters, lists, cards, etc.),
use the generate_a2ui tool to create a dynamic A2UI surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm what was rendered.`,
});

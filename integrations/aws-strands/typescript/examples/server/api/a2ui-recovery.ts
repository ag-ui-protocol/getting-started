/**
 * A2UI Error Recovery example for AWS Strands (TypeScript).
 *
 * A plain agent with no a2ui wiring. The adapter auto-injects `generate_a2ui`,
 * which validates each generated surface and retries on failure (up to 3
 * total attempts) before falling back to a tasteful hard-failure.
 */

import { Agent } from "@strands-agents/sdk";
import { StrandsAgent } from "@ag-ui/aws-strands";
import { createModel } from "../model-factory";

// The dojo registers its dynamic component catalog under this id; auto-injected
// surfaces must reference it so the renderer can resolve their components.
const DOJO_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

// Teaches the sub-agent how to compose the dojo catalog's components. Mirrors
// the LangGraph recovery demo's COMPOSITION_GUIDE.
const COMPOSITION_GUIDE = `
## Available Pre-made Components

Use Row as the root with structural children to repeat a card per item.

### Row
Repeat a card template via structural children:
  {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

### HotelCard / ProductCard / TeamMemberCard
Card components bound to per-item data (relative paths inside the template).

## RULES
- Root is ALWAYS a Row with structural children: {"componentId":"<card-id>","path":"/items"}
- ALWAYS include the referenced card component in the components array.
- Inside templates use RELATIVE paths (no leading slash): {"path":"name"}.
- Always provide data in the "data" argument as {"items":[...]}.
- Generate 3-4 realistic items with diverse data.
`;

const SYSTEM_PROMPT = `You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (hotel/product comparisons, team rosters,
lists, cards, etc.), use the generate_a2ui tool to create a dynamic A2UI surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response.
The tool renders UI automatically. Just confirm what was rendered.`;

export async function createA2UIRecoveryAgent(): Promise<StrandsAgent> {
  const agent = new Agent({
    // Chat Completions API: the Responses adapter buffers tool-call argument
    // deltas, which would defeat A2UI's progressive surface streaming.
    model: await createModel({ openaiApi: "chat" }),
    systemPrompt: SYSTEM_PROMPT,
    // generate_a2ui is auto-injected by the adapter; nothing wired here.
  });

  return new StrandsAgent({
    agent,
    name: "a2ui_recovery",
    description:
      "Dynamic A2UI with automatic error recovery (auto-injected tool)",
    config: {
      a2ui: {
        defaultCatalogId: DOJO_CATALOG_ID,
        guidelines: { compositionGuide: COMPOSITION_GUIDE },
      },
    },
  });
}

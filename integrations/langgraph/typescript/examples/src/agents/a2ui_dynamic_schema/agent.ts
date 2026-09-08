/**
 * Dynamic A2UI agent (prebuilt).
 *
 * Uses LangChain's `createAgent` prebuilt with the AG-UI `getA2UITools`
 * factory. A secondary LLM (the subagent shipped inside the factory) designs
 * the A2UI components and data; the AG-UI middleware detects the resulting
 * `a2ui_operations` payload in the tool result and renders the surface.
 */

import { createAgent } from "langchain";
import { copilotkitMiddleware } from "@copilotkit/sdk-js/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { getA2UITools } from "@ag-ui/langgraph";

const CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json";

// Project-specific composition rules — tells the subagent how to use the
// pre-made domain components (HotelCard, ProductCard, TeamMemberCard) shipped
// in the dojo's dynamic catalog.
const COMPOSITION_GUIDE = `
## Available Pre-made Components

You have 4 components. Use Row as the root with structural children to repeat a card per item.

### Row
Layout container. Use structural children to repeat a card template:
  {"id":"root","component":"Row","children":{"componentId":"card","path":"/items"}}

### HotelCard
Props: name, location, rating (number 0-5), pricePerNight, amenities (optional), action
Example:
  {"id":"card","component":"HotelCard","name":{"path":"name"},"location":{"path":"location"},
   "rating":{"path":"rating"},"pricePerNight":{"path":"pricePerNight"},
   "action":{"event":{"name":"book","context":{"name":{"path":"name"}}}}}

### ProductCard
Props: name, price, rating (number 0-5), description (optional), badge (optional), action
Example:
  {"id":"card","component":"ProductCard","name":{"path":"name"},"price":{"path":"price"},
   "rating":{"path":"rating"},"description":{"path":"description"},
   "action":{"event":{"name":"select","context":{"name":{"path":"name"}}}}}

### TeamMemberCard
Props: name, role, department (optional), email (optional), avatarUrl (optional), action
Example:
  {"id":"card","component":"TeamMemberCard","name":{"path":"name"},"role":{"path":"role"},
   "department":{"path":"department"},"email":{"path":"email"},
   "action":{"event":{"name":"contact","context":{"name":{"path":"name"}}}}}

## RULES
- Root is ALWAYS a Row with structural children: {"componentId":"<card-id>","path":"/items"}
- Inside templates, use RELATIVE paths (no leading slash): {"path":"name"} not {"path":"/name"}
- Always provide data in the "data" argument as {"items":[...]}
- Pick the card type that best matches the user's request
- Generate 3-4 realistic items with diverse data
`;

const a2uiTool = getA2UITools({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  defaultCatalogId: CUSTOM_CATALOG_ID,
  guidelines: { compositionGuide: COMPOSITION_GUIDE },
});

const a2uiDynamicSchemaAgent = createAgent({
  model: "openai:gpt-4o",
  // Cast: tool returned by `getA2UITools` is typed against `@ag-ui/langgraph`'s
  // own `@langchain/core` peer, which can skew vs. the consumer's pin.
  tools: [a2uiTool as any],
  middleware: [copilotkitMiddleware],
  systemPrompt: `You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (product comparisons, dashboards, lists, cards, etc.),
use the generate_a2ui tool to create a dynamic A2UI surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm what was rendered.`,
});

// Export the inner graph, not the ReactAgent wrapper, so LangGraph Platform can
// inject its managed checkpointer (the wrapper swallows the injection —
// langchainjs#10144 — causing MISSING_CHECKPOINTER on the 2nd turn deployed).
export const a2uiDynamicSchemaGraph = a2uiDynamicSchemaAgent.graph;

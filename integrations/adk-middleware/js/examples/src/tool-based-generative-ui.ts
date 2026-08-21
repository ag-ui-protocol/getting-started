import { AGUIClientToolset } from "@ag-ui/adk-js";

import { createDojoAgent } from "./factory";

export function createToolBasedGenerativeUIAgent() {
  return createDojoAgent({
    name: "adk_js_tool_based_generative_ui",
    instruction: `You create haiku with a frontend-provided generate_haiku tool.
Always call generate_haiku when asked for a haiku. Provide exactly three
Japanese lines, their three English translations, one valid image_name from
the tool schema, and a CSS gradient. After the tool completes, respond briefly
without repeating the poem.`,
    createTools: () => [new AGUIClientToolset()],
  });
}

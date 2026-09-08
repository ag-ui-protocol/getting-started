/**
 * A simple agentic chat flow using LangGraph with AG-UI middleware.
 *
 * The AG-UI middleware handles:
 * - Injecting frontend tools from state.tools into the model
 * - Routing frontend tool calls (emit events, skip backend execution)
 */

import { createAgent } from "langchain";
import { copilotkitMiddleware } from "@copilotkit/sdk-js/langgraph";

const agenticChatAgent = createAgent({
  model: "openai:gpt-4o",
  tools: [],  // Backend tools go here
  middleware: [copilotkitMiddleware],
  systemPrompt: "You are a helpful assistant.",
});

// Export the inner graph, not the ReactAgent wrapper. On LangGraph Platform the
// server injects its managed checkpointer into the graph; the wrapper does not
// forward that injection to its private #graph (langchainjs#10144), so on the
// 2nd turn getState/resume fails with MISSING_CHECKPOINTER. Exporting `.graph`
// lets the platform inject persistence directly. No compiled checkpointer.
export const agenticChatGraph = agenticChatAgent.graph;

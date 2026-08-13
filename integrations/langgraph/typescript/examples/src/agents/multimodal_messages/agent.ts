/**
 * An example demonstrating multimodal message support with images.
 *
 * This agent demonstrates how to:
 * 1. Receive user messages with images
 * 2. Process multimodal content (text + images)
 * 3. Use vision models to analyze images
 *
 * Example usage:
 *
 * ```typescript
 * import { UserMessage, TextInputContent, BinaryInputContent } from "@ag-ui/core";
 *
 * // Create a multimodal user message
 * const message: UserMessage = {
 *   id: "user-123",
 *   role: "user",
 *   content: [
 *     { type: "text", text: "What's in this image?" },
 *     {
 *       type: "binary",
 *       mimeType: "image/jpeg",
 *       url: "https://example.com/photo.jpg"
 *     },
 *   ],
 * };
 *
 * // Or with base64 encoded data
 * const messageWithData: UserMessage = {
 *   id: "user-124",
 *   role: "user",
 *   content: [
 *     { type: "text", text: "Describe this picture" },
 *     {
 *       type: "binary",
 *       mimeType: "image/png",
 *       data: "iVBORw0KGgoAAAANSUhEUgAAAAUA...", // base64 encoded
 *       filename: "screenshot.png"
 *     },
 *   ],
 * };
 * ```
 *
 * The LangGraph integration automatically handles:
 * 1. Converting AG-UI multimodal format to LangChain's format
 * 2. Passing multimodal messages to vision models
 * 3. Converting responses back to AG-UI format
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, MessagesAnnotation, StateGraph, Command, START, END } from "@langchain/langgraph";
import { aguiTransformer } from "@ag-ui/langgraph/transformer";

const AgentStateAnnotation = Annotation.Root({
  tools: Annotation<any[]>({
    reducer: (x, y) => y ?? x,
    default: () => []
  }),
  ...MessagesAnnotation.spec,
});

type AgentState = typeof AgentStateAnnotation.State;

async function visionChatNode(state: AgentState, config?: RunnableConfig) {
  /**
   * Chat node that supports multimodal input including images.
   *
   * The messages in state can contain multimodal content with text and images.
   * LangGraph will automatically handle the conversion from AG-UI format to
   * the format expected by the vision model.
   */

  // 1. Use a vision-capable model
  // GPT-4o supports vision, as do other models like Claude 3
  const model = new ChatOpenAI({ model: "gpt-4o" });

  // Define config for the model
  if (!config) {
    config = { recursionLimit: 25 };
  }

  // 2. Bind tools if needed
  const modelWithTools = model.bindTools(
    state.tools ?? [],
    {
      parallel_tool_calls: false,
    }
  );

  // 3. Define the system message
  const systemMessage = new SystemMessage({
    content: "You are a helpful vision assistant. You can analyze images and " +
             "answer questions about them. Describe what you see in detail."
  });

  // 4. Run the model with multimodal messages
  // The messages may contain both text and images
  const response = await modelWithTools.invoke([
    systemMessage,
    ...state.messages,
  ], config);

  // 5. Return the response
  return new Command({
    goto: END,
    update: {
      messages: [response]
    }
  });
}

// Define a new graph
const workflow = new StateGraph(AgentStateAnnotation)
  .addNode("visionChatNode", visionChatNode)
  .addEdge(START, "visionChatNode")
  .addEdge("visionChatNode", END);

// Compile the graph
export const graph = workflow.compile({
  transformers: [aguiTransformer],
});

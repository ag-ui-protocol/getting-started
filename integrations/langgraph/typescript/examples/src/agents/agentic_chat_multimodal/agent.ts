/**
 * A multimodal agentic chat that can analyze images and other media.
 *
 * This agent demonstrates how to:
 * 1. Receive user messages with images
 * 2. Process multimodal content (text + images)
 * 3. Use vision models to analyze images
 *
 * Example usage:
 *
 * ```typescript
 * import { UserMessage, TextInputContent, ImageInputContent } from "@ag-ui/core";
 *
 * // Create a multimodal user message
 * const message: UserMessage = {
 *   id: "user-123",
 *   role: "user",
 *   content: [
 *     { type: "text", text: "What's in this image?" },
 *     {
 *       type: "image",
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
 *       type: "image",
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
   * Chat node that uses a vision-capable model to handle multimodal input.
   *
   * Images and other media sent by the user are automatically converted
   * to LangChain's multimodal format by the AG-UI integration layer.
   */

  // Use a vision-capable model
  const model = new ChatOpenAI({ model: "gpt-5.4" });

  // Define config for the model
  if (!config) {
    config = { recursionLimit: 25 };
  }

  // Bind tools if needed
  const modelWithTools = model.bindTools(
    state.tools ?? [],
    {
      parallel_tool_calls: false,
    }
  );

  // Define the system message
  const systemMessage = new SystemMessage({
    content: "You are a helpful assistant that can analyze images, documents, and other media. " +
             "When a user shares an image, describe what you see in detail. " +
             "When a user shares a document, summarize its contents."
  });

  // Run the model with multimodal messages
  const response = await modelWithTools.invoke([
    systemMessage,
    ...state.messages,
  ], config);

  // Return the response
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
export const agenticChatMultimodalGraph = workflow.compile({
  transformers: [aguiTransformer],
});

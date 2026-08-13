/**
 * A simple agentic chat flow using LangGraph instead of CrewAI.
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

async function chatNode(state: AgentState, config?: RunnableConfig) {
  /**
   * Standard chat node based on the ReAct design pattern. It handles:
   * - The model to use (and binds in CopilotKit actions and the tools defined above)
   * - The system prompt
   * - Getting a response from the model
   * - Handling tool calls
   *
   * For more about the ReAct design pattern, see: 
   * https://www.perplexity.ai/search/react-agents-NcXLQhreS0WDzpVaS4m9Cg
   */
  
  // 1. Define the model
  const model = new ChatOpenAI({ model: "gpt-4o" });
  
  // Define config for the model
  if (!config) {
    config = { recursionLimit: 25 };
  }

  // 2. Bind the tools to the model
  const modelWithTools = model.bindTools(
    [
      ...state.tools,
      // your_tool_here
    ],
    {
      // 2.1 Disable parallel tool calls to avoid race conditions,
      //     enable this for faster performance if you want to manage
      //     the complexity of running tool calls in parallel.
      parallel_tool_calls: false,
    }
  );

  // 3. Define the system message by which the chat model will be run
  const systemMessage = new SystemMessage({
    content: "You are a helpful assistant."
  });

  // 4. Run the model to generate a response
  const response = await modelWithTools.invoke([
    systemMessage,
    ...state.messages,
  ], config);

  // 6. We've handled all tool calls, so we can end the graph.
  return new Command({
    goto: END,
    update: {
      messages: [response]
    }
  })
}

// Define a new graph  
const workflow = new StateGraph(AgentStateAnnotation)
  .addNode("chat_node", chatNode)
  .addEdge(START, "chat_node");

// Compile the graph
export const agenticChatGraph = workflow.compile({
  transformers: [aguiTransformer],
});
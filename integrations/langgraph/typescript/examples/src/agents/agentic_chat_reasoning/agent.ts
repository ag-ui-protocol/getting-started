/**
 * A simple agentic chat flow using LangGraph with reasoning model support.
 *
 * This agent supports multiple model providers with reasoning/thinking capabilities:
 * - OpenAI (default): Uses o3 model
 * - Anthropic: Uses claude-sonnet-4-6 with manual thinking
 * - Gemini: Uses gemini-2.5-pro with thinking budget
 *
 * The model is selected based on the `model` field in the agent state.
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { SystemMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  Annotation,
  MessagesAnnotation,
  StateGraph,
  Command,
  START,
  END,
} from "@langchain/langgraph";

const AgentStateAnnotation = Annotation.Root({
  tools: Annotation<any[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  model: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
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
   */

  // 1. Define the model based on state
  let model;
  if (state.model === "Anthropic") {
    model = new ChatAnthropic({
      model: "claude-sonnet-4-6",
      thinking: { type: "enabled", budget_tokens: 2000 },
    });
  } else if (state.model === "Gemini") {
    model = new ChatGoogleGenerativeAI({
      model: "gemini-2.5-pro",
      thinkingBudget: 1024,
    });
  } else {
    // Default: OpenAI
    model = new ChatOpenAI({
      model: "o4-mini",
      useResponsesApi: true,
      reasoning: { effort: "high", summary: "auto" },
    });
  }

  // Define config for the model
  if (!config) {
    config = { recursionLimit: 25 };
  }

  // 2. Bind the tools to the model
  const modelWithTools = model.bindTools([...(state.tools ?? [])]);

  // 3. Define the system message
  const systemMessage = new SystemMessage({
    content: "You are a helpful assistant.",
  });

  // 4. Run the model to generate a response
  const response = await modelWithTools.invoke(
    [systemMessage, ...state.messages],
    config,
  );

  // 5. Return the response
  return new Command({
    goto: END,
    update: {
      messages: [response],
    },
  });
}

// Define a new graph
const workflow = new StateGraph(AgentStateAnnotation)
  .addNode("chatNode", chatNode)
  .addEdge(START, "chatNode")
  .addEdge("chatNode", END);

// Compile the graph
export const agenticChatReasoningGraph = workflow.compile();

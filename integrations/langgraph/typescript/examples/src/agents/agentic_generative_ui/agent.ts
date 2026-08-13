/**
 * An example demonstrating agentic generative UI using LangGraph.
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { Annotation, Command, MessagesAnnotation, StateGraph, END } from "@langchain/langgraph";
import { aguiTransformer } from "@ag-ui/langgraph/transformer";

// This tool simulates performing a task on the server.
// The tool call will be streamed to the frontend as it is being generated.
const PERFORM_TASK_TOOL = {
  type: "function",
  function: {
    name: "generate_task_steps_generative_ui",
    description: "Make up 10 steps (only a couple of words per step) that are required for a task. The step should be in gerund form (i.e. Digging hole, opening door, ...)",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "The text of the step in gerund form"
              },
              status: {
                type: "string",
                enum: ["pending"],
                description: "The status of the step, always 'pending'"
              }
            },
            required: ["description", "status"]
          },
          description: "An array of 10 step objects, each containing text and status"
        }
      },
      required: ["steps"]
    }
  }
};

const AgentStateAnnotation = Annotation.Root({
  steps: Annotation<Array<{ description: string; status: string }>>({
    reducer: (x, y) => y ?? x,
    default: () => []
  }),
  tools: Annotation<any[]>({
    reducer: (x, y) => y ?? x,
    default: () => []
  }),
  ...MessagesAnnotation.spec,
});

type AgentState = typeof AgentStateAnnotation.State;

async function startFlow(state: AgentState, config?: RunnableConfig) {
  /**
   * This is the entry point for the flow.
   * Always clear steps so old steps from previous runs don't persist.
   */
  return {
    steps: []
  };
}

async function chatNode(state: AgentState, config?: RunnableConfig) {
  /**
   * Standard chat node.
   */
  const systemPrompt = `
    You are a helpful assistant assisting with any task. 
    When asked to do something, you MUST call the function \`generate_task_steps_generative_ui\`
    that was provided to you.
    If you called the function, you MUST NOT repeat the steps in your next response to the user.
    Just give a very brief summary (one sentence) of what you did with some emojis. 
    Always say you actually did the steps, not merely generated them.
    `;

  // Define the model
  const model = new ChatOpenAI({ model: "gpt-4o" });
  
  // Define config for the model with emit_intermediate_state to stream tool calls to frontend
  if (!config) {
    config = { recursionLimit: 25 };
  }

  // Use "predict_state" metadata to set up streaming for the write_document tool
  if (!config.metadata) config.metadata = {};
  config.metadata.predict_state = [{
    state_key: "steps",
    tool: "generate_task_steps_generative_ui",
    tool_argument: "steps",
  }];

  // Bind the tools to the model
  const modelWithTools = model.bindTools(
    [
      ...state.tools,
      PERFORM_TASK_TOOL
    ],
    {
      // Disable parallel tool calls to avoid race conditions
      parallel_tool_calls: false,
    }
  );

  // Run the model to generate a response
  const response = await modelWithTools.invoke([
    new SystemMessage({ content: systemPrompt }),
    ...state.messages,
  ], config);

  const messages = [...state.messages, response];

  // Extract any tool calls from the response
  if (response.tool_calls && response.tool_calls.length > 0) {
    const toolCall = response.tool_calls[0];
    
    if (toolCall.name === "generate_task_steps_generative_ui") {
      const steps = toolCall.args.steps.map((step: any) => ({
        description: step.description,
        status: step.status
      }));
      
      // Add the tool response to messages
      const toolResponse = {
        role: "tool" as const,
        content: "Steps executed.",
        tool_call_id: toolCall.id
      };

      const updatedMessages = [...messages, toolResponse];

      // Simulate executing the steps
      for (let i = 0; i < steps.length; i++) {
        // simulate executing the step
        await new Promise(resolve => setTimeout(resolve, 1000));
        steps[i].status = "completed";
        // Update the state with the completed step
        state.steps = steps;
        // Emit custom events to update the frontend
        await dispatchCustomEvent("manually_emit_state", state, config);
      }
      
      return new Command({
        goto: "chat_node",
        update: {
          messages: updatedMessages,
          steps: state.steps
        }
      });
    }
  }

  return new Command({
    goto: END,
    update: {
      messages: messages,
      steps: state.steps
    }
  });
}

// Define the graph
const workflow = new StateGraph(AgentStateAnnotation)
  .addNode("start_flow", startFlow)
  .addNode("chat_node", chatNode)
  .addEdge("__start__", "start_flow")
  .addEdge("start_flow", "chat_node")
  .addEdge("chat_node", "__end__");

// Compile the graph
export const agenticGenerativeUiGraph = workflow.compile({
  // transformers: [aguiTransformer],
});
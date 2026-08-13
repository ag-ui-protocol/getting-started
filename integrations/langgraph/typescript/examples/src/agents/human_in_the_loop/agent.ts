/**
 * A LangGraph implementation of the human-in-the-loop agent.
 *
 * AG-UI interrupt protocol note:
 *   The @ag-ui/langgraph integration now supports the AG-UI standard
 *   interrupt protocol. Clients can resume execution by sending
 *   RunAgentInput.resume = [ResumeEntry({interruptId, status:"resolved",
 *   payload})] instead of the legacy forwardedProps.command.resume. When a
 *   single resolved entry is provided, interrupt() receives the payload
 *   verbatim — so this example's existing code works with both the old and
 *   new protocol without changes. See the "Resuming via AG-UI standard
 *   resume[]" section in the integration README for details on cancelled
 *   and multi-entry resume shapes.
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { Command, interrupt, Annotation, MessagesAnnotation, StateGraph, END, START } from "@langchain/langgraph";
import { aguiTransformer } from "@ag-ui/langgraph/transformer";

const DEFINE_TASK_TOOL = {
  type: "function",
  function: {
    name: "plan_execution_steps",
    description: "Make up 10 steps (only a couple of words per step) that are required for a task. The step should be in imperative form (i.e. Dig hole, Open door, ...)",
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
                description: "The text of the step in imperative form"
              },
              status: {
                type: "string",
                enum: ["enabled"],
                description: "The status of the step, always 'enabled'"
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

export const AgentStateAnnotation = Annotation.Root({
  steps: Annotation<Array<{ description: string; status: string }>>({
    reducer: (x, y) => y ?? x,
    default: () => []
  }),
  tools: Annotation<any[]>(),
  user_response: Annotation<string | undefined>({
    reducer: (x, y) => y ?? x,
    default: () => undefined
  }),
  ...MessagesAnnotation.spec,
});
export type AgentState = typeof AgentStateAnnotation.State;

async function startFlow(state: AgentState, config?: RunnableConfig): Promise<Command> {
  /**
   * This is the entry point for the flow.
   */

  // Initialize steps list if not exists
  if (!state.steps) {
    state.steps = [];
  }

  return new Command({
    goto: "chat_node",
    update: {
      messages: state.messages,
      steps: state.steps,
    }
  });
}

async function chatNode(state: AgentState, config?: RunnableConfig): Promise<Command> {
  /**
   * Standard chat node where the agent processes messages and generates responses.
   * If task steps are defined, the user can enable/disable them using interrupts.
   */
  const systemPrompt = `
    You are a helpful assistant that can perform any task.
    You MUST call the \`plan_execution_steps\` function when the user asks you to perform a task.
    Always make sure you will provide tasks based on the user query
    `;

  // Define the model
  const model = new ChatOpenAI({ model: "gpt-4o-mini" });
  
  // Define config for the model
  if (!config) {
    config = { recursionLimit: 25 };
  }

  // Use "predict_state" metadata to set up streaming for the write_document tool
  if (!config.metadata) config.metadata = {};
  config.metadata.predict_state = [{
    state_key: "steps",
    tool: "plan_execution_steps",
    tool_argument: "steps"
  }];

  // Bind the tools to the model
  const modelWithTools = model.bindTools(
    [
      ...state.tools,
      DEFINE_TASK_TOOL
    ],
    {
      // Disable parallel tool calls to avoid race conditions
      parallel_tool_calls: false,
    }
  );

  // Run the model and generate a response
  const response = await modelWithTools.invoke([
    new SystemMessage({ content: systemPrompt }),
    ...state.messages,
  ], config);

  // Update messages with the response
  const messages = [...state.messages, response];
  
  // Handle tool calls
  if (response.tool_calls && response.tool_calls.length > 0) {
    const toolCall = response.tool_calls[0];

    if (toolCall.name === "plan_execution_steps") {
      // Get the steps from the tool call
      const stepsRaw = toolCall.args.steps || [];
      
      // Set initial status to "enabled" for all steps
      const stepsData: Array<{ description: string; status: string }> = [];
      
      // Handle different potential formats of steps data
      if (Array.isArray(stepsRaw)) {
        for (const step of stepsRaw) {
          if (typeof step === 'object' && step.description) {
            stepsData.push({
              description: step.description,
              status: "enabled"
            });
          } else if (typeof step === 'string') {
            stepsData.push({
              description: step,
              status: "enabled"
            });
          }
        }
      }
      
      // If no steps were processed correctly, return to END with the updated messages
      if (stepsData.length === 0) {
        return new Command({
          goto: END,
          update: {
            messages: messages,
            steps: state.steps,
          }
        });
      }

      // Update steps in state and emit to frontend
      state.steps = stepsData;
      
      // Add a tool response to satisfy OpenAI's requirements
      const toolResponse = {
        role: "tool" as const,
        content: "Task steps generated.",
        tool_call_id: toolCall.id
      };
      
      const updatedMessages = [...messages, toolResponse];

      // Move to the process_steps_node which will handle the interrupt and final response
      return new Command({
        goto: "process_steps_node",
        update: {
          messages: updatedMessages,
          steps: state.steps,
        }
      });
    }
  }
  
  // If no tool calls or not plan_execution_steps, return to END with the updated messages
  return new Command({
    goto: END,
    update: {
      messages: messages,
      steps: state.steps,
    }
  });
}

async function processStepsNode(state: AgentState, config?: RunnableConfig): Promise<Command> {
  /**
   * This node handles the user interrupt for step customization and generates the final response.
   */

  let userResponse: string;

  // Check if we already have a user_response in the state
  // This happens when the node restarts after an interrupt
  if (state.user_response) {
    userResponse = state.user_response;
  } else {
    // Use LangGraph interrupt to get user input on steps
    // This will pause execution and wait for user input in the frontend
    userResponse = interrupt({ steps: state.steps });
    // Store the user response in state for when the node restarts
    state.user_response = userResponse;
  }
  
  // Generate the creative completion response
  const finalPrompt = `
    Provide a textual description of how you are performing the task.
    If the user has disabled a step, you are not allowed to perform that step.
    However, you should find a creative workaround to perform the task, and if an essential step is disabled, you can even use
    some humor in the description of how you are performing the task.
    Don't just repeat a list of steps, come up with a creative but short description (3 sentences max) of how you are performing the task.
    `;
  
  const finalResponse = await new ChatOpenAI({ model: "gpt-4o" }).invoke([
    new SystemMessage({ content: finalPrompt }),
    { role: "user", content: userResponse }
  ], config);

  // Add the final response to messages
  const messages = [...state.messages, finalResponse];
  
  // Clear the user_response from state to prepare for future interactions
  const newState = { ...state };
  delete newState.user_response;
  
  // Return to END with the updated messages
  return new Command({
    goto: END,
    update: {
      messages: messages,
      steps: state.steps,
    }
  });
}

// Define the graph
const workflow = new StateGraph(AgentStateAnnotation);

// Add nodes
workflow.addNode("start_flow", startFlow);
workflow.addNode("chat_node", chatNode);
workflow.addNode("process_steps_node", processStepsNode);

// Add edges
workflow.setEntryPoint("start_flow");
workflow.addEdge(START, "start_flow");
workflow.addEdge("start_flow", "chat_node");
workflow.addEdge("process_steps_node", END);

// Add conditional edges from chat_node
workflow.addConditionalEdges(
  "chat_node",
  (state: AgentState) => {
    // This would be determined by the Command returned from chat_node
    // For now, we'll assume the logic is handled in the Command's goto property
    return "continue";
  },
  {
    "process_steps_node": "process_steps_node",
    "continue": END,
  }
);

// Compile the graph
export const humanInTheLoopGraph = workflow.compile({
  transformers: [aguiTransformer],
});
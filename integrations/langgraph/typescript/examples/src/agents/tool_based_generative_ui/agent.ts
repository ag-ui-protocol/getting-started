/**
 * An example demonstrating tool-based generative UI using LangGraph.
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { RunnableConfig } from "@langchain/core/runnables";
import { Command, Annotation, MessagesAnnotation, StateGraph, END, START } from "@langchain/langgraph";
import { aguiTransformer } from "@ag-ui/langgraph/transformer";


export const AgentStateAnnotation = Annotation.Root({
  tools: Annotation<any[]>(),
  ...MessagesAnnotation.spec,
});
export type AgentState = typeof AgentStateAnnotation.State;

async function chatNode(state: AgentState, config?: RunnableConfig): Promise<Command> {
  const model = new ChatOpenAI({ model: "gpt-4o" });

  const modelWithTools = model.bindTools(
    [
      ...state.tools || []
    ],
    { parallel_tool_calls: false }
  );

  const systemMessage = new SystemMessage({
     content: 'Help the user with writing Haikus. If the user asks for a haiku, use the generate_haiku tool to display the haiku to the user.'
  });

  const response = await modelWithTools.invoke([
    systemMessage,
    ...state.messages,
  ], config);

  return new Command({
    goto: END,
    update: {
      messages: [response]
    }
  });
}

const workflow = new StateGraph<AgentState>(AgentStateAnnotation);
workflow.addNode("chat_node", chatNode);

workflow.addEdge(START, "chat_node");

export const toolBasedGenerativeUiGraph = workflow.compile({
  transformers: [aguiTransformer],
});
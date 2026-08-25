"""
A LangGraph implementation of the human-in-the-loop agent.

AG-UI interrupt protocol note:
  The @ag-ui/langgraph integration now supports the AG-UI standard interrupt
  protocol. Clients can resume execution by sending RunAgentInput.resume =
  [ResumeEntry(interruptId=..., status="resolved", payload=...)] instead of
  the legacy forwardedProps.command.resume. When a single resolved entry is
  provided, interrupt() receives the payload verbatim — so this example's
  existing code works with both the old and new protocol without changes.
  See the "Resuming via AG-UI standard resume[]" section in the integration
  README for details on cancelled and multi-entry resume shapes.
"""

from typing import Dict, List, Any, Annotated, Optional
import os

# LangGraph imports
from langchain_core.runnables import RunnableConfig
from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from langgraph.graph import StateGraph, END, START
from langgraph.types import Command, interrupt
from langgraph.graph import MessagesState
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

class Step(BaseModel):
    """
    A step in a task.
    """
    description: str = Field(description="The text of the step in imperative form")
    status: str = Field(description="The status of the step, always 'enabled'")

@tool
def plan_execution_steps(
    steps: Annotated[ # pylint: disable=unused-argument
        List[Step],
        "An array of 10 step objects, each containing text and status"
    ]
):
    """
    Make up 10 steps (only a couple of words per step) that are required for a task.
    The step should be in imperative form (i.e. Dig hole, Open door, ...).
    """

class AgentState(MessagesState):
    """
    State of the agent.
    """
    steps: List[Dict[str, str]] = []
    tools: List[Any]

async def start_node(state: Dict[str, Any], config: RunnableConfig): # pylint: disable=unused-argument
    """
    This is the entry point for the flow.
    """

    # Initialize steps list if not exists
    if "steps" not in state:
        state["steps"] = []

    # Return command to route to chat_node
    return Command(
        goto="chat_node",
        update={
            "messages": state["messages"],
            "steps": state["steps"],
        }
    )


async def chat_node(state: AgentState, config: Optional[RunnableConfig] = None):
    """
    Standard chat node where the agent processes messages and generates responses.
    If task steps are defined, the user can enable/disable them using interrupts.
    """
    system_prompt = """
    You are a helpful assistant that can perform any task.
    You MUST call the `plan_execution_steps` function when the user asks you to perform a task.
    Always make sure you will provide tasks based on the user query
    """

    # Define the model
    model = ChatOpenAI(model="gpt-4.1-mini")

    # Define config for the model
    if config is None:
        config = RunnableConfig(recursion_limit=25)

    # Use "predict_state" metadata to set up streaming for the write_document tool
    config["metadata"]["predict_state"] = [{
        "state_key": "steps",
        "tool": "plan_execution_steps",
        "tool_argument": "steps"
    }]

    # Bind the tools to the model
    model_with_tools = model.bind_tools(
        [
            *state["tools"],
            plan_execution_steps
        ],
        # Disable parallel tool calls to avoid race conditions
        parallel_tool_calls=False,
    )

    # Run the model and generate a response
    response = await model_with_tools.ainvoke([
        SystemMessage(content=system_prompt),
        *state["messages"],
    ], config)

    # Update messages with the response
    messages = state["messages"] + [response]

    # Handle tool calls
    if hasattr(response, "tool_calls") and response.tool_calls and len(response.tool_calls) > 0:
        # Handle dicts or object (backward compatibility)
        tool_call = (response.tool_calls[0]
                     if isinstance(response.tool_calls[0], dict)
                     else vars(response.tool_calls[0]))

        if tool_call["name"] == "plan_execution_steps":
            # Get the steps from the tool call
            steps_raw = tool_call["args"]["steps"]

            # Set initial status to "enabled" for all steps
            steps_data = []

            # Handle different potential formats of steps data
            if isinstance(steps_raw, list):
                for step in steps_raw:
                    if isinstance(step, dict) and "description" in step:
                        steps_data.append({
                            "description": step["description"],
                            "status": "enabled"
                        })
                    elif isinstance(step, str):
                        steps_data.append({
                            "description": step,
                            "status": "enabled"
                        })

            # If no steps were processed correctly, return to END with the updated messages
            if not steps_data:
                return Command(
                    goto=END,
                    update={
                        "messages": messages,
                        "steps": state["steps"],
                    }
                )
            # Update steps in state and emit to frontend
            state["steps"] = steps_data

            # Add a tool response to satisfy OpenAI's requirements
            tool_response = {
                "role": "tool",
                "content": "Task steps generated.",
                "tool_call_id": tool_call["id"]
            }

            messages = messages + [tool_response]

            # Move to the process_steps_node which will handle the interrupt and final response
            return Command(
                goto="process_steps_node",
                update={
                    "messages": messages,
                    "steps": state["steps"],
                }
            )

    # If no tool calls or not plan_execution_steps, return to END with the updated messages
    return Command(
        goto=END,
        update={
            "messages": messages,
            "steps": state["steps"],
        }
    )


async def process_steps_node(state: Dict[str, Any], config: RunnableConfig):
    """
    This node handles the user interrupt for step customization and generates the final response.
    """

    # Check if we already have a user_response in the state
    # This happens when the node restarts after an interrupt
    if "user_response" in state and state["user_response"]:
        user_response = state["user_response"]
    else:
        # Use LangGraph interrupt to get user input on steps
        # This will pause execution and wait for user input in the frontend
        user_response = interrupt({"steps": state["steps"]})
        # Store the user response in state for when the node restarts
        state["user_response"] = user_response

    # Generate the creative completion response
    final_prompt = """
    Provide a textual description of how you are performing the task.
    If the user has disabled a step, you are not allowed to perform that step.
    However, you should find a creative workaround to perform the task, and if an essential step is disabled, you can even use
    some humor in the description of how you are performing the task.
    Don't just repeat a list of steps, come up with a creative but short description (3 sentences max) of how you are performing the task.
    """

    final_response = await ChatOpenAI(model="gpt-4.1-mini").ainvoke([
        SystemMessage(content=final_prompt),
        {"role": "user", "content": user_response}
    ], config)

    # Add the final response to messages
    messages = state["messages"] + [final_response]

    # Clear the user_response from state to prepare for future interactions
    if "user_response" in state:
        state.pop("user_response")

    # Return to END with the updated messages
    return Command(
        goto=END,
        update={
            "messages": messages,
            "steps": state["steps"],
        }
    )


# Define the graph
workflow = StateGraph(AgentState)

# Add nodes
workflow.add_node("start_node", start_node)
workflow.add_node("chat_node", chat_node)
workflow.add_node("process_steps_node", process_steps_node)

# Add edges
workflow.set_entry_point("start_node")
workflow.add_edge(START, "start_node")
workflow.add_edge("start_node", "chat_node")
workflow.add_edge("process_steps_node", END)

# Conditionally use a checkpointer based on the environment
# Check for multiple indicators that we're running in LangGraph dev/API mode
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

# Compile the graph
if is_fast_api:
    # For CopilotKit and other contexts, use MemorySaver
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    # When running in LangGraph API/dev, don't use a custom checkpointer
    graph = workflow.compile()

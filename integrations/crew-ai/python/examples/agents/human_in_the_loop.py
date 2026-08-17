"""
An example demonstrating human-in-the-loop.
"""

from crewai.flow.flow import Flow, start, router, listen
from litellm import acompletion
from pydantic import BaseModel
from typing import Literal, List
from ag_ui_crewai.sdk import (
  copilotkit_stream,
  CopilotKitState,
)

# This tool simulates performing a task on the server.
# The tool call will be streamed to the frontend as it is being generated.
DEFINE_TASK_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_task_steps",
        "description": "Make up the number of task steps requested by the user (only a couple of words per step). If the user does not request a count, make a concise plan. Each step should be in imperative form (i.e. Dig hole, Open door, ...)",
        "parameters": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {
                                "type": "string",
                                "description": "The text of the step in imperative form"
                            },
                            "status": {
                                "type": "string",
                                "enum": ["enabled"],
                                "description": "The status of the step, always 'enabled'"
                            }
                        },
                        "required": ["description", "status"]
                    },
                    "description": "An array containing the requested number of step objects, each with text and status"
                }
            },
            "required": ["steps"]
        }
    }
}

HITL_SYSTEM_PROMPT = """
You are a helpful assistant that can perform any task.
CRITICAL: You MUST call the `generate_task_steps` function when the user asks you to perform a task.
CRITICAL: Generate exactly the step count requested by the user. If no count is requested, generate a concise plan.
When the function `generate_task_steps` is called, the user will decide to enable or disable a step and either accept or reject the plan.
CRITICAL: If the tool result has `accepted: false`, the plan was rejected. Do not perform the rejected plan. Wait for revision instructions from the user.
CRITICAL: After a rejection, interpret a terse numeric reply such as `5.` as a revised requested step count, then call `generate_task_steps` again with exactly that many steps.
If the tool result has `accepted: true`, provide a textual description of how you are performing only the accepted, enabled steps.
If the user has disabled a step, you are not allowed to perform that step.
However, you should find a creative workaround to perform the task, and if an essential step is disabled, you can even use
some humor in the description of how you are performing the task.
Don't just repeat a list of steps, come up with a creative but short description (3 sentences max) of how you are performing the task.
"""

class TaskStep(BaseModel):
    description: str
    status: Literal["enabled", "disabled"]

class AgentState(CopilotKitState):
    """
    Here we define the state of the agent

    In this instance, we're inheriting from CopilotKitState, which will bring in
    the CopilotKitState fields. We're also adding a custom field, `steps`,
    which will be used to store the steps of the task.
    """
    steps: List[TaskStep] = []


class HumanInTheLoopFlow(Flow[AgentState]):
    """
    This is a sample flow that demonstrates a human-in-the-loop agent.
    """

    @start()
    @listen("route_follow_up")
    async def start_flow(self):
        """
        This is the entry point for the flow.
        """

    @router(start_flow)
    async def chat(self):
        """
        Standard chat node.
        """
        # 1. Run the model and stream the response
        #    Note: In order to stream the response, wrap the completion call in
        #    copilotkit_stream and set stream=True.
        response = await copilotkit_stream(
            await acompletion(

                # 1.1 Specify the model to use
                model="openai/gpt-5.4",
                messages=[
                    {
                        "role": "system", 
                        "content": HITL_SYSTEM_PROMPT
                    },
                    *self.state.messages
                ],

                # 1.2 Bind the tools to the model
                tools=[
                    *self.state.copilotkit.actions,
                    DEFINE_TASK_TOOL
                ],

                # 1.3 Disable parallel tool calls to avoid race conditions,
                #     enable this for faster performance if you want to manage
                #     the complexity of running tool calls in parallel.
                parallel_tool_calls=False,
                stream=True
            )
        )

        message = response.choices[0].message

        # 2. Append the message to the messages in state
        self.state.messages.append(message)

        return "route_end"

    @listen("route_end")
    async def end(self):
        """
        End the flow.
        """

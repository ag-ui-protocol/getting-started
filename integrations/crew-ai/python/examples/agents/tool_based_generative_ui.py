"""
An example demonstrating tool-based generative UI.

The ``generate_haiku`` tool is defined on the FRONTEND (via ``useFrontendTool``):
its handler renders the haiku onto the main canvas and picks the background
image and gradient. So the flow binds the frontend actions and lets the model
call that tool, rather than defining a backend tool of the same name (which would
render the chat card but never run the frontend handler that updates the canvas).
"""

from crewai.flow.flow import Flow, start
from litellm import acompletion
from ag_ui_crewai.sdk import copilotkit_stream, CopilotKitState


class ToolBasedGenerativeUIFlow(Flow[CopilotKitState]):
    """
    A flow that demonstrates tool-based generative UI.
    """

    @start()
    async def chat(self):
        system_prompt = (
            "Help the user write haikus. When the user asks for a haiku, call the "
            "generate_haiku tool to display it. Choose a fitting background image "
            "and gradient for the haiku's theme."
        )

        response = await copilotkit_stream(
            await acompletion(
                model="openai/gpt-5.4",
                messages=[
                    {"role": "system", "content": system_prompt},
                    *self.state.messages,
                ],
                # Bind the frontend-provided tools (generate_haiku lives on the
                # frontend, so its handler updates the canvas when called).
                tools=[
                    *self.state.copilotkit.actions,
                ],
                parallel_tool_calls=False,
                stream=True,
            )
        )

        self.state.messages.append(response.choices[0].message)

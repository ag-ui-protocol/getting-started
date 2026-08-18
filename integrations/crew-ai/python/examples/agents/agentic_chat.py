"""
A simple agentic chat flow.
"""

from crewai.flow.flow import Flow, start
from litellm import acompletion
from ag_ui_crewai._config import resolve_provider_timeout_seconds
from ag_ui_crewai.sdk import copilotkit_stream, CopilotKitState

class AgenticChatFlow(Flow[CopilotKitState]):

    @start()
    async def chat(self):
        system_prompt = "You are a helpful assistant."

        # 1. Run the model and stream the response
        #    Note: In order to stream the response, wrap the completion call in
        #    copilotkit_stream and set stream=True.
        response = await copilotkit_stream(
            await acompletion(
                timeout=resolve_provider_timeout_seconds(),
                # 1.1 Specify the model to use
                model="openai/gpt-5.4",
                messages=[
                    {
                        "role": "system", 
                        "content": system_prompt
                    },
                    *self.state.messages
                ],

                # 1.2 Bind the available tools to the model
                tools=[
                    *self.state.copilotkit.actions,
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

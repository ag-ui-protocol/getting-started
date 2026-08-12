"""
A multimodal agentic chat flow that can analyze images and other media.

Images the user attaches are converted to LiteLLM's ``image_url`` shape by the
integration layer before the run, so the flow only has to point a vision-capable
model at the conversation.
"""

from crewai.flow.flow import Flow, start
from litellm import acompletion
from ..sdk import copilotkit_stream, CopilotKitState


class AgenticChatMultimodalFlow(Flow[CopilotKitState]):

    @start()
    async def chat(self):
        system_prompt = (
            "You are a helpful assistant that can analyze images, documents, and "
            "other media. When a user shares an image, describe what you see in "
            "detail. When a user shares a document, summarize its contents."
        )

        response = await copilotkit_stream(
            await acompletion(
                model="openai/gpt-5.4",
                messages=[
                    {"role": "system", "content": system_prompt},
                    *self.state.messages,
                ],
                tools=[
                    *self.state.copilotkit.actions,
                ],
                parallel_tool_calls=False,
                stream=True,
            )
        )

        self.state.messages.append(response.choices[0].message)

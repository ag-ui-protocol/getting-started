"""Custom lifecycle events — a real usage summary right before RUN_FINISHED.

Plain chat agent, same as agentic_chat — the point isn't the agent, it's the
CUSTOM event at the end. The SDK only knows real input/output token counts
once the run has finished, so this demo composes the translator directly
(rather than the OpenAIAgentsAgent wrapper) to read them off the run result
after the stream completes and before to_agui() emits RUN_FINISHED.
"""

from __future__ import annotations

from agents import Agent, Runner
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core import CustomEvent, EventType, RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_openai_agents import AGUITranslator
from .constants import DEFAULT_MODEL

agent = Agent(
    name="assistant",
    model=DEFAULT_MODEL,
    instructions="You are a helpful assistant. Be concise.",
)

app = FastAPI(title="Custom lifecycle events AG-UI demo")
translator = AGUITranslator()


@app.post("/")
async def run_custom_lifecycle_events(
    body: RunAgentInput, request: Request
) -> StreamingResponse:
    """Translate one AG-UI request into an SDK run, then report real token usage."""
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def stream():
        # AGUI input -> OpenAI SDK
        translated_input = translator.to_openai(body)
        result = Runner.run_streamed(
            agent,
            input=translated_input.messages,
            context=translated_input.context,
        )

        def usage_value() -> dict[str, int]:
            # Resolved after the stream finishes, so these are the run's
            # actual totals, not an estimate made up before anything ran.
            usage = result.context_wrapper.usage
            return {
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
            }

        end_custom_event = CustomEvent(
            type=EventType.CUSTOM, name="run_usage", value=usage_value
        )

        # OpenAI SDK -> AGUI events
        async for event in translator.to_agui(
            result, body, end_custom_event=end_custom_event
        ):
            yield encoder.encode(event)

    return StreamingResponse(stream(), media_type=encoder.get_content_type())

"""Backend tool rendering — a server-side ``@function_tool``.

Exercises ``TOOL_CALL_START/ARGS/END`` + ``TOOL_CALL_RESULT`` for a tool the
*backend* owns and executes (as opposed to :mod:`human_in_the_loop`, where the
frontend owns execution). The SDK runs the tool body itself; the translator
just reports the call and its result as they stream past.

The dojo's weather card (apps/dojo .../backend_tool_rendering/page.tsx) reads
the tool result as a JSON object — temperature/conditions/humidity/
wind_speed/feels_like — and the argument as `location`, matching every other
integration's version of this demo. A plain sentence string or a `city`
param renders as a blank/all-zero card, since the frontend has nothing to
parse. The fixed return value (same for every location) matches how most
other integrations' versions of this demo work too — the point of the demo
is the tool-call plumbing, not real weather data.
"""

from __future__ import annotations

from agents import Agent, function_tool
from fastapi import FastAPI

from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from .constants import DEFAULT_MODEL

_WEATHER = {"temperature": 20, "conditions": "sunny", "humidity": 50, "wind_speed": 10, "feels_like": 20}


@function_tool
def get_weather(location: str) -> dict:
    """Get the current weather for a location."""
    return _WEATHER


def create_backend_tool_agent() -> Agent:
    return Agent(
        name="weather_assistant",
        model=DEFAULT_MODEL,
        instructions=(
            "You are a helpful weather assistant. Use the get_weather tool "
            "whenever the user asks about weather in a specific location."
        ),
        tools=[get_weather],
    )


agent = OpenAIAgentsAgent(create_backend_tool_agent(), name="backend_tool_rendering")
app = FastAPI(title="Backend tool rendering AG-UI demo")
add_openai_agents_fastapi_endpoint(app, agent, "/")

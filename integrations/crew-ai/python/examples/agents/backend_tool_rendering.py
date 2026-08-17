"""Backend tool rendering.

This flow binds a real backend tool to a crewai ``Agent``: crewai runs
``get_weather`` server-side, and the bridge surfaces the call + result so the
client renders a weather card without ever executing the tool. (The other tool
demos instead stream a frontend action for the client to run.)

Requires the StreamFrame transport (crewai >= 1.6).
"""

import asyncio
import json

from crewai import Agent, Crew, Process, Task
from crewai.flow.flow import Flow, start
from crewai.tools import tool

from ag_ui_crewai._config import resolve_agent_execution_ceiling_seconds
from ag_ui_crewai.sdk import CopilotKitState, copilotkit_exit
from ._crewai_llm import bounded_llm

MODEL = "openai/gpt-5.4"


@tool("get_weather")
def get_weather(location: str) -> str:
    """Get the current weather for a given location."""
    # Return a JSON string, not a dict: crewai stringifies a tool's return
    # (str(result)) before it reaches the bridge, so a dict would arrive as a
    # single-quoted Python repr the client's JSON.parse rejects.
    return json.dumps(
        {
            "temperature": 20,
            "conditions": "sunny",
            "humidity": 50,
            "wind_speed": 10,
            "feelsLike": 25,
        }
    )


def _latest_user_message(messages) -> str:
    """Return the text of the most recent user message, or ``""``.

    Messages in flow state can be plain dicts (wire shape) or objects, so read
    ``role`` / ``content`` defensively.
    """
    for message in reversed(messages or []):
        if isinstance(message, dict):
            role = message.get("role")
            content = message.get("content")
        else:
            role = getattr(message, "role", None)
            content = getattr(message, "content", None)
        if role == "user":
            return content or ""
    return ""


class BackendToolRenderingFlow(Flow[CopilotKitState]):
    """A weather agent whose ``get_weather`` tool executes on the server."""

    @start()
    async def chat(self):
        user_message = _latest_user_message(self.state.messages)
        if not user_message:
            # Nothing was asked, so there is nothing to look up. A crew kickoff
            # here is a billed provider round trip (and, on the conversational
            # path, an unkillable worker thread) spent on an empty prompt.
            # Truthiness rather than ``strip()``: the helper returns whatever the
            # message carried, and a multimodal ``content`` is a list.
            self.state.messages.append(
                {
                    "role": "assistant",
                    "content": "Ask me about the weather somewhere.",
                }
            )
            await copilotkit_exit()
            return

        agent = Agent(
            role="Weather Assistant",
            goal="Answer the user's weather questions using the get_weather tool.",
            backstory=(
                "You are a helpful weather assistant. Always call the "
                "get_weather tool to look up the weather before you answer."
            ),
            tools=[get_weather],
            # The kickoff below is synchronous, so on the conversational path it
            # runs on a thread the request loop cannot kill. Both bounds shrink
            # that window without closing it: the LLM carries the per-read
            # timeout, and the ceiling drops the task-retry factor crewai
            # multiplies it by. Neither caps wall clock (see ``_crewai_llm``).
            llm=bounded_llm(MODEL),
            max_execution_time=resolve_agent_execution_ceiling_seconds(),
            verbose=False,
        )
        task = Task(
            description=(
                "Answer the user's request about the weather. "
                f"User request: {user_message}"
            ),
            expected_output="A short, friendly summary of the weather.",
            agent=agent,
        )
        crew = Crew(
            agents=[agent],
            tasks=[task],
            process=Process.sequential,
            verbose=False,
        )

        # Run the synchronous crew off the event loop so SSE keeps flushing and
        # cancellation/teardown can fire during the run. to_thread copies the
        # scoped sink + flow_context, so the crew's tool events still stream.
        result = await asyncio.to_thread(crew.kickoff)

        # The crew's final text; the tool card renders from the streamed events.
        self.state.messages.append(
            {
                "role": "assistant",
                "content": getattr(result, "raw", None) or str(result),
            }
        )

        await copilotkit_exit()

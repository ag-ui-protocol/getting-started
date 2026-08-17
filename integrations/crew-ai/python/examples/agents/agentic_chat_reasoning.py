"""
An agentic chat flow that surfaces the model's reasoning.

The reasoning cell lets the user pick a provider from the frontend; the choice
arrives on ``state.model``. Each provider is streamed over the channel that
actually carries its reasoning, and the bridge maps both onto REASONING_*:

* Anthropic (extended thinking) and Gemini reason on the litellm
  chat-completions delta, so they stream through ``acompletion``.
* OpenAI's reasoning models emit reasoning summaries ONLY over the Responses
  API, so they stream through ``copilotkit_responses``. Over chat-completions
  they answer with no thinking trace at all.

The Responses channel is used only when the bridge probes it as available
(``responses_channel_available``); otherwise the flow degrades to
chat-completions with a warning, and OpenAI answers without a trace.
"""

import logging
from typing import Any, Dict, List

from crewai.flow.flow import Flow, start
from litellm import acompletion

from ag_ui_crewai.sdk import (
    CopilotKitState,
    copilotkit_responses,
    copilotkit_stream,
    responses_channel_available,
)

logger = logging.getLogger("ag_ui_crewai")

SYSTEM_PROMPT = "You are a helpful assistant."

# The frontend dropdown's choices. This is a USER selection, not a capability
# inference: which transport carries a provider's reasoning is decided by the
# bridge's runtime probe, never by matching on these model strings.
OPENAI_MODEL = "openai/gpt-5.4"
ANTHROPIC_MODEL = "anthropic/claude-sonnet-4-5"
GEMINI_MODEL = "gemini/gemini-2.5-pro"


class AgentState(CopilotKitState):
    """Chat state plus the frontend-selected reasoning model."""

    model: str = "OpenAI"


def _chat_completion_kwargs(selected_model: str) -> Dict[str, Any]:
    """Map a chat-completions provider choice to its model + reasoning config."""
    if selected_model == "Anthropic":
        return {
            "model": ANTHROPIC_MODEL,
            "thinking": {"type": "enabled", "budget_tokens": 2000},
        }
    if selected_model == "Gemini":
        return {
            "model": GEMINI_MODEL,
            "reasoning_effort": "low",
        }
    # OpenAI over chat-completions: no reasoning content is returned, and
    # reasoning_effort is rejected outright for the gpt-5 family. Reached only
    # when the Responses channel is unavailable.
    return {"model": OPENAI_MODEL}


class AgenticChatReasoningFlow(Flow[AgentState]):

    @start()
    async def chat(self):
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            *self.state.messages,
        ]
        tools: List[Any] = [*self.state.copilotkit.actions]
        selected_model = self.state.model

        if selected_model == "OpenAI" and responses_channel_available():
            stream = await copilotkit_responses(
                model=OPENAI_MODEL,
                messages=messages,
                tools=tools or None,
                # ``summary`` is what makes OpenAI stream the reasoning summary
                # deltas at all; without it the run succeeds silently with no
                # trace to surface.
                reasoning={"effort": "medium", "summary": "auto"},
                # Forwarded through ``**kwargs``. One frontend tool call at a
                # time, matching the chat-completions branch and every other demo;
                # the OpenAI default is parallel.
                **({"parallel_tool_calls": False} if tools else {}),
            )
        else:
            if selected_model == "OpenAI":
                logger.warning(
                    "The OpenAI Responses channel is unavailable, so this run "
                    "streams over chat-completions and will surface no thinking "
                    "trace. Upgrade litellm to a build exposing 'aresponses'."
                )
            chat_messages = [
                message
                for message in messages
                if message.get("role") != "reasoning"
            ]
            stream = await acompletion(
                messages=chat_messages,
                tools=tools or None,
                parallel_tool_calls=False if tools else None,
                stream=True,
                **_chat_completion_kwargs(selected_model),
            )

        response = await copilotkit_stream(stream)

        self.state.messages.append(response.choices[0].message)

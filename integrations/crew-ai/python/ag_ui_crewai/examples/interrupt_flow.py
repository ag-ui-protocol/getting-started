"""An example demonstrating async human-in-the-loop via a flow interrupt.

A scheduling assistant, mirroring the interrupt demo the other integrations
ship: the model works out which meeting the user wants, the flow PAUSES so the
user can pick a time, and on resume the model confirms the booking. The human
decision lands in the middle of the agent's own work, which is the point of
human-in-the-loop.

The pause is a real flow suspend: ``@human_feedback`` with the bridge's
``agui_feedback_provider`` raises ``HumanFeedbackPending``, so the run ends with
an AG-UI interrupt and the next request carrying ``RunAgentInput.resume[]``
continues it via ``Flow.from_pending`` + ``resume_async``.

Contrast with ``human_in_the_loop.py``: that demo round-trips a FRONTEND tool
and never pauses the flow. This one suspends the flow itself.
"""

import json
from typing import Any

from crewai.flow.flow import Flow, listen, start
from crewai.flow import human_feedback
from litellm import acompletion

from ..sdk import CopilotKitState, copilotkit_stream
from .._hitl import agui_feedback_provider

MODEL = "openai/gpt-4o"

EXTRACT_PROMPT = """You are a scheduling assistant. From the conversation, work out which meeting the user wants to book.

Reply with ONLY a JSON object, no prose:
{"topic": "<short purpose, a few words>", "attendee": "<who the meeting is with, or an empty string>"}"""

CONFIRM_PROMPT = """You are a scheduling assistant. You asked the user to pick a meeting time and they have now responded.

Confirm in 1-2 short, friendly sentences: state that the meeting is booked and for when, or acknowledge that they cancelled. Do not ask any further questions."""


class AgentState(CopilotKitState):
    """Flow state: what is being scheduled, and the outcome."""

    topic: str = ""
    attendee: str = ""
    booked: str = ""


def _parse_json_object(raw: Any) -> dict:
    """Best-effort parse of a model / resume payload into a dict.

    The model is asked for bare JSON but may fence it, and the resume payload
    arrives as a JSON-encoded string (or plain text if the user typed one).
    Never raises: a demo degrades to sensible defaults instead.
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if "{" in text:
            text = text[text.index("{"):]
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


class InterruptFlow(Flow[AgentState]):
    """Scheduling assistant that suspends mid-run for the user's time choice."""

    @start()
    async def understand_request(self):
        """Work out the meeting to book from the conversation so far."""
        response = await acompletion(
            model=MODEL,
            messages=[
                {"role": "system", "content": EXTRACT_PROMPT},
                *self.state.messages,
            ],
        )
        details = _parse_json_object(response.choices[0].message.content)
        self.state.topic = (details.get("topic") or "a call").strip()
        self.state.attendee = (details.get("attendee") or "").strip()

    @listen(understand_request)
    @human_feedback(
        message="Pick a time for this meeting.",
        provider=agui_feedback_provider,
    )
    def request_time(self):
        """Pause for the user's time choice.

        The return value is what the client renders (the time picker reads
        ``topic`` / ``attendee``). The provider raises ``HumanFeedbackPending``
        here, which suspends the flow and persists it for resume.
        """
        return {"topic": self.state.topic, "attendee": self.state.attendee}

    @listen(request_time)
    async def confirm_booking(self, feedback):
        """Resumed with the user's choice: confirm the booking in chat."""
        answer = getattr(feedback, "feedback", feedback)
        choice = _parse_json_object(answer)
        label = choice.get("chosen_label") or choice.get("chosen_time") or ""
        cancelled = bool(choice.get("cancelled"))

        if cancelled:
            self.state.booked = ""
            outcome = f"The user cancelled. Do not book '{self.state.topic}'."
        elif label:
            self.state.booked = label
            outcome = (
                f"The user picked {label}. '{self.state.topic}' is booked for then."
            )
        else:
            # Free-text feedback (no picker payload): pass it through verbatim.
            self.state.booked = str(answer)
            outcome = (
                f"The user replied: {answer!r}. Treat that as their answer for "
                f"'{self.state.topic}'."
            )

        response = await copilotkit_stream(
            await acompletion(
                model=MODEL,
                messages=[
                    {"role": "system", "content": CONFIRM_PROMPT},
                    *self.state.messages,
                    {"role": "system", "content": outcome},
                ],
                stream=True,
            )
        )
        self.state.messages.append(response.choices[0].message)

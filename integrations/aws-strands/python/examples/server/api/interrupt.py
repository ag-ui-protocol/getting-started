"""Interrupt example for AWS Strands.

``schedule_meeting`` pauses itself. Strands' native interrupt system lets a tool
call ``tool_context.interrupt(...)``, which halts the agent loop and finishes the
run with ``RUN_FINISHED`` carrying ``outcome.type == "interrupt"``. The dojo's
interrupt page renders its time picker, and resuming on the same ``thread_id``
returns the user's choice from that same ``interrupt()`` call so the tool body
continues where it left off.

The resume payload arrives wrapped: a resolved answer as ``{"response": ...}``,
a client-side cancel as ``{"cancelled": True}``. The adapter wraps it because
Strands' resume gate is truthiness-based and a bare falsy answer would re-raise
the same interrupt forever.

Pause and resume happen on the same live wrapper and process here, so no
``SessionManager`` is needed. Durable, cross-process resume requires one.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Quieten OpenTelemetry context warnings by default. Ordering matters twice
# over: after `load_dotenv` so a value in examples/.env wins, and before the
# strands import below, which is the point at which the setting takes effect.
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("OTEL_PYTHON_DISABLED_INSTRUMENTATIONS", "all")

from strands import Agent, tool
from strands.types.tools import ToolContext
from ag_ui_strands import StrandsAgent, create_strands_app
from server.model_factory import create_model


@tool(context=True)
def schedule_meeting(topic: str, tool_context: ToolContext, attendee: str = "") -> str:
    """Ask the user to pick a meeting time, then confirm what was scheduled.

    Args:
        topic: Short description of the meeting purpose.
        attendee: Who the meeting is with, if known.
    """
    answer = tool_context.interrupt(
        "schedule_meeting",
        reason={"topic": topic, "attendee": attendee},
    )

    # Two cancel shapes reach here: the adapter's sentinel for a cancelled
    # resume entry, and the picker's own Cancel button, which resolves with a
    # `cancelled` flag inside the payload.
    payload = answer.get("response") or {}
    if answer.get("cancelled") or payload.get("cancelled"):
        return f"User cancelled. Meeting NOT scheduled: {topic}"

    label = payload.get("chosen_label") or payload.get("chosen_time")
    if not label:
        return f"User did not pick a time. Meeting NOT scheduled: {topic}"
    return f"Meeting scheduled for {label}: {topic}"


model = create_model()

strands_agent = Agent(
    model=model,
    tools=[schedule_meeting],
    system_prompt="""You are a scheduling assistant.

Whenever the user asks you to book a call or schedule a meeting, you MUST call
the `schedule_meeting` tool. Pass a short `topic` describing the purpose and, if
known, an `attendee` describing who the meeting is with.

The tool pauses execution and shows the user a time picker. Once it resumes with
their choice, briefly confirm whether the meeting was scheduled and at what
time, or note that the user cancelled. Do not ask for approval yourself: always
call the tool and let the picker handle the decision. Keep responses short and
friendly.

Never claim a meeting is scheduled unless the tool result says so.""",
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="interrupt",
    description="AWS Strands agent whose scheduling tool pauses for the user to pick a time",
)

app = create_strands_app(agui_agent, "/")

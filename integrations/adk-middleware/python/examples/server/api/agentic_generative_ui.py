"""Agentic Generative UI feature."""

from __future__ import annotations

from textwrap import dedent
from typing import Any, Literal, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

from ag_ui.core import EventType, StateDeltaEvent, StateSnapshotEvent
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, AGUIToolset
from google.adk.agents import LlmAgent

StepStatus = Literal['pending', 'completed']


class Step(BaseModel):
    """Represents a step in a plan."""

    description: str = Field(description='The description of the step')
    status: StepStatus = Field(
        default='pending',
        description='The status of the step (e.g., pending, completed)',
    )


class Plan(BaseModel):
    """Represents a plan with multiple steps."""

    steps: list[Step] = Field(default_factory=list, description='The steps in the plan')


class JSONPatchOp(BaseModel):
    """A class representing a JSON Patch operation (RFC 6902)."""

    op: Literal['add', 'remove', 'replace', 'move', 'copy', 'test'] = Field(
        description='The operation to perform: add, remove, replace, move, copy, or test',
    )
    path: str = Field(description='JSON Pointer (RFC 6901) to the target location')
    value: Any = Field(
        default=None,
        description='The value to apply (for add, replace operations)',
    )
    from_: str | None = Field(
        default=None,
        alias='from',
        description='Source path (for move, copy operations)',
    )


async def create_plan(steps: list[str]) -> StateSnapshotEvent:
    """Create a plan with multiple steps.

    Args:
        steps (list[str]): List of step descriptions to create the plan.

    Returns:
        StateSnapshotEvent: Event containing the initial state of the steps.
    """
    plan: Plan = Plan(
        steps=[Step(description=step) for step in steps],
    )
    return StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot=plan.model_dump(),
    )


async def update_plan_step(
    index: int, description: Optional[str] = None, status: Optional[StepStatus] = None
) -> StateDeltaEvent:
    """Update the plan with new steps or changes.

    Args:
        index (int): The index of the step to update.
        description (str | None): The new description for the step.
        status (StepStatus | None): The new status for the step.

    Returns:
        StateDeltaEvent: Event containing the changes made to the plan.
    """
    changes: list[JSONPatchOp] = []
    if description is not None:
        changes.append(
            JSONPatchOp(
                op='replace', path=f'/steps/{index}/description', value=description
            )
        )
    if status is not None:
        changes.append(
            JSONPatchOp(op='replace', path=f'/steps/{index}/status', value=status)
        )
    return StateDeltaEvent(
        type=EventType.STATE_DELTA,
        delta=changes,
    )


# Create the ADK agent
agent = LlmAgent(
    name="planner",
    model="gemini-3.5-flash",
    instruction=dedent(
        """
        When planning use tools only, without any other messages.
        IMPORTANT:
        - Use the `create_plan` tool to set the initial state of the steps
        - Use the `update_plan_step` tool to update the status of each step
        - Do NOT repeat the plan or summarise it in a message
        - Do NOT confirm the creation or updates in a message
        - Do NOT ask the user for additional information or next steps
        - Do NOT leave a plan hanging, always complete the plan via `update_plan_step` if one is ongoing.

        Only one plan can be active at a time, so do not call the `create_plan` tool
        again until all the steps in current plan are completed.
        """
    ),
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client,
        create_plan, 
        update_plan_step,
    ],
)

# Create ADK middleware agent instance
adk_agent = ADKAgent(
    adk_agent=agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Agentic Generative UI")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, adk_agent, path="/")

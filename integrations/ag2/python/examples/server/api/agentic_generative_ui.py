"""Agentic Generative UI feature.

The plan lives in the run's shared state: tools update `ctx.variables` and
emit STATE_SNAPSHOT events mid-run so the frontend renders progress live.
"""

from textwrap import dedent
from typing import Literal

from ag_ui.core import StateSnapshotEvent
from ag2 import Agent, Context, tool
from ag2.ag_ui import AGUIEvent, AGUIStream
from ag2.config import OpenAIConfig
from fastapi import FastAPI
from pydantic import BaseModel, Field


StepStatus = Literal["pending", "completed"]


class Step(BaseModel):
    """Represents a step in a plan."""

    description: str = Field(description="The description of the step")
    status: StepStatus = Field(
        default="pending",
        description="The status of the step (e.g., pending, completed)",
    )


class Plan(BaseModel):
    """Represents a plan with multiple steps."""

    steps: list[Step] = Field(default_factory=list, description="The steps in the plan")


@tool
async def create_plan(ctx: Context, steps: list[str]) -> str:
    """Create a plan with multiple steps.

    Args:
        steps: List of step descriptions to create the plan.
    """
    plan = Plan(steps=[Step(description=step) for step in steps])
    ctx.variables.update(plan.model_dump())
    await ctx.send(AGUIEvent(StateSnapshotEvent(snapshot=ctx.variables)))
    return "Plan created"


@tool
async def update_plan_step(
    ctx: Context,
    index: int,
    description: str | None = None,
    status: StepStatus | None = None,
) -> str:
    """Update the plan with new steps or changes.

    Args:
        index: The index of the step to update.
        description: The new description for the step.
        status: The new status for the step.
    """
    plan = Plan.model_validate(ctx.variables)

    if description is not None:
        plan.steps[index].description = description
    if status is not None:
        plan.steps[index].status = status

    ctx.variables.update(plan.model_dump())
    await ctx.send(AGUIEvent(StateSnapshotEvent(snapshot=ctx.variables)))
    return "Plan updated"


agent = Agent(
    name="planner",
    prompt=dedent("""
    You are a helpful assistant assisting with any task.
    When asked to do something, you MUST call the function `create_plan` (or `update_plan_step` where fits)
    that was provided to you.
    Do not offer to call the function/make a plan. Simply make the plan, even for unrealistic tasks like "take down the moon".
    If you called the function, you MUST NOT repeat the steps in your next response to the user.
    Just give a very brief summary (one sentence) of what you did with some emojis.
    Always say you actually did the steps, not merely generated them.
    """),
    config=OpenAIConfig(model="gpt-4o-mini"),
    tools=[create_plan, update_plan_step],
)

stream = AGUIStream(agent)
agentic_generative_ui_app = FastAPI()
agentic_generative_ui_app.mount("", stream.build_asgi())

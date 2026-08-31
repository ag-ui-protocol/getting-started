"""Agentic Generative UI example for AWS Strands.

Demonstrates streaming agent state updates to the frontend for real-time
UI rendering. Uses ONLY the canonical Strands + ag_ui_strands surface:

- ``predict_state`` mapping streams the predicted ``steps`` to the FE
  while the LLM is still emitting ``plan_task_steps`` arguments.
- The tool itself is an ``async`` generator. Each ``yield`` of
  ``{"state": {...}}`` becomes a Strands ``tool_stream_event`` which the
  ag_ui_strands adapter translates into an AG-UI ``StateSnapshotEvent``.
- The FINAL value yielded by the tool is its return result.

The agent never emits AG-UI events directly. State updates flow through
Strands' native streaming mechanism, mirroring how integrations like
LangGraph emit state via their own runtime events.
"""
import json
import os
import asyncio
import random
from typing import List, Dict, Any
from pathlib import Path
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from strands import Agent, tool
from ag_ui_strands import (
    StrandsAgent,
    create_strands_app,
    StrandsAgentConfig,
    ToolBehavior,
    PredictStateMapping,
)
from server.model_factory import create_model
from server.settings import cors_origins

# Suppress OpenTelemetry warnings
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

# Load environment variables
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Create model from MODEL_PROVIDER env var (default: openai)
model = create_model()


class TaskStep(BaseModel):
    """Represents a single UI step."""

    description: str = Field(description="Gerund phrase describing the action, e.g. 'Sketching layout'")
    status: str = Field(description="Must be 'pending' when proposed", default="pending")


@tool
async def plan_task_steps(
    task: str,
    context: str = "",
    steps: List[Any] = None,
) -> Dict[str, Any]:
    """
    Plan the concrete steps required to accomplish a task and walk each
    step from "pending" through "in_progress" to "completed" so the UI
    sees progress in real time.

    Args:
        task: Brief description of what the user wants to achieve.
        context: Optional additional instructions or constraints from the user.
        steps: Ordered list of pending steps in gerund form.

    Yields:
        ``{"state": {"steps": [...]}}`` chunks per status transition. The
        ag_ui_strands adapter forwards these as ``StateSnapshotEvent``.

    Returns:
        Final payload (last yielded value) with the task summary and
        completed steps.
    """
    normalized_steps = _normalize_steps(steps) if steps else []
    if not normalized_steps:
        normalized_steps = _fallback_steps(task or "the task", context)

    working_steps = [dict(step) for step in normalized_steps]

    # Initial canonical state — all pending. predict_state will already
    # have streamed something similar from the tool args; this re-confirms
    # the canonical shape now that the tool body owns the state.
    yield {"state": {"steps": [dict(s) for s in working_steps]}}

    for index in range(len(working_steps)):
        await asyncio.sleep(random.uniform(0.3, 0.8))
        working_steps[index]["status"] = "in_progress"
        yield {"state": {"steps": [dict(s) for s in working_steps]}}

        await asyncio.sleep(random.uniform(0.4, 1.0))
        working_steps[index]["status"] = "completed"
        yield {"state": {"steps": [dict(s) for s in working_steps]}}

    # Final yielded value is the tool's return value.
    yield {
        "task": task,
        "context": context,
        "steps": working_steps,
    }


def _normalize_steps(raw_steps: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_steps, list):
        return []
    normalized = []
    for step in raw_steps:
        if isinstance(step, TaskStep):
            normalized.append(step.model_dump())
        elif isinstance(step, dict) and "description" in step:
            normalized.append(
                {
                    "description": str(step["description"]),
                    "status": step.get("status") or "pending",
                }
            )
        elif isinstance(step, str) and step.strip():
            normalized.append({"description": step.strip(), "status": "pending"})
    return normalized


def _fallback_steps(task: str, context: str) -> List[Dict[str, str]]:
    """Create a simple deterministic plan when the model forgets to provide steps."""
    count = 6
    for token in context.split():
        if token.isdigit():
            count = max(4, min(10, int(token)))
            break

    templates = [
        "Clarifying goals for {task}",
        "Gathering resources for {task}",
        "Preparing workspace for {task}",
        "Executing core work on {task}",
        "Reviewing results for {task}",
        "Wrapping up {task}",
        "Documenting learnings from {task}",
        "Celebrating completion of {task}",
    ]

    plan = []
    for i in range(count):
        template = templates[i % len(templates)]
        plan.append(
            {
                "description": template.format(task=task).strip().capitalize(),
                "status": "pending",
            }
        )
    return plan


async def steps_state_from_result(context):
    """Final canonical state once the tool has finished walking the plan."""
    result = context.result_data or {}
    steps = _normalize_steps(result.get("steps"))
    if not steps:
        return None
    return {"steps": steps}


def build_state_context(input_data, user_message: str) -> str:
    """Augment the user message with existing plan context to discourage replanning."""
    state = getattr(input_data, "state", {}) or {}
    steps = state.get("steps")
    if steps:
        steps_json = json.dumps(steps, indent=2)
        return (
            "A plan is already in progress. NEVER call plan_task_steps again unless the user explicitly "
            "asks to restart. Discuss progress or ask clarifying questions instead.\n\n"
            f"Current steps:\n{steps_json}\n\nUser: {user_message}"
        )
    return user_message


generative_ui_config = StrandsAgentConfig(
    state_context_builder=build_state_context,
    tool_behaviors={
        "plan_task_steps": ToolBehavior(
            predict_state=[
                PredictStateMapping(
                    state_key="steps",
                    tool="plan_task_steps",
                    tool_argument="steps",
                )
            ],
            state_from_result=steps_state_from_result,
        )
    }
)


system_prompt = """
You are an energetic project assistant who decomposes user goals into action plans.

Planning rules:
1. When the user asks for help with a task or making a plan, call `plan_task_steps` exactly once to create the plan.
2. Do NOT call `plan_task_steps` again unless the user explicitly says to restart or discard the plan (or moves on to a new task).
3. Generate 4-6 concise steps in gerund form (e.g., “Setting up repo”, “Testing prototype”) and leave their status as "pending".
4. After the tool call, send a short confirmation (<= 2 sentences) plus one emoji describing what you planned.
5. If the user is just chatting or reviewing progress, respond conversationally and DO NOT call the tool.
6. If a plan already exists, reference the current steps and ask follow-up questions instead of creating a new plan, unless instructed otherwise.
"""


strands_agent = Agent(
    model=model,
    tools=[plan_task_steps],
    system_prompt=system_prompt,
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="agentic_generative_ui",
    description="AWS Strands agent with generative UI and state streaming",
    config=generative_ui_config,
)

app = create_strands_app(agui_agent, "/", origins=cors_origins())
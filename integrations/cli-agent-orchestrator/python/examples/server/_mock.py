"""Zero-dependency mock backend for the CAO AG-UI example server.

Self-contained AG-UI frame emitters built only on ``ag_ui.core`` and
``ag_ui.encoder`` — **no ``cli-agent-orchestrator`` dependency**. This is the
fallback path selected when the ``cao`` extra is not installed (or when
``CAO_AGUI_MODE=mock``), so the example server and the keyless CI matrix run
anywhere. The projection backend (``run_plane_stream``) is the high-fidelity
default; this mock reproduces the same feature contracts for portability.

Frame content mirrors the original self-contained server so behaviour is stable
across modes for the Dojo frontend.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import AsyncGenerator

from ag_ui.core import (
    EventType,
    Interrupt,
    RunAgentInput,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
)
from ag_ui.core.events import (
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
)
from ag_ui.encoder import EventEncoder
from fastapi import Request
from fastapi.responses import StreamingResponse

from ._common import FLEET_STEPS, interpret_resume, steps_state


async def _read_input(request: Request) -> RunAgentInput:
    return RunAgentInput.model_validate(await request.json())


def _streaming(request: Request, gen_factory) -> StreamingResponse:
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def _generator():
        async for event in gen_factory(encoder):
            yield event

    return StreamingResponse(_generator(), media_type=encoder.get_content_type())


# --- agentic_chat -----------------------------------------------------------
async def agentic_chat(request: Request) -> StreamingResponse:
    data = await _read_input(request)

    async def gen(encoder: EventEncoder) -> AsyncGenerator[str, None]:
        yield encoder.encode(RunStartedEvent(type=EventType.RUN_STARTED, thread_id=data.thread_id, run_id=data.run_id))
        mid = str(uuid.uuid4())
        yield encoder.encode(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=mid, role="assistant"))
        chunks = [
            "The **CLI Agent Orchestrator** (CAO) ",
            "manages multiple AI coding agents ",
            "running in parallel across your fleet.\n\n",
            "Key capabilities:\n",
            "- **Fleet management** - coordinate agents across terminals\n",
            "- **Interrupt handling** - approve or deny tool calls in real-time\n",
            "- **Shared state** - track progress across all active agents\n",
            "- **Human-in-the-loop** - review and approve generated task plans\n\n",
            "This dojo demonstrates these patterns using the AG-UI protocol.",
        ]
        for chunk in chunks:
            yield encoder.encode(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=mid, delta=chunk))
            await asyncio.sleep(0.05)
        yield encoder.encode(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=mid))
        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=data.thread_id,
                run_id=data.run_id,
                outcome=RunFinishedSuccessOutcome(type="success"),
            )
        )

    return _streaming(request, gen)


# --- shared_state -----------------------------------------------------------
async def shared_state(request: Request) -> StreamingResponse:
    data = await _read_input(request)

    async def gen(encoder: EventEncoder) -> AsyncGenerator[str, None]:
        yield encoder.encode(RunStartedEvent(type=EventType.RUN_STARTED, thread_id=data.thread_id, run_id=data.run_id))
        mid = str(uuid.uuid4())
        yield encoder.encode(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=mid, role="assistant"))
        for chunk in ["Here's a spicy chicken lettuce wrap recipe ", "with low-carb ingredients. ", "Check the shared state panel for details!"]:
            yield encoder.encode(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=mid, delta=chunk))
            await asyncio.sleep(0.05)
        yield encoder.encode(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=mid))
        state = {
            "recipe": {
                "skill_level": "Advanced",
                "special_preferences": ["Low Carb", "Spicy"],
                "cooking_time": "15 min",
                "ingredients": [
                    {"icon": "\U0001f357", "name": "chicken breast", "amount": "1"},
                    {"icon": "\U0001f336\ufe0f", "name": "chili powder", "amount": "1 tsp"},
                    {"icon": "\U0001f9c2", "name": "Salt", "amount": "a pinch"},
                    {"icon": "\U0001f96c", "name": "Lettuce leaves", "amount": "handful"},
                ],
                "instructions": [
                    "Season chicken with chili powder and salt.",
                    "Sear until fully cooked.",
                    "Slice and wrap in lettuce.",
                ],
            }
        }
        yield encoder.encode(StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=state))
        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=data.thread_id,
                run_id=data.run_id,
                outcome=RunFinishedSuccessOutcome(type="success"),
            )
        )

    return _streaming(request, gen)


# --- agentic_generative_ui --------------------------------------------------
async def agentic_generative_ui(request: Request) -> StreamingResponse:
    """Stream the fleet lifecycle as a progressive ``steps`` state.

    One ``STATE_SNAPSHOT`` per step transition, which is the mechanism the shared
    Dojo page renders from (``useAgent`` + ``UseAgentUpdate.OnStateChanged``).
    The descriptions are CAO's real record primitives, not an invented plan — see
    ``_common.FLEET_STEPS``.
    """
    data = await _read_input(request)

    async def gen(encoder: EventEncoder) -> AsyncGenerator[str, None]:
        yield encoder.encode(RunStartedEvent(type=EventType.RUN_STARTED, thread_id=data.thread_id, run_id=data.run_id))

        # Open with every step pending so the page renders the full plan before
        # any of it completes, then advance one step at a time.
        yield encoder.encode(StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=steps_state(0)))
        for completed in range(1, len(FLEET_STEPS) + 1):
            await asyncio.sleep(0.4)
            yield encoder.encode(
                StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=steps_state(completed))
            )

        mid = str(uuid.uuid4())
        yield encoder.encode(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=mid, role="assistant"))
        for chunk in [
            "The fleet finished all ",
            f"{len(FLEET_STEPS)} steps. ",
            "Each one is a real CAO record — a terminal launch, two handoffs, ",
            "a file modification, and a terminal retirement — not a generated plan.",
        ]:
            yield encoder.encode(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=mid, delta=chunk))
            await asyncio.sleep(0.05)
        yield encoder.encode(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=mid))

        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=data.thread_id,
                run_id=data.run_id,
                outcome=RunFinishedSuccessOutcome(type="success"),
            )
        )

    return _streaming(request, gen)


# --- human_in_the_loop ------------------------------------------------------
def _last_user_text(data: RunAgentInput) -> str:
    for message in reversed(data.messages or []):
        if getattr(message, "role", None) != "user":
            continue
        content = getattr(message, "content", "") or ""
        if isinstance(content, str):
            return content
        return " ".join(
            part.get("text", "") if isinstance(part, dict) else (getattr(part, "text", "") or "")
            for part in content
        )
    return ""


async def human_in_the_loop(request: Request) -> StreamingResponse:
    data = await _read_input(request)
    messages = data.messages or []
    last = messages[-1] if messages else None
    is_tool_result = bool(last) and getattr(last, "role", None) == "tool"

    # The shared HITL spec opens with a greeting and asks follow-up questions after
    # approval; a real LLM-backed agent answers those with prose and emits the tool
    # call only when a plan is actually requested. Emitting it unconditionally renders
    # a second planner, which trips Playwright locator strict mode on select-steps.
    already_planned = any(getattr(m, "role", None) == "tool" for m in messages)
    wants_plan = any(word in _last_user_text(data).lower() for word in ("plan", "step"))

    async def gen(encoder: EventEncoder) -> AsyncGenerator[str, None]:
        yield encoder.encode(RunStartedEvent(type=EventType.RUN_STARTED, thread_id=data.thread_id, run_id=data.run_id))
        if is_tool_result:
            mid = str(uuid.uuid4())
            yield encoder.encode(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=mid, role="assistant"))
            yield encoder.encode(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=mid, delta="Task steps approved! Executing the plan now."))
            yield encoder.encode(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=mid))
        elif already_planned or not wants_plan:
            # After approval the spec asks whether a step it unchecked survived; the
            # approved plan excludes it, so the truthful single-word answer is "No".
            delta = "No" if already_planned else "Hello! Ask me for a plan and I'll draft the steps for your approval."
            mid = str(uuid.uuid4())
            yield encoder.encode(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=mid, role="assistant"))
            yield encoder.encode(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=mid, delta=delta))
            yield encoder.encode(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=mid))
        else:
            tcid = str(uuid.uuid4())
            yield encoder.encode(ToolCallStartEvent(type=EventType.TOOL_CALL_START, tool_call_id=tcid, tool_call_name="generate_task_steps"))
            yield encoder.encode(ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id=tcid, delta='{"steps":['))
            steps = [
                {"description": "Clone the repository", "status": "enabled"},
                {"description": "Install dependencies with uv sync", "status": "enabled"},
                {"description": "Run linting checks", "status": "enabled"},
                {"description": "Execute test suite", "status": "enabled"},
                {"description": "Build the package", "status": "enabled"},
            ]
            for i, step in enumerate(steps):
                delta = json.dumps(step) + ("," if i < len(steps) - 1 else "")
                yield encoder.encode(ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id=tcid, delta=delta))
                await asyncio.sleep(0.1)
            yield encoder.encode(ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id=tcid, delta="]}"))
            yield encoder.encode(ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tcid))
        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=data.thread_id,
                run_id=data.run_id,
                outcome=RunFinishedSuccessOutcome(type="success"),
            )
        )

    return _streaming(request, gen)


# --- interrupt (flagship) ---------------------------------------------------
async def interrupt(request: Request) -> StreamingResponse:
    data = await _read_input(request)
    is_resume = bool(data.resume) and len(data.resume) > 0

    async def gen(encoder: EventEncoder) -> AsyncGenerator[str, None]:
        yield encoder.encode(RunStartedEvent(type=EventType.RUN_STARTED, thread_id=data.thread_id, run_id=data.run_id))
        if is_resume:
            entry = data.resume[0]
            # CopilotKit's Cancel routes through resolve({cancelled:true}), which
            # sends status="resolved" — so a status-only check reports "granted"
            # for a denial. interpret_resume reads the payload to recover the real
            # approve/deny decision (shared with the projection backend).
            approved = interpret_resume(entry)["approved"]
            text = (
                "Permission granted. The agent is now writing to `src/config.ts`. Fleet status updated."
                if approved
                else "Permission denied. The agent has been notified and will skip the file write operation."
            )
            mid = str(uuid.uuid4())
            yield encoder.encode(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=mid, role="assistant"))
            words = text.split(" ")
            for i in range(0, len(words), 3):
                chunk = " ".join(words[i : i + 3])
                if i + 3 < len(words):
                    chunk += " "
                yield encoder.encode(TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=mid, delta=chunk))
                await asyncio.sleep(0.03)
            yield encoder.encode(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=mid))
            yield encoder.encode(
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=data.thread_id,
                    run_id=data.run_id,
                    outcome=RunFinishedSuccessOutcome(type="success"),
                )
            )
        else:
            # Metadata-only fleet snapshot before the interrupt (no prompt body).
            state = {
                "fleet": {
                    "active_agents": 2,
                    "pending_approvals": 1,
                    "terminals": [
                        {"id": "t1", "agent": "mock_cli", "status": "awaiting_approval", "task": "Refactor config module"},
                        {"id": "t2", "agent": "mock_cli", "status": "running", "task": "Write unit tests"},
                    ],
                }
            }
            yield encoder.encode(StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=state))
            yield encoder.encode(
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=data.thread_id,
                    run_id=data.run_id,
                    outcome=RunFinishedInterruptOutcome(
                        type="interrupt",
                        interrupts=[
                            Interrupt(
                                id=str(uuid.uuid4()),
                                reason="mock_cli:permission_request",
                                message="Allow file write to src/config.ts?",
                                metadata={"provider": "mock_cli", "terminalId": "t1", "command": "Write to src/config.ts"},
                            )
                        ],
                    ),
                )
            )

    return _streaming(request, gen)

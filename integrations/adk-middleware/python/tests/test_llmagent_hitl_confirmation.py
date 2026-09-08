#!/usr/bin/env python
"""Regression test for ag-ui#1839: HITL confirmation on a standalone LlmAgent root.

When a backend tool calls ``tool_context.request_confirmation()`` on a standalone
``LlmAgent`` root with ``ResumabilityConfig(is_resumable=True)``, submitting the
user's confirmation must RE-EXECUTE the original tool — not silently fall through
to the LLM, which then hallucinates an "I'm awaiting confirmation" reply.

Root cause (fixed in adk_agent.py): the #1534 pre-append workaround substituted
``new_message`` with an empty-text placeholder. That placeholder became the last
user event in the session, so ADK's ``_RequestConfirmationLlmRequestProcessor``
(which reverse-scans for the last user event and returns on the first one lacking
``function_responses``) bailed before reaching the pre-appended confirmation
``FunctionResponse``. ``adk_request_confirmation`` is a long-running tool that
PAUSES (not ends) the invocation, so routing it through the direct ``new_message``
path (like Workflow roots) re-executes the tool without re-triggering the #1534
``end_of_agent`` early-return.

This is the LlmAgent cousin of #1669 (the Workflow-root variant).

Requires GOOGLE_API_KEY environment variable (live integration test, like the
sibling HITL tests). Skips gracefully when the key is absent or when the LLM
declines to call the tool (non-determinism).
"""

import asyncio
import os
import time
from typing import List, Optional

import pytest

from ag_ui.core import (
    RunAgentInput,
    EventType,
    UserMessage,
    AssistantMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
    BaseEvent,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.agents.llm_agent import LlmAgent
from google.adk.agents.sequential_agent import SequentialAgent
from google.adk.apps import App, ResumabilityConfig
from google.genai import types

from tests.constants import LIVE_TEST_MODEL


# Shared, env-overridable live model id (see tests/constants.py) so model
# cutovers stay a one-line change across the whole suite.
DEFAULT_MODEL = LIVE_TEST_MODEL
MAX_TOOL_CALL_RETRIES = 3
RC_TOOL_NAME = "adk_request_confirmation"


async def collect_events(agent: ADKAgent, run_input: RunAgentInput) -> List[BaseEvent]:
    events = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


def find_rc_tool_call(events: List[BaseEvent]) -> tuple[Optional[str], str]:
    """Return (tool_call_id, args_json) for the adk_request_confirmation call."""
    rc_id, args, inside = None, "", False
    for event in events:
        if event.type == EventType.TOOL_CALL_START:
            inside = getattr(event, "tool_call_name", None) == RC_TOOL_NAME
            if inside:
                rc_id = getattr(event, "tool_call_id", None)
        elif event.type == EventType.TOOL_CALL_ARGS and inside:
            args += getattr(event, "delta", "")
        elif event.type == EventType.TOOL_CALL_END:
            inside = False
    return rc_id, args


def collect_text(events: List[BaseEvent]) -> str:
    return "".join(
        getattr(e, "delta", "")
        for e in events
        if e.type == EventType.TEXT_MESSAGE_CONTENT
    ).strip()


class _ExecCounter:
    """Mutable backend-tool execution counter shared with the tool closure."""

    def __init__(self) -> None:
        self.executed = 0


def _build_agent(counter: _ExecCounter, *, composite_root: bool) -> ADKAgent:
    def dangerous_action(target: str, tool_context) -> dict:
        """A backend tool gated by HITL confirmation."""
        confirmation = tool_context.tool_confirmation
        if confirmation is None:
            tool_context.request_confirmation(
                hint=f"Confirm dangerous_action on target='{target}'?"
            )
            return {"status": "awaiting_confirmation", "target": target}
        if not confirmation.confirmed:
            return {"status": "rejected", "target": target}
        counter.executed += 1
        return {"status": "executed", "target": target, "count": counter.executed}

    leaf = LlmAgent(
        name="issue_1839_agent",
        model=DEFAULT_MODEL,
        instruction=(
            "When the user asks you to run an action, immediately call "
            "dangerous_action with the requested target. After the tool "
            "returns, briefly tell the user what happened."
        ),
        tools=[dangerous_action],
        generate_content_config=types.GenerateContentConfig(temperature=0.1),
    )
    root = (
        SequentialAgent(name="issue_1839_composite", sub_agents=[leaf])
        if composite_root
        else leaf
    )
    adk_app = App(
        name="issue_1839_app",
        root_agent=root,
        resumability_config=ResumabilityConfig(is_resumable=True),
    )
    return ADKAgent.from_app(
        adk_app,
        user_id="test_user",
        use_in_memory_services=True,
    )


class TestLlmAgentHITLConfirmation:
    """HITL confirmation must re-execute the original backend tool on resume."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure LLMock is running when no real API key is set."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def check_api_key(self):
        if not os.getenv("GOOGLE_API_KEY"):
            pytest.skip("GOOGLE_API_KEY not set - skipping live integration test")

    @pytest.mark.parametrize(
        "composite_root,case",
        [
            # ag-ui#1839 — standalone LlmAgent root (the bug under test).
            (False, "standalone_llm_root"),
            # SequentialAgent composite of LlmAgents. NOT the ADK 2.0 Workflow
            # path (#1669) — that requires google.adk.workflow.Workflow, absent
            # on ADK 1.x, where _root_agent_is_workflow() is always False. On
            # the buggy code this composite hard-crashes on confirmation with
            # "No agent to transfer to"; the same fix covers it.
            (True, "sequential_composite_root"),
        ],
    )
    @pytest.mark.asyncio
    async def test_confirmation_reexecutes_tool(
        self, check_api_key, composite_root, case
    ):
        counter = _ExecCounter()
        agent = _build_agent(counter, composite_root=composite_root)

        rc_id, rc_args = None, ""
        thread_id = None
        for attempt in range(1, MAX_TOOL_CALL_RETRIES + 1):
            counter.executed = 0
            thread_id = f"issue_1839_{case}_{int(time.time())}_{attempt}"
            turn1 = await collect_events(
                agent,
                RunAgentInput(
                    thread_id=thread_id,
                    run_id="run_initial",
                    messages=[
                        UserMessage(
                            id="u-1",
                            role="user",
                            content="Run the dangerous action with target='foo'",
                        )
                    ],
                    tools=[],
                    context=[],
                    state={},
                    forwarded_props={},
                ),
            )
            rc_id, rc_args = find_rc_tool_call(turn1)
            if rc_id:
                break
            SessionManager.reset_instance()
            await asyncio.sleep(1)

        if not rc_id:
            pytest.skip(
                f"Agent did not request confirmation after "
                f"{MAX_TOOL_CALL_RETRIES} attempts (LLM non-determinism)"
            )

        # Turn 1 requests confirmation; the tool must NOT have executed yet.
        assert counter.executed == 0, (
            "dangerous_action executed before confirmation was granted"
        )

        # Turn 2: user confirms. The original tool must re-execute exactly once.
        turn2 = await collect_events(
            agent,
            RunAgentInput(
                thread_id=thread_id,
                run_id="run_confirm",
                messages=[
                    UserMessage(
                        id="u-1",
                        role="user",
                        content="Run the dangerous action with target='foo'",
                    ),
                    AssistantMessage(
                        id="a-1",
                        role="assistant",
                        content=None,
                        tool_calls=[
                            ToolCall(
                                id=rc_id,
                                function=FunctionCall(
                                    name=RC_TOOL_NAME,
                                    arguments=rc_args or "{}",
                                ),
                            )
                        ],
                    ),
                    ToolMessage(
                        id="t-1",
                        role="tool",
                        content='{"confirmed": true}',
                        tool_call_id=rc_id,
                    ),
                ],
                tools=[],
                context=[],
                state={},
                forwarded_props={},
            ),
        )

        text = collect_text(turn2)
        low = text.lower()
        hallucinated = "awaiting confirmation" in low or (
            "await" in low and "confirm" in low
        )

        # Authoritative signal: the backend tool re-executed exactly once.
        assert counter.executed == 1, (
            f"[{case}] expected dangerous_action to re-execute exactly once on "
            f"confirmation, got {counter.executed}. Final text: {text!r}"
        )
        # Second half of the issue comment's ask: no LLM fall-through claiming
        # it is still awaiting confirmation.
        assert not hallucinated, (
            f"[{case}] LLM fell through to an awaiting-confirmation reply "
            f"instead of acting on the re-executed tool: {text!r}"
        )

"""Regression tests for google-adk >=1.30 invocation_id override in Runner.

Context: starting with google-adk 1.30.0, Runner._resolve_invocation_id()
inspects new_message and, if it contains a FunctionResponse, forcibly uses the
invocation_id of the matching FunctionCall event — sending the run down the
resumed-invocation code path. For standalone LlmAgent roots that emitted
end_of_agent=True on the function_call event, that path early-returns without
invoking the LLM, producing zero content events.

See: ag-ui-protocol/ag-ui#1534

The middleware works around this by pre-appending the FunctionResponse to the
session and passing a non-FunctionResponse placeholder as new_message, so that
_resolve_invocation_id short-circuits and the agent is invoked normally.

The tests in this module:

1. Confirm the feature-detection flag `_ADK_OVERRIDES_INVOCATION_ID` matches
   the installed ADK version.
2. Drive an end-to-end tool-only HITL submission against a standalone LlmAgent
   on a resumable App and verify the LLM produces text (the regression the
   upstream change caused).
3. Verify that a tool-only submission pre-appends the FunctionResponse exactly
   once and tags it with the originating FunctionCall's invocation_id (so
   DatabaseSessionService compatibility survives the new contract).
"""

from __future__ import annotations

import os
import time
import pytest
from typing import List, Optional

from ag_ui.core import (
    AssistantMessage,
    BaseEvent,
    EventType,
    FunctionCall,
    RunAgentInput,
    ToolCall,
    ToolMessage,
    Tool as AGUITool,
    UserMessage,
)
from ag_ui_adk import ADKAgent, AGUIToolset
from ag_ui_adk.adk_agent import _ADK_OVERRIDES_INVOCATION_ID
from ag_ui_adk.session_manager import SessionManager
from google.adk import Runner
from google.adk.agents import Agent
from google.adk.apps import App, ResumabilityConfig
from tests.constants import LIVE_TEST_MODEL


DEFAULT_MODEL = LIVE_TEST_MODEL


def _collect_text(events: List[BaseEvent]) -> str:
    buf = ""
    for e in events:
        if e.type == EventType.TEXT_MESSAGE_CONTENT:
            delta = getattr(e, "delta", "") or ""
            buf += delta
    return buf


def _event_types(events: List[BaseEvent]) -> List[str]:
    return [str(e.type) for e in events]


def _find_tool_call_id(events: List[BaseEvent]) -> Optional[str]:
    for e in events:
        if hasattr(e, "tool_call_id") and e.tool_call_id:
            return e.tool_call_id
    return None


async def _collect(agent: ADKAgent, input_data: RunAgentInput) -> List[BaseEvent]:
    events: List[BaseEvent] = []
    async for event in agent.run(input_data):
        events.append(event)
    return events


def test_feature_detection_matches_installed_adk_version():
    """`_ADK_OVERRIDES_INVOCATION_ID` must mirror the real ADK shape."""
    expected = hasattr(Runner, "_resolve_invocation_id")
    assert _ADK_OVERRIDES_INVOCATION_ID is expected


class TestStandaloneLlmAgentToolOnlyHITL:
    """End-to-end regression tests for the ADK 1.30+ tool-only submission path.

    Standalone LlmAgent roots were the configuration broken by the 1.30 runner
    change. The tests here drive the full AG-UI -> ADKAgent -> Runner flow and
    assert the properties that ag-ui-protocol/ag-ui#1534 regressed on.
    """

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

    @pytest.fixture
    def resumable_standalone_agent(self):
        agent = Agent(
            model=DEFAULT_MODEL,
            name="standalone_hitl_agent",
            instruction=(
                "You are a test agent. When asked to check something, call "
                "check_status. When you receive the tool result, acknowledge it "
                "briefly in plain text."
            ),
            tools=[AGUIToolset()],
        )
        app = App(
            name="test_standalone_1534_app",
            root_agent=agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        return ADKAgent.from_app(app, user_id="test_user", use_in_memory_services=True)

    @pytest.mark.asyncio
    async def test_tool_only_submission_invokes_llm(
        self, check_api_key, resumable_standalone_agent
    ):
        """Tool-only HITL submission must invoke the LLM and emit text events.

        This is the ag-ui-protocol/ag-ui#1534 regression: on ADK 1.30+, the
        runner forced the resumed-invocation path and early-returned due to
        end_of_agent=True, so no content was ever produced.
        """
        thread_id = f"test_1534_tool_only_{int(time.time())}"

        approve_tool = AGUITool(
            name="check_status",
            description="Check the status of something",
            parameters={"type": "object", "properties": {}},
        )

        # Turn 1: trigger the tool call
        events_1 = await _collect(
            resumable_standalone_agent,
            RunAgentInput(
                thread_id=thread_id,
                run_id="run_probe",
                messages=[UserMessage(id="m1", role="user", content="Check the status")],
                tools=[approve_tool],
                context=[],
                state={},
                forwarded_props={},
            ),
        )
        tool_call_id = _find_tool_call_id(events_1)
        if tool_call_id is None:
            pytest.skip("Agent did not call the tool - LLM behaviour varied")

        # Turn 2: submit the tool result WITHOUT a trailing user message.
        # This is the exact path that was broken on 1.30.
        events_2 = await _collect(
            resumable_standalone_agent,
            RunAgentInput(
                thread_id=thread_id,
                run_id="run_resume",
                messages=[
                    UserMessage(id="m1", role="user", content="Check the status"),
                    AssistantMessage(
                        id="m2",
                        role="assistant",
                        content=None,
                        tool_calls=[
                            ToolCall(
                                id=tool_call_id,
                                function=FunctionCall(
                                    name="check_status", arguments="{}"
                                ),
                            )
                        ],
                    ),
                    ToolMessage(
                        id="m3",
                        role="tool",
                        content='{"status": "ok"}',
                        tool_call_id=tool_call_id,
                    ),
                ],
                tools=[approve_tool],
                context=[],
                state={},
                forwarded_props={},
            ),
        )

        etypes = _event_types(events_2)
        assert "EventType.RUN_ERROR" not in etypes, f"Got run error: {events_2}"
        assert _collect_text(events_2), (
            "REGRESSION (ag-ui#1534): standalone LlmAgent produced no text after "
            "a tool-only HITL submission. On ADK 1.30+ the middleware must pre-"
            "append the FunctionResponse and pass a non-FunctionResponse "
            "placeholder as new_message to keep _resolve_invocation_id a no-op."
        )

    @pytest.mark.asyncio
    @pytest.mark.skipif(
        not _ADK_OVERRIDES_INVOCATION_ID,
        reason="FunctionCall lookup in session relies on the ADK >=1.30 pre-append workaround",
    )
    async def test_tool_only_submission_persists_single_function_response_with_fc_invocation_id(
        self, check_api_key, resumable_standalone_agent
    ):
        """Pre-append path must not duplicate FunctionResponse events.

        On ADK 1.30+, the workaround pre-appends the FunctionResponse AND still
        hands new_message to the runner. new_message is a placeholder text
        Content (no FunctionResponse) so the runner's _append_new_message_to_session
        will NOT persist a second copy. The FunctionResponse we pre-appended must
        carry the originating FunctionCall event's invocation_id so ADK's
        persistence contract stays consistent.
        """
        thread_id = f"test_1534_fc_inv_id_{int(time.time())}"
        approve_tool = AGUITool(
            name="check_status",
            description="Check status",
            parameters={"type": "object", "properties": {}},
        )

        events_1 = await _collect(
            resumable_standalone_agent,
            RunAgentInput(
                thread_id=thread_id,
                run_id="run_probe",
                messages=[UserMessage(id="m1", role="user", content="Check the status")],
                tools=[approve_tool],
                context=[],
                state={},
                forwarded_props={},
            ),
        )
        tool_call_id = _find_tool_call_id(events_1)
        if tool_call_id is None:
            pytest.skip("Agent did not call the tool")

        await _collect(
            resumable_standalone_agent,
            RunAgentInput(
                thread_id=thread_id,
                run_id="run_resume",
                messages=[
                    UserMessage(id="m1", role="user", content="Check the status"),
                    AssistantMessage(
                        id="m2",
                        role="assistant",
                        content=None,
                        tool_calls=[
                            ToolCall(
                                id=tool_call_id,
                                function=FunctionCall(
                                    name="check_status", arguments="{}"
                                ),
                            )
                        ],
                    ),
                    ToolMessage(
                        id="m3",
                        role="tool",
                        content='{"status": "ok"}',
                        tool_call_id=tool_call_id,
                    ),
                ],
                tools=[approve_tool],
                context=[],
                state={},
                forwarded_props={},
            ),
        )

        app_name = resumable_standalone_agent._get_app_name(
            RunAgentInput(
                thread_id=thread_id,
                run_id="run_resume",
                messages=[],
                tools=[],
                context=[],
                state={},
                forwarded_props={},
            )
        )
        user_id = "test_user"
        backend_session_id = resumable_standalone_agent._get_backend_session_id(
            thread_id, user_id
        )
        assert backend_session_id, "Expected a persisted backend session"

        session = await resumable_standalone_agent._session_manager._session_service.get_session(
            session_id=backend_session_id,
            app_name=app_name,
            user_id=user_id,
        )

        fc_invocation_id = None
        fr_entries = []
        for event in session.events:
            if not event.content or not getattr(event.content, "parts", None):
                continue
            for part in event.content.parts:
                fc = getattr(part, "function_call", None)
                if fc and getattr(fc, "id", None) == tool_call_id:
                    fc_invocation_id = getattr(event, "invocation_id", None)
                fr = getattr(part, "function_response", None)
                if fr and getattr(fr, "id", None) == tool_call_id:
                    fr_entries.append(event)

        assert fc_invocation_id is not None, "No FunctionCall event found in session"
        assert len(fr_entries) == 1, (
            f"Expected exactly 1 FunctionResponse for tool_call_id={tool_call_id}, "
            f"found {len(fr_entries)}. Pre-append must not duplicate with ADK's "
            f"_append_new_message_to_session path."
        )

        if _ADK_OVERRIDES_INVOCATION_ID:
            # On ADK >=1.30 the middleware tags the pre-appended FunctionResponse
            # with the FunctionCall's invocation_id so it matches what ADK itself
            # would have produced.
            assert fr_entries[0].invocation_id == fc_invocation_id, (
                f"FunctionResponse invocation_id should match FunctionCall "
                f"({fc_invocation_id}), got {fr_entries[0].invocation_id}"
            )
        else:
            # Pre-1.30: middleware hands the AG-UI run_id to ADK, which honors it.
            assert fr_entries[0].invocation_id == "run_resume", (
                f"Pre-1.30 behaviour: FunctionResponse invocation_id should be "
                f"'run_resume', got {fr_entries[0].invocation_id}"
            )

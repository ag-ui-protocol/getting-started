#!/usr/bin/env python
"""Tests for `temp:`-prefixed state extracted from the incoming request.

Regression tests for https://github.com/ag-ui-protocol/ag-ui/issues/1571 —
``extract_state_from_request`` used to lose ``temp:`` state because every stock
ADK session service strips ``temp:`` keys on persistence. These tests verify
that ``temp:`` state now reaches ``tool_context.state`` during the invocation
while still being excluded from the persistent session state.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

import pytest

from ag_ui.core import (
    BaseEvent,
    Context,
    EventType,
    RunAgentInput,
    UserMessage,
)
from ag_ui_adk import ADKAgent, SessionManager
from ag_ui_adk.request_state_service import RequestStateSessionService
from google.adk.agents import LlmAgent
from google.adk.sessions import InMemorySessionService
from google.adk.sessions.state import State as ADKState
from google.adk.tools import ToolContext
from tests.constants import LIVE_TEST_MODEL


DEFAULT_MODEL = LIVE_TEST_MODEL


async def _collect(agent: ADKAgent, run_input: RunAgentInput) -> List[BaseEvent]:
    events: List[BaseEvent] = []
    async for event in agent.run(run_input):
        events.append(event)
    return events


def _event_types(events: List[BaseEvent]) -> List[str]:
    return [str(e.type) for e in events]


# ---------------------------------------------------------------------------
# Unit tests for RequestStateSessionService
# ---------------------------------------------------------------------------


class TestRequestStateSessionService:
    """The wrapper merges pending ``temp:`` state into ``get_session`` results."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_pending_state_injected_on_get_session(self):
        inner = InMemorySessionService()
        wrapper = RequestStateSessionService(inner)

        session = await inner.create_session(
            app_name="app", user_id="user", session_id="sess1"
        )

        wrapper.set_pending_temp_state(
            app_name="app",
            user_id="user",
            session_id=session.id,
            temp_state={"temp:token": "abc", "temp:trace": "xyz"},
        )

        fetched = await wrapper.get_session(
            app_name="app", user_id="user", session_id=session.id
        )

        assert fetched is not None
        assert fetched.state["temp:token"] == "abc"
        assert fetched.state["temp:trace"] == "xyz"

    @pytest.mark.asyncio
    async def test_temp_state_not_persisted_to_inner(self):
        """Pending state lives only on the returned copy; storage is untouched."""
        inner = InMemorySessionService()
        wrapper = RequestStateSessionService(inner)

        session = await inner.create_session(
            app_name="app", user_id="user", session_id="sess1"
        )
        wrapper.set_pending_temp_state(
            app_name="app",
            user_id="user",
            session_id=session.id,
            temp_state={"temp:token": "abc"},
        )

        # First fetch sees the injected value.
        first = await wrapper.get_session(
            app_name="app", user_id="user", session_id=session.id
        )
        assert first.state["temp:token"] == "abc"

        # Clear the pending state; subsequent fetches must not see it, and the
        # inner service's storage must not have been mutated.
        wrapper.clear_pending_temp_state(
            app_name="app", user_id="user", session_id=session.id
        )

        second = await wrapper.get_session(
            app_name="app", user_id="user", session_id=session.id
        )
        assert "temp:token" not in second.state

        raw = await inner.get_session(
            app_name="app", user_id="user", session_id=session.id
        )
        assert "temp:token" not in raw.state

    @pytest.mark.asyncio
    async def test_pending_state_scoped_to_session_triple(self):
        inner = InMemorySessionService()
        wrapper = RequestStateSessionService(inner)

        await inner.create_session(app_name="app", user_id="u1", session_id="a")
        await inner.create_session(app_name="app", user_id="u2", session_id="b")

        wrapper.set_pending_temp_state(
            app_name="app",
            user_id="u1",
            session_id="a",
            temp_state={"temp:token": "for-u1"},
        )

        other = await wrapper.get_session(app_name="app", user_id="u2", session_id="b")
        assert "temp:token" not in other.state

        mine = await wrapper.get_session(app_name="app", user_id="u1", session_id="a")
        assert mine.state["temp:token"] == "for-u1"

    @pytest.mark.asyncio
    async def test_empty_or_none_removes_pending(self):
        inner = InMemorySessionService()
        wrapper = RequestStateSessionService(inner)
        await inner.create_session(app_name="app", user_id="u", session_id="s")

        wrapper.set_pending_temp_state(
            app_name="app", user_id="u", session_id="s",
            temp_state={"temp:token": "t"},
        )
        wrapper.set_pending_temp_state(
            app_name="app", user_id="u", session_id="s", temp_state=None,
        )

        fetched = await wrapper.get_session(app_name="app", user_id="u", session_id="s")
        assert "temp:token" not in fetched.state

    @pytest.mark.asyncio
    async def test_delete_session_clears_pending(self):
        inner = InMemorySessionService()
        wrapper = RequestStateSessionService(inner)
        await inner.create_session(app_name="app", user_id="u", session_id="s")

        wrapper.set_pending_temp_state(
            app_name="app", user_id="u", session_id="s",
            temp_state={"temp:token": "t"},
        )
        await wrapper.delete_session(app_name="app", user_id="u", session_id="s")

        # Re-create the session; pending state should be gone.
        await inner.create_session(app_name="app", user_id="u", session_id="s")
        fetched = await wrapper.get_session(app_name="app", user_id="u", session_id="s")
        assert "temp:token" not in fetched.state

    @pytest.mark.asyncio
    async def test_flush_delegates_to_inner_service(self):
        """flush() must propagate to the wrapped service — regression for #2206.

        Without delegation, write-behind session services are silently never
        flushed, causing data loss.
        """
        flushed = []

        class BufferingSessionService(InMemorySessionService):
            async def flush(self) -> None:
                flushed.append(True)

        inner = BufferingSessionService()
        wrapper = RequestStateSessionService(inner)

        await wrapper.flush()

        assert flushed == [True], "flush() did not delegate to the inner service"

    @pytest.mark.asyncio
    async def test_flush_tolerates_inner_without_flush(self):
        """flush() must not fail when inner service lacks flush (no-op gracefully)."""

        class MinimalSessionService:
            """A mock that has no flush method at all."""

            async def create_session(self, **kwargs):
                return None

            async def get_session(self, **kwargs):
                return None

            async def list_sessions(self, **kwargs):
                return []

            async def delete_session(self, **kwargs):
                pass

            async def append_event(self, session, event):
                return event

        inner = MinimalSessionService()
        wrapper = RequestStateSessionService(inner)

        # Should not raise — just no-op
        await wrapper.flush()

    @pytest.mark.asyncio
    async def test_flush_idempotent_no_state(self):
        """Calling flush() with no pending state or sessions is a safe no-op."""
        flushed = []

        class BufferingSessionService(InMemorySessionService):
            async def flush(self) -> None:
                flushed.append(True)

        wrapper = RequestStateSessionService(BufferingSessionService())

        # Multiple flushes with no sessions/state
        await wrapper.flush()
        await wrapper.flush()

        assert flushed == [True, True], "flush() should delegate every call"


# ---------------------------------------------------------------------------
# ADKAgent wiring: the session service is auto-wrapped at construction time.
# ---------------------------------------------------------------------------


class TestADKAgentWrapsSessionService:
    """ADKAgent must always expose a RequestStateSessionService internally."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    def _make_agent(self, *, session_service=None) -> ADKAgent:
        adk = LlmAgent(name="stub", model=DEFAULT_MODEL, instruction="hi")
        return ADKAgent(
            adk_agent=adk,
            app_name="test_app",
            user_id="test_user",
            session_service=session_service,
            use_in_memory_services=True,
        )

    def test_default_service_is_wrapped(self):
        agent = self._make_agent()
        assert isinstance(agent._request_state_service, RequestStateSessionService)
        assert agent._session_manager._session_service is agent._request_state_service

    def test_user_supplied_service_is_wrapped(self):
        supplied = InMemorySessionService()
        agent = self._make_agent(session_service=supplied)
        assert isinstance(agent._request_state_service, RequestStateSessionService)
        assert agent._request_state_service.inner is supplied

    def test_already_wrapped_service_is_reused(self):
        supplied = RequestStateSessionService(InMemorySessionService())
        agent = self._make_agent(session_service=supplied)
        assert agent._request_state_service is supplied


# ---------------------------------------------------------------------------
# End-to-end: `temp:` state extracted from the request reaches the tool and
# is not persisted to the session after the run completes.
# ---------------------------------------------------------------------------


class TestTempStateReachesToolContext:
    """End-to-end verification using a real ADK LlmAgent + llmock fixture."""

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure the LLMock server is running."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.mark.asyncio
    async def test_temp_state_visible_in_tool_context(self):
        observed_state: Dict[str, Any] = {}

        def check_temp_state_tool(tool_context: ToolContext) -> str:
            """Snapshot ``tool_context.state`` so the test can inspect it."""
            observed_state.update(tool_context.state.to_dict())
            return "ok"

        llm_agent = LlmAgent(
            name="temp_state_agent",
            model=DEFAULT_MODEL,
            instruction=(
                "You have a tool called check_temp_state_tool. Always call it "
                "when the user asks you to."
            ),
            tools=[check_temp_state_tool],
        )

        session_service = InMemorySessionService()
        adk_agent = ADKAgent(
            adk_agent=llm_agent,
            app_name="temp_state_app",
            user_id="temp_state_user",
            session_service=session_service,
        )

        run_input = RunAgentInput(
            thread_id="temp_state_thread",
            run_id="run_1",
            messages=[
                UserMessage(id="msg_1", role="user", content="read the temp token"),
            ],
            context=[Context(description="env", value="prod")],
            state={
                "temp:token": "bearer-xyz",
                "non_temp_key": "persisted-value",
            },
            tools=[],
            forwarded_props={},
        )

        events = await _collect(adk_agent, run_input)
        types = _event_types(events)

        assert "EventType.RUN_STARTED" in types
        assert "EventType.RUN_FINISHED" in types
        assert "EventType.RUN_ERROR" not in types

        # Tool must have been invoked (the mock LLM's tool-call fixture fired).
        assert observed_state, "Tool was not invoked — llmock fixture mismatch?"

        # Temp state extracted from the request is visible to the tool.
        assert observed_state.get("temp:token") == "bearer-xyz"
        # Persistent state is also visible.
        assert observed_state.get("non_temp_key") == "persisted-value"

        # After the run, `temp:` keys must NOT be persisted to session storage.
        # Read through the raw service, bypassing the wrapper, so we see what
        # was actually written.
        stored = await session_service.list_sessions(
            app_name="temp_state_app", user_id="temp_state_user"
        )
        assert len(stored.sessions) == 1
        raw_session = await session_service.get_session(
            app_name="temp_state_app",
            user_id="temp_state_user",
            session_id=stored.sessions[0].id,
        )
        assert raw_session is not None
        assert not any(
            k.startswith(ADKState.TEMP_PREFIX) for k in raw_session.state.keys()
        ), f"temp: keys were persisted: {list(raw_session.state)}"
        # Non-temp keys are persisted.
        assert raw_session.state.get("non_temp_key") == "persisted-value"

        # The wrapper cleared pending temp state after the run finished.
        assert (
            "temp_state_app",
            "temp_state_user",
            stored.sessions[0].id,
        ) not in adk_agent._request_state_service._pending_temp_state

        # STATE_SNAPSHOT events sent to the client must not expose `temp:`
        # keys — they're server-side ephemeral state.
        snapshot_events = [e for e in events if str(e.type) == "EventType.STATE_SNAPSHOT"]
        assert snapshot_events, "Expected at least one STATE_SNAPSHOT event"
        for snap in snapshot_events:
            assert not any(
                isinstance(k, str) and k.startswith(ADKState.TEMP_PREFIX)
                for k in snap.snapshot.keys()
            ), f"temp: keys leaked into STATE_SNAPSHOT: {list(snap.snapshot.keys())}"

        await adk_agent.close()

    @pytest.mark.asyncio
    async def test_temp_state_absent_when_request_has_none(self):
        """Requests without temp state must still work unchanged."""
        observed_state: Dict[str, Any] = {}

        def check_temp_state_tool(tool_context: ToolContext) -> str:
            observed_state.update(tool_context.state.to_dict())
            return "ok"

        llm_agent = LlmAgent(
            name="temp_state_agent_2",
            model=DEFAULT_MODEL,
            instruction="Always call the tool.",
            tools=[check_temp_state_tool],
        )

        adk_agent = ADKAgent(
            adk_agent=llm_agent,
            app_name="temp_state_app_2",
            user_id="u2",
            use_in_memory_services=True,
        )

        run_input = RunAgentInput(
            thread_id="t2",
            run_id="r2",
            messages=[UserMessage(id="m1", role="user", content="read the temp token")],
            context=[],
            state={"plain_key": "plain_value"},
            tools=[],
            forwarded_props={},
        )

        events = await _collect(adk_agent, run_input)
        assert "EventType.RUN_ERROR" not in _event_types(events)
        # No temp keys should be observed.
        assert not any(
            k.startswith(ADKState.TEMP_PREFIX) for k in observed_state.keys()
        )
        assert observed_state.get("plain_key") == "plain_value"

        await adk_agent.close()

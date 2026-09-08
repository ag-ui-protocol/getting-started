#!/usr/bin/env python
"""Tests for LRO SSE streaming tool-call ID remapping fix.

When SSE streaming is enabled (the default), ADK's populate_client_function_call_id()
generates *different* UUIDs for the same logical function call across the partial
(streaming) and final (persisted) events.  This causes HITL workflows to break
because the client captures ID-A from the partial event, but ADK persists ID-B
in the session — so submitting a FunctionResponse with ID-A fails:

    "No function call event found for function responses ids: ['ID-A']"

The fix captures the ID-A → ID-B mapping when the non-partial event arrives and
remaps tool_call_id values in FunctionResponse construction.

Unit tests (mocked) run without credentials.
Integration tests require GOOGLE_API_KEY or Vertex AI auth.
"""

import asyncio
import json
import logging
import os
import uuid
import warnings
import pytest
import pytest_asyncio
from pathlib import Path
from typing import AsyncGenerator, Dict, List, Optional
from unittest.mock import MagicMock, AsyncMock, patch

from ag_ui.core import (
    RunAgentInput,
    UserMessage,
    AssistantMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
    EventType,
    BaseEvent,
    Tool as AGUITool,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    RunStartedEvent,
    RunFinishedEvent,
)
from ag_ui_adk import ADKAgent
from ag_ui_adk.event_translator import EventTranslator
from ag_ui_adk.session_manager import SessionManager
from tests.constants import LIVE_TEST_MODEL


# =============================================================================
# Unit Tests — No credentials required
# =============================================================================


class TestExtractLroIdRemap:
    """Unit tests for ADKAgent._extract_lro_id_remap."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def adk_agent(self):
        from google.adk.agents import Agent
        mock = MagicMock(spec=Agent)
        mock.name = "test_agent"
        mock.model_copy = MagicMock(return_value=mock)
        return ADKAgent(adk_agent=mock, app_name="test", user_id="u1")

    @pytest.fixture
    def translator(self):
        return EventTranslator()

    def _make_event(self, fc_name: str, fc_id: str):
        fc = MagicMock()
        fc.id = fc_id
        fc.name = fc_name
        part = MagicMock()
        part.function_call = fc
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = [part]
        return evt

    def test_remap_detected_when_ids_differ(self, adk_agent, translator):
        """When the translator emitted ID-A but the final event has ID-B, a remap is produced."""
        translator.lro_emitted_ids_by_name["my_tool"] = ["partial-id-AAA"]
        final_event = self._make_event("my_tool", "final-id-BBB")

        remap = adk_agent._extract_lro_id_remap(final_event, translator)

        assert remap == {"partial-id-AAA": "final-id-BBB"}

    def test_no_remap_when_ids_match(self, adk_agent, translator):
        """When partial and final IDs are the same, no remap is needed."""
        translator.lro_emitted_ids_by_name["my_tool"] = ["same-id"]
        final_event = self._make_event("my_tool", "same-id")

        remap = adk_agent._extract_lro_id_remap(final_event, translator)

        assert remap == {}

    def test_no_remap_for_unknown_tool(self, adk_agent, translator):
        """If the translator didn't emit for this tool name, no remap."""
        final_event = self._make_event("unknown_tool", "some-id")

        remap = adk_agent._extract_lro_id_remap(final_event, translator)

        assert remap == {}

    def test_no_remap_for_empty_event(self, adk_agent, translator):
        """Events without content produce no remap."""
        translator.lro_emitted_ids_by_name["my_tool"] = ["partial-id"]
        evt = MagicMock()
        evt.content = None

        remap = adk_agent._extract_lro_id_remap(evt, translator)

        assert remap == {}

    def test_multiple_tools_remapped(self, adk_agent, translator):
        """Multiple LRO tool calls in one event all get remapped."""
        translator.lro_emitted_ids_by_name["tool_a"] = ["partial-A"]
        translator.lro_emitted_ids_by_name["tool_b"] = ["partial-B"]

        fc_a = MagicMock(); fc_a.id = "final-A"; fc_a.name = "tool_a"
        fc_b = MagicMock(); fc_b.id = "final-B"; fc_b.name = "tool_b"
        part_a = MagicMock(); part_a.function_call = fc_a
        part_b = MagicMock(); part_b.function_call = fc_b
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = [part_a, part_b]

        remap = adk_agent._extract_lro_id_remap(evt, translator)

        assert remap == {"partial-A": "final-A", "partial-B": "final-B"}

    def test_parallel_same_name_tools_remapped(self, adk_agent, translator):
        """Multiple parallel calls to the same tool all get remapped (issue #1334)."""
        # Simulate 3 parallel calls to create_item with different partial IDs
        translator.lro_emitted_ids_by_name["create_item"] = [
            "partial-1", "partial-2", "partial-3"
        ]

        fc_1 = MagicMock(); fc_1.id = "final-1"; fc_1.name = "create_item"
        fc_2 = MagicMock(); fc_2.id = "final-2"; fc_2.name = "create_item"
        fc_3 = MagicMock(); fc_3.id = "final-3"; fc_3.name = "create_item"
        part_1 = MagicMock(); part_1.function_call = fc_1
        part_2 = MagicMock(); part_2.function_call = fc_2
        part_3 = MagicMock(); part_3.function_call = fc_3
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = [part_1, part_2, part_3]

        remap = adk_agent._extract_lro_id_remap(evt, translator)

        assert remap == {
            "partial-1": "final-1",
            "partial-2": "final-2",
            "partial-3": "final-3",
        }


class TestLroIdRemapSessionState:
    """Test storing and retrieving LRO ID remap from session state."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def adk_agent(self):
        from google.adk.agents import Agent
        mock = MagicMock(spec=Agent)
        mock.name = "test_agent"
        mock.model_copy = MagicMock(return_value=mock)
        return ADKAgent(adk_agent=mock, app_name="test", user_id="u1")

    @pytest.mark.asyncio
    async def test_store_and_retrieve_remap(self, adk_agent):
        """Round-trip: store a remap, then retrieve it."""
        session, session_id = await adk_agent._ensure_session_exists(
            "test", "u1", "thread1", {}
        )
        remap = {"partial-AAA": "final-BBB"}
        await adk_agent._store_lro_id_remap(remap, session_id, "test", "u1")

        retrieved = await adk_agent._get_lro_id_remap(session_id, "test", "u1")
        assert retrieved == {"partial-AAA": "final-BBB"}

    @pytest.mark.asyncio
    async def test_store_merges_existing(self, adk_agent):
        """Subsequent stores merge into the existing remap."""
        session, session_id = await adk_agent._ensure_session_exists(
            "test", "u1", "thread2", {}
        )
        await adk_agent._store_lro_id_remap({"id-1": "final-1"}, session_id, "test", "u1")
        await adk_agent._store_lro_id_remap({"id-2": "final-2"}, session_id, "test", "u1")

        retrieved = await adk_agent._get_lro_id_remap(session_id, "test", "u1")
        assert retrieved == {"id-1": "final-1", "id-2": "final-2"}

    @pytest.mark.asyncio
    async def test_consume_removes_entry(self, adk_agent):
        """_consume_lro_id_remap returns the remapped ID and removes the entry."""
        session, session_id = await adk_agent._ensure_session_exists(
            "test", "u1", "thread3", {}
        )
        await adk_agent._store_lro_id_remap(
            {"partial-X": "final-X", "partial-Y": "final-Y"},
            session_id, "test", "u1",
        )

        result = await adk_agent._consume_lro_id_remap("partial-X", session_id, "test", "u1")
        assert result == "final-X"

        # partial-X should be removed, partial-Y still present
        remaining = await adk_agent._get_lro_id_remap(session_id, "test", "u1")
        assert remaining == {"partial-Y": "final-Y"}

    @pytest.mark.asyncio
    async def test_consume_returns_original_when_no_remap(self, adk_agent):
        """_consume_lro_id_remap returns the original ID when there's no remap."""
        session, session_id = await adk_agent._ensure_session_exists(
            "test", "u1", "thread4", {}
        )

        result = await adk_agent._consume_lro_id_remap("no-such-id", session_id, "test", "u1")
        assert result == "no-such-id"


class TestEventTranslatorLroTracking:
    """Test that EventTranslator.translate_lro_function_calls records emitted IDs by name."""

    @pytest.fixture
    def translator(self):
        return EventTranslator()

    def _make_lro_event(self, fc_name: str, fc_id: str):
        fc = MagicMock()
        fc.id = fc_id
        fc.name = fc_name
        fc.args = {"key": "val"}
        part = MagicMock()
        part.function_call = fc
        part.text = None
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = [part]
        evt.long_running_tool_ids = [fc_id]
        return evt

    @pytest.mark.asyncio
    async def test_lro_emitted_ids_by_name_populated(self, translator):
        """translate_lro_function_calls should record name→ID in lro_emitted_ids_by_name."""
        evt = self._make_lro_event("get_approval", "adk-partial-123")

        events = []
        async for e in translator.translate_lro_function_calls(evt):
            events.append(e)

        # Should have emitted TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END
        assert len(events) == 3
        assert events[0].type == EventType.TOOL_CALL_START
        assert events[0].tool_call_id == "adk-partial-123"

        # Verify the name→ID mapping
        assert translator.lro_emitted_ids_by_name == {"get_approval": ["adk-partial-123"]}

    @pytest.mark.asyncio
    async def test_lro_emitted_ids_cleared_on_reset(self, translator):
        """reset() should clear lro_emitted_ids_by_name."""
        translator.lro_emitted_ids_by_name["some_tool"] = ["some-id"]
        translator.reset()
        assert translator.lro_emitted_ids_by_name == {}


class TestLroDuplicateEmissionSuppression:
    """Regression: a single logical LRO call streamed by ADK as a partial event
    then a final event (with *different* IDs, per #1168) must emit exactly ONE
    TOOL_CALL trio — not two. Otherwise the dojo renders the HITL card twice.
    """

    @pytest.fixture
    def translator(self):
        return EventTranslator()

    def _event(self, fcs, *, partial):
        """Build an ADK-style event. ``fcs`` is a list of (name, id) tuples."""
        parts = []
        for name, fid in fcs:
            fc = MagicMock()
            fc.id = fid
            fc.name = name
            fc.args = {"steps": [{"description": "x", "status": "enabled"}]}
            part = MagicMock()
            part.function_call = fc
            part.text = None
            parts.append(part)
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = parts
        evt.long_running_tool_ids = [fid for _, fid in fcs]
        evt.partial = partial
        return evt

    async def _starts(self, translator, evt):
        ids = []
        async for e in translator.translate_lro_function_calls(evt):
            if e.type == EventType.TOOL_CALL_START:
                ids.append(e.tool_call_id)
        return ids

    @pytest.mark.asyncio
    async def test_partial_then_final_emits_once(self, translator):
        """The non-partial twin (different id) is suppressed — one emission total."""
        partial_ids = await self._starts(
            translator, self._event([("generate_task_steps", "adk-AAA")], partial=True)
        )
        final_ids = await self._starts(
            translator, self._event([("generate_task_steps", "adk-BBB")], partial=False)
        )
        assert partial_ids == ["adk-AAA"]
        assert final_ids == [], "final twin must be suppressed (no duplicate render)"

    @pytest.mark.asyncio
    async def test_parallel_same_name_calls_not_oversuppressed(self, translator):
        """Two genuinely parallel calls each emit once (partials), finals suppressed."""
        partial_ids = await self._starts(
            translator,
            self._event(
                [("generate_task_steps", "adk-A1"), ("generate_task_steps", "adk-A2")],
                partial=True,
            ),
        )
        final_ids = await self._starts(
            translator,
            self._event(
                [("generate_task_steps", "adk-B1"), ("generate_task_steps", "adk-B2")],
                partial=False,
            ),
        )
        assert partial_ids == ["adk-A1", "adk-A2"]
        assert final_ids == []  # both finals are twins of the two partials

    @pytest.mark.asyncio
    async def test_final_only_still_emits(self, translator):
        """Non-streaming case (no partial twin): the final must still emit once."""
        final_ids = await self._starts(
            translator, self._event([("generate_task_steps", "adk-ONLY")], partial=False)
        )
        assert final_ids == ["adk-ONLY"]

    @pytest.mark.asyncio
    async def test_second_partial_replay_suppressed(self, translator):
        """ADK can replay the call in a SECOND partial chunk (e.g. streaming
        chunk + aggregated partial) with yet another ID — also a twin."""
        first = await self._starts(
            translator, self._event([("generate_task_steps", "adk-P1")], partial=True)
        )
        second = await self._starts(
            translator, self._event([("generate_task_steps", "adk-P2")], partial=True)
        )
        final = await self._starts(
            translator, self._event([("generate_task_steps", "adk-F1")], partial=False)
        )
        assert first == ["adk-P1"]
        assert second == [], "second partial replay must be suppressed"
        assert final == [], "final replay must be suppressed"

    @pytest.mark.asyncio
    async def test_reset_clears_replay_ledger(self, translator):
        """After reset(), a same-name call in a new run emits again."""
        await self._starts(
            translator, self._event([("generate_task_steps", "adk-RUN1")], partial=True)
        )
        translator.reset()
        ids = await self._starts(
            translator, self._event([("generate_task_steps", "adk-RUN2")], partial=True)
        )
        assert ids == ["adk-RUN2"]

    @pytest.mark.asyncio
    async def test_lro_adk_request_credential_oauth2(self, translator):
        """Regression (#1331): adk_request_credential with OAuth2 AuthConfig must serialize.

        ADK emits a long-running function call named ``adk_request_credential``
        whose args dict contains an ``AuthConfig`` Pydantic model.  The model
        in turn nests ``OAuth2`` which has a ``type_: SecuritySchemeType`` enum
        field.  Before the fix, ``json.dumps`` raised:

            TypeError: Object of type SecuritySchemeType is not JSON serializable
        """
        from fastapi.openapi.models import OAuthFlowAuthorizationCode
        from google.adk.auth.auth_schemes import OAuth2, OAuthFlows, SecuritySchemeType
        from google.adk.auth import AuthConfig
        from google.adk.auth.auth_credential import (
            AuthCredential,
            AuthCredentialTypes,
            OAuth2Auth,
        )

        auth_scheme = OAuth2(
            flows=OAuthFlows(
                authorizationCode=OAuthFlowAuthorizationCode(
                    authorizationUrl="https://accounts.google.com/o/oauth2/auth",
                    tokenUrl="https://oauth2.googleapis.com/token",
                    scopes={
                        "https://www.googleapis.com/auth/calendar": "Calendar access",
                    },
                ),
            ),
        )
        raw_credential = AuthCredential(
            auth_type=AuthCredentialTypes.OAUTH2,
            oauth2=OAuth2Auth(
                client_id="123456.apps.googleusercontent.com",
                client_secret="GOCSPX-secret",
            ),
        )
        auth_config = AuthConfig(
            auth_scheme=auth_scheme,
            raw_auth_credential=raw_credential,
        )

        fc = MagicMock()
        fc.id = "adk-cred-123"
        fc.name = "adk_request_credential"
        fc.args = {
            "function_call_id": "adk-cred-123",
            "auth_config": auth_config,
        }
        part = MagicMock()
        part.function_call = fc
        part.text = None
        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = [part]
        evt.long_running_tool_ids = ["adk-cred-123"]

        events = []
        async for e in translator.translate_lro_function_calls(evt):
            events.append(e)

        assert len(events) == 3
        assert events[0].type == EventType.TOOL_CALL_START
        assert events[0].tool_call_name == "adk_request_credential"

        args_event = events[1]
        assert args_event.type == EventType.TOOL_CALL_ARGS
        parsed = json.loads(args_event.delta)
        assert parsed["function_call_id"] == "adk-cred-123"

        ac = parsed["auth_config"]
        assert ac["auth_scheme"]["type_"] == "oauth2"
        assert ac["raw_auth_credential"]["auth_type"] == "oauth2"
        assert ac["raw_auth_credential"]["oauth2"]["client_id"] == "123456.apps.googleusercontent.com"
        auth_code_flow = ac["auth_scheme"]["flows"]["authorizationCode"]
        assert auth_code_flow["authorizationUrl"] == "https://accounts.google.com/o/oauth2/auth"
        assert auth_code_flow["tokenUrl"] == "https://oauth2.googleapis.com/token"

    @pytest.mark.asyncio
    async def test_parallel_same_name_lro_calls_all_emitted(self, translator):
        """Multiple parallel LRO calls to the same tool should all be emitted (issue #1334)."""
        # Build an event with 3 parallel calls to the same tool
        parts = []
        lro_ids = []
        for i in range(3):
            fc = MagicMock()
            fc.id = f"partial-{i}"
            fc.name = "create_item"
            fc.args = {"name": f"item-{i}"}
            part = MagicMock()
            part.function_call = fc
            part.text = None
            parts.append(part)
            lro_ids.append(fc.id)

        evt = MagicMock()
        evt.content = MagicMock()
        evt.content.parts = parts
        evt.long_running_tool_ids = lro_ids

        events = []
        async for e in translator.translate_lro_function_calls(evt):
            events.append(e)

        # Should have 3 × (START, ARGS, END) = 9 events
        assert len(events) == 9
        start_events = [e for e in events if e.type == EventType.TOOL_CALL_START]
        assert len(start_events) == 3
        assert {e.tool_call_id for e in start_events} == {"partial-0", "partial-1", "partial-2"}

        # All 3 IDs should be tracked
        assert translator.lro_emitted_ids_by_name == {
            "create_item": ["partial-0", "partial-1", "partial-2"]
        }


class TestDrainPathCapturesRemap:
    """Test that the LRO drain path captures the ID remap from the non-partial event."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def adk_agent(self):
        from google.adk.agents import Agent
        mock = MagicMock(spec=Agent)
        mock.name = "test_agent"
        mock.model_copy = MagicMock(return_value=mock)
        return ADKAgent(adk_agent=mock, app_name="test", user_id="u1")

    @pytest.mark.asyncio
    async def test_drain_captures_remap_from_final_event(self, adk_agent):
        """When LRO is detected on partial event and we drain to non-partial,
        the remap from partial-ID → final-ID should be stored in session state."""
        partial_fc_id = f"adk-partial-{uuid.uuid4().hex[:8]}"
        final_fc_id = f"adk-final-{uuid.uuid4().hex[:8]}"

        def create_event(partial, fc_id):
            fc = MagicMock()
            fc.id = fc_id
            fc.name = "client_tool"
            fc.args = {"key": "value"}
            part = MagicMock()
            part.text = None
            part.function_call = fc
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = [part]
            evt.partial = partial
            evt.turn_complete = not partial
            evt.is_final_response = MagicMock(return_value=not partial)
            evt.get_function_calls = MagicMock(return_value=[fc])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = [fc_id]
            evt.invocation_id = "inv-test"
            return evt

        async def mock_run_async(**kwargs):
            # Event 1: partial=True with fc_id = partial_fc_id
            yield create_event(partial=True, fc_id=partial_fc_id)
            # Event 2: partial=False with fc_id = final_fc_id (DIFFERENT!)
            yield create_event(partial=False, fc_id=final_fc_id)

        mock_runner = MagicMock()
        mock_runner.run_async = mock_run_async

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"
        input_data = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="u1", role="user", content="Test")],
            tools=[],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_agent, "_create_runner", return_value=mock_runner):
            events = []
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                async for e in adk_agent.run(input_data):
                    events.append(e)

        # Verify tool call events were emitted with the partial ID
        tool_call_starts = [e for e in events if isinstance(e, ToolCallStartEvent)]
        assert len(tool_call_starts) >= 1
        assert tool_call_starts[0].tool_call_id == partial_fc_id

        # Verify the remap was stored in session state
        metadata = adk_agent._get_session_metadata(thread_id, "u1")
        assert metadata is not None
        session_id, app_name, user_id = metadata
        remap = await adk_agent._get_lro_id_remap(session_id, app_name, user_id)
        assert remap.get(partial_fc_id) == final_fc_id, (
            f"Expected remap {partial_fc_id} -> {final_fc_id}, got: {remap}"
        )


class TestFunctionResponseRemapping:
    """Test that FunctionResponse construction applies the LRO ID remap."""

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def sample_tool(self):
        return AGUITool(
            name="client_tool",
            description="A client-side tool",
            parameters={
                "type": "object",
                "properties": {"action": {"type": "string"}},
            },
        )

    @pytest.mark.asyncio
    async def test_tool_result_uses_remapped_id(self, sample_tool):
        """End-to-end: partial ID emitted to client, final ID used in FunctionResponse."""
        from google.adk.agents import Agent

        partial_fc_id = f"adk-partial-{uuid.uuid4().hex[:8]}"
        final_fc_id = f"adk-final-{uuid.uuid4().hex[:8]}"

        mock_agent = MagicMock(spec=Agent)
        mock_agent.name = "test_agent"
        mock_agent.model_copy = MagicMock(return_value=mock_agent)

        adk_middleware = ADKAgent(
            adk_agent=mock_agent,
            app_name="test_app",
            user_id="test_user",
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"

        # --- Run 1: LRO tool call with SSE streaming ID mismatch ---
        def create_event(partial, fc_id):
            fc = MagicMock()
            fc.id = fc_id
            fc.name = "client_tool"
            fc.args = {"action": "deploy"}
            part = MagicMock()
            part.text = None
            part.function_call = fc
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = [part]
            evt.partial = partial
            evt.turn_complete = not partial
            evt.is_final_response = MagicMock(return_value=not partial)
            evt.get_function_calls = MagicMock(return_value=[fc])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = [fc_id]
            evt.invocation_id = "inv-run1"
            return evt

        async def mock_run_async_run1(**kwargs):
            yield create_event(partial=True, fc_id=partial_fc_id)
            yield create_event(partial=False, fc_id=final_fc_id)

        mock_runner1 = MagicMock()
        mock_runner1.run_async = mock_run_async_run1

        run1_input = RunAgentInput(
            thread_id=thread_id,
            run_id="run_1",
            messages=[UserMessage(id="u1", role="user", content="Deploy the app")],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_middleware, "_create_runner", return_value=mock_runner1):
            run1_events = []
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                async for e in adk_middleware.run(run1_input):
                    run1_events.append(e)

        # Client received partial_fc_id in TOOL_CALL events
        tool_call_ends = [e for e in run1_events if isinstance(e, ToolCallEndEvent)]
        assert len(tool_call_ends) >= 1
        assert tool_call_ends[0].tool_call_id == partial_fc_id

        # --- Run 2: Submit tool result with client-facing partial_fc_id ---

        # Track what FunctionResponse ID is actually sent to ADK
        captured_function_response_ids = []

        async def mock_run_async_run2(**kwargs):
            # Capture the FunctionResponse ID from the new_message
            new_msg = kwargs.get("new_message")
            if new_msg and hasattr(new_msg, "parts"):
                for part in new_msg.parts:
                    if hasattr(part, "function_response") and part.function_response:
                        captured_function_response_ids.append(part.function_response.id)

            # Yield a simple text response
            text_part = MagicMock()
            text_part.text = "Deployment complete!"
            text_part.function_call = None
            evt = MagicMock()
            evt.author = "assistant"
            evt.content = MagicMock()
            evt.content.parts = [text_part]
            evt.partial = False
            evt.turn_complete = True
            evt.is_final_response = MagicMock(return_value=True)
            evt.get_function_calls = MagicMock(return_value=[])
            evt.get_function_responses = MagicMock(return_value=[])
            evt.long_running_tool_ids = []
            evt.invocation_id = "inv-run2"
            yield evt

        mock_runner2 = MagicMock()
        mock_runner2.run_async = mock_run_async_run2

        run2_input = RunAgentInput(
            thread_id=thread_id,
            run_id="run_2",
            messages=[
                UserMessage(id="u1", role="user", content="Deploy the app"),
                AssistantMessage(
                    id="a1",
                    role="assistant",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=partial_fc_id,
                            type="function",
                            function=FunctionCall(
                                name="client_tool",
                                arguments='{"action": "deploy"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(
                    id="t1",
                    role="tool",
                    tool_call_id=partial_fc_id,
                    content='{"status": "success"}',
                ),
            ],
            tools=[sample_tool],
            context=[],
            state={},
            forwarded_props={},
        )

        with patch.object(adk_middleware, "_create_runner", return_value=mock_runner2):
            run2_events = []
            async for e in adk_middleware.run(run2_input):
                run2_events.append(e)

        # CRITICAL ASSERTION: The FunctionResponse sent to ADK should use
        # the final (persisted) ID, not the partial (client-facing) ID
        assert len(captured_function_response_ids) >= 1, (
            "No FunctionResponse was sent to ADK — tool result was not submitted"
        )
        assert captured_function_response_ids[0] == final_fc_id, (
            f"FunctionResponse should use remapped ID {final_fc_id}, "
            f"but used {captured_function_response_ids[0]}. "
            f"The LRO ID remap was not applied!"
        )


class TestMultiRoundLroStatePoisoning:
    """Regression tests for state poisoning across multiple HITL rounds.

    When the frontend sends back ``input.state`` containing stale
    ``lro_tool_call_id_remap`` data, the backend must not let it overwrite
    the fresh remap stored during the current run.  Without the fix, the
    second HITL tool call in a session fails because the remap is lost.

    See: https://github.com/ag-ui-protocol/ag-ui/issues/1168 (decster's report)
    """

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def sample_tool(self):
        return AGUITool(
            name="client_tool",
            description="A client-side tool",
            parameters={
                "type": "object",
                "properties": {"action": {"type": "string"}},
            },
        )

    @staticmethod
    def _create_lro_event(partial, fc_id, fc_name="client_tool", invocation_id="inv"):
        fc = MagicMock()
        fc.id = fc_id
        fc.name = fc_name
        fc.args = {"action": "test"}
        part = MagicMock()
        part.text = None
        part.function_call = fc
        evt = MagicMock()
        evt.author = "assistant"
        evt.content = MagicMock()
        evt.content.parts = [part]
        evt.partial = partial
        evt.turn_complete = not partial
        evt.is_final_response = MagicMock(return_value=not partial)
        evt.get_function_calls = MagicMock(return_value=[fc])
        evt.get_function_responses = MagicMock(return_value=[])
        evt.long_running_tool_ids = [fc_id]
        evt.invocation_id = invocation_id
        return evt

    @staticmethod
    def _create_text_event(text="Done", invocation_id="inv"):
        text_part = MagicMock()
        text_part.text = text
        text_part.function_call = None
        evt = MagicMock()
        evt.author = "assistant"
        evt.content = MagicMock()
        evt.content.parts = [text_part]
        evt.partial = False
        evt.turn_complete = True
        evt.is_final_response = MagicMock(return_value=True)
        evt.get_function_calls = MagicMock(return_value=[])
        evt.get_function_responses = MagicMock(return_value=[])
        evt.long_running_tool_ids = []
        evt.invocation_id = invocation_id
        return evt

    @pytest.mark.asyncio
    async def test_second_hitl_tool_call_not_poisoned_by_stale_state(self, sample_tool):
        """Two sequential HITL round-trips must both succeed.

        Reproduces the exact scenario from issue #1168:
        1. Run 1: LRO with partial-id-1 → final-id-1
        2. Resume 1: tool result with partial-id-1 (remapped to final-id-1) — works
        3. Run 2: LRO with partial-id-2 → final-id-2
        4. Resume 2: tool result with partial-id-2 — MUST remap to final-id-2
           (previously failed because stale frontend state overwrote the remap)
        """
        from google.adk.agents import Agent

        mock_agent = MagicMock(spec=Agent)
        mock_agent.name = "test_agent"
        mock_agent.model_copy = MagicMock(return_value=mock_agent)

        adk = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="u1")
        thread_id = f"thread_{uuid.uuid4().hex[:8]}"

        partial_id_1 = "adk-partial-1111"
        final_id_1 = "adk-final-1111"
        partial_id_2 = "adk-partial-2222"
        final_id_2 = "adk-final-2222"

        # === Run 1: first LRO tool call ===
        async def mock_run1(**kwargs):
            yield self._create_lro_event(True, partial_id_1, invocation_id="inv-1")
            yield self._create_lro_event(False, final_id_1, invocation_id="inv-1")

        mock_runner1 = MagicMock()
        mock_runner1.run_async = mock_run1

        run1_input = RunAgentInput(
            thread_id=thread_id, run_id="run-1",
            messages=[UserMessage(id="u1", role="user", content="Do thing 1")],
            tools=[sample_tool], context=[], state={}, forwarded_props={},
        )

        with patch.object(adk, "_create_runner", return_value=mock_runner1):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                run1_events = [e async for e in adk.run(run1_input)]

        # Verify remap was stored
        metadata = adk._get_session_metadata(thread_id, "u1")
        session_id, app_name, user_id = metadata
        remap1 = await adk._get_lro_id_remap(session_id, app_name, user_id)
        assert remap1.get(partial_id_1) == final_id_1

        # === Resume 1: submit tool result with partial-id-1 ===
        # Simulate frontend sending back stale state that includes the remap
        stale_state_from_frontend = {"lro_tool_call_id_remap": {partial_id_1: final_id_1}}

        captured_ids_resume1 = []

        async def mock_resume1(**kwargs):
            new_msg = kwargs.get("new_message")
            if new_msg and hasattr(new_msg, "parts"):
                for part in new_msg.parts:
                    if hasattr(part, "function_response") and part.function_response:
                        captured_ids_resume1.append(part.function_response.id)
            yield self._create_text_event("Done 1", invocation_id="inv-1-resume")

        mock_runner_resume1 = MagicMock()
        mock_runner_resume1.run_async = mock_resume1

        resume1_input = RunAgentInput(
            thread_id=thread_id, run_id="run-1-resume",
            messages=[
                UserMessage(id="u1", role="user", content="Do thing 1"),
                AssistantMessage(id="a1", role="assistant", content="",
                    tool_calls=[ToolCall(id=partial_id_1, type="function",
                        function=FunctionCall(name="client_tool", arguments='{"action": "test"}'))]),
                ToolMessage(id="t1", role="tool", tool_call_id=partial_id_1, content='{"ok": true}'),
            ],
            tools=[sample_tool], context=[],
            state=stale_state_from_frontend,  # <-- stale state from frontend!
            forwarded_props={},
        )

        with patch.object(adk, "_create_runner", return_value=mock_runner_resume1):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                resume1_events = [e async for e in adk.run(resume1_input)]

        assert captured_ids_resume1 == [final_id_1], (
            f"Resume 1 should have remapped {partial_id_1} -> {final_id_1}"
        )

        # === Run 2: second LRO tool call ===
        async def mock_run2(**kwargs):
            yield self._create_lro_event(True, partial_id_2, invocation_id="inv-2")
            yield self._create_lro_event(False, final_id_2, invocation_id="inv-2")

        mock_runner2 = MagicMock()
        mock_runner2.run_async = mock_run2

        # Frontend sends back stale state again (still has the old consumed remap)
        stale_state_run2 = {"lro_tool_call_id_remap": {}}

        run2_input = RunAgentInput(
            thread_id=thread_id, run_id="run-2",
            messages=[
                UserMessage(id="u1", role="user", content="Do thing 1"),
                AssistantMessage(id="a1", role="assistant", content="Done 1"),
                UserMessage(id="u2", role="user", content="Do thing 2"),
            ],
            tools=[sample_tool], context=[],
            state=stale_state_run2,  # <-- stale state that would overwrite new remap
            forwarded_props={},
        )

        with patch.object(adk, "_create_runner", return_value=mock_runner2):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                run2_events = [e async for e in adk.run(run2_input)]

        # Verify second remap was stored (not overwritten by stale state)
        remap2 = await adk._get_lro_id_remap(session_id, app_name, user_id)
        assert remap2.get(partial_id_2) == final_id_2, (
            f"Second LRO remap should be {partial_id_2} -> {final_id_2}, "
            f"but got: {remap2}. Stale frontend state likely overwrote it."
        )

        # === Resume 2: submit tool result with partial-id-2 ===
        captured_ids_resume2 = []

        async def mock_resume2(**kwargs):
            new_msg = kwargs.get("new_message")
            if new_msg and hasattr(new_msg, "parts"):
                for part in new_msg.parts:
                    if hasattr(part, "function_response") and part.function_response:
                        captured_ids_resume2.append(part.function_response.id)
            yield self._create_text_event("Done 2", invocation_id="inv-2-resume")

        mock_runner_resume2 = MagicMock()
        mock_runner_resume2.run_async = mock_resume2

        # Frontend again sends stale state (empty remap or old data)
        stale_state_resume2 = {"lro_tool_call_id_remap": {partial_id_1: final_id_1}}

        resume2_input = RunAgentInput(
            thread_id=thread_id, run_id="run-2-resume",
            messages=[
                UserMessage(id="u2", role="user", content="Do thing 2"),
                AssistantMessage(id="a2", role="assistant", content="",
                    tool_calls=[ToolCall(id=partial_id_2, type="function",
                        function=FunctionCall(name="client_tool", arguments='{"action": "test"}'))]),
                ToolMessage(id="t2", role="tool", tool_call_id=partial_id_2, content='{"ok": true}'),
            ],
            tools=[sample_tool], context=[],
            state=stale_state_resume2,  # <-- stale state: old remap, missing new remap!
            forwarded_props={},
        )

        with patch.object(adk, "_create_runner", return_value=mock_runner_resume2):
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                resume2_events = [e async for e in adk.run(resume2_input)]

        # CRITICAL: The second resume must use the correct remapped ID
        assert captured_ids_resume2 == [final_id_2], (
            f"Resume 2 should have remapped {partial_id_2} -> {final_id_2}, "
            f"but got {captured_ids_resume2}. "
            f"State poisoning from stale frontend state caused remap loss!"
        )

    @pytest.mark.asyncio
    async def test_internal_state_keys_stripped_from_input(self, sample_tool):
        """Verify that _INTERNAL_STATE_KEYS are stripped from input.state
        before being applied to the session."""
        from ag_ui_adk.adk_agent import _INTERNAL_STATE_KEYS
        from google.adk.agents import Agent

        mock_agent = MagicMock(spec=Agent)
        mock_agent.name = "test_agent"
        mock_agent.model_copy = MagicMock(return_value=mock_agent)

        adk = ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="u1")
        thread_id = f"thread_{uuid.uuid4().hex[:8]}"

        # Pre-store a remap in the session
        session, session_id = await adk._ensure_session_exists(
            "test_app", "u1", thread_id, {}
        )
        await adk._store_lro_id_remap(
            {"real-partial": "real-final"}, session_id, "test_app", "u1"
        )

        # Simulate a request where frontend sends back stale internal state
        poisoned_state = {
            "lro_tool_call_id_remap": {"stale-partial": "stale-final"},
            "_ag_ui_context": "stale-context",
            "_ag_ui_thread_id": "wrong-thread",
            "user_visible_key": "user-value",  # This should NOT be stripped
        }

        async def mock_run(**kwargs):
            yield self._create_text_event("ok")

        mock_runner = MagicMock()
        mock_runner.run_async = mock_run

        input_data = RunAgentInput(
            thread_id=thread_id, run_id="run-test",
            messages=[UserMessage(id="u1", role="user", content="test")],
            tools=[], context=[], state=poisoned_state, forwarded_props={},
        )

        with patch.object(adk, "_create_runner", return_value=mock_runner):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                [e async for e in adk.run(input_data)]

        # The real remap should survive (not overwritten by stale data)
        remap = await adk._get_lro_id_remap(session_id, "test_app", "u1")
        assert "real-partial" in remap, (
            f"Backend remap was overwritten by stale frontend state. Got: {remap}"
        )
        assert "stale-partial" not in remap, (
            f"Stale frontend remap leaked into backend state. Got: {remap}"
        )


# =============================================================================
# Integration Tests — Require Google AI or Vertex AI auth
# =============================================================================


def _has_google_auth():
    """Check if Google AI or Vertex AI authentication is available."""
    if os.environ.get("GOOGLE_API_KEY"):
        return True
    if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").upper() == "TRUE":
        if os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("VERTEXAI_PROJECT"):
            return True
    return False


class TestLROSSEIdRemapIntegration:
    """Integration tests that verify HITL works with SSE streaming.

    These verify the full round-trip:
    1. Agent calls an LRO tool (SSE streaming produces partial → final with different IDs)
    2. Client submits tool result using the ID from the partial event
    3. ADK processes the tool result successfully (the remap makes IDs match)
    """

    @pytest.fixture(autouse=True)
    def setup_llmock(self, llmock_server):
        """Ensure LLMock is running when no real API key is set."""

    @pytest.fixture(autouse=True)
    def skip_without_auth(self):
        """Skip if no authentication is available."""
        if not _has_google_auth():
            pytest.skip("No Google authentication available")

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def lro_tool(self):
        return AGUITool(
            name="get_approval",
            description="Ask the user to approve an action. Always use this tool.",
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to approve",
                    }
                },
                "required": ["action"],
            },
        )

    @pytest.mark.asyncio
    async def test_hitl_round_trip_with_sse_streaming(self, lro_tool):
        """Full HITL round-trip: tool call → tool result → agent continues.

        This is the primary regression test for the streaming ID mismatch bug.
        With SSE streaming enabled, the partial event carries ID-A and the final
        event carries ID-B.  Without the remap fix, submitting the tool result
        with ID-A would fail.
        """
        from google.adk.agents import LlmAgent
        from google.adk.sessions import InMemorySessionService
        from google.adk.agents.run_config import RunConfig, StreamingMode
        from ag_ui_adk.agui_toolset import AGUIToolset

        session_service = InMemorySessionService()
        app_name = f"test_hitl_remap_{uuid.uuid4().hex[:8]}"

        agent = LlmAgent(
            name="approval_agent",
            model=LIVE_TEST_MODEL,
            instruction=(
                "When asked to do anything, ALWAYS use the get_approval tool first. "
                "Pass the action description as the 'action' parameter."
            ),
            tools=[AGUIToolset()],
        )

        def sse_config(inp):
            return RunConfig(streaming_mode=StreamingMode.SSE)

        adk_agent = ADKAgent(
            adk_agent=agent,
            app_name=app_name,
            user_id="test_user",
            session_service=session_service,
            run_config_factory=sse_config,
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"

        # --- Run 1: Trigger the LRO tool call ---
        run1_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(id="msg1", role="user", content="Please deploy version 2.0")
            ],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        run1_events: list[BaseEvent] = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(run1_input):
                run1_events.append(event)

        # Find the tool_call_id the client received
        tool_call_id = None
        tool_call_name = None
        for evt in run1_events:
            if isinstance(evt, ToolCallStartEvent):
                tool_call_id = evt.tool_call_id
                tool_call_name = evt.tool_call_name
                break

        assert tool_call_id is not None, (
            f"No TOOL_CALL_START event found. Events: "
            f"{[type(e).__name__ for e in run1_events]}"
        )

        # --- Run 2: Submit tool result using the client-facing ID ---
        run2_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(id="msg1", role="user", content="Please deploy version 2.0"),
                AssistantMessage(
                    id="a1",
                    role="assistant",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            type="function",
                            function=FunctionCall(
                                name=tool_call_name or "get_approval",
                                arguments='{"action": "deploy version 2.0"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(
                    id="t1",
                    role="tool",
                    tool_call_id=tool_call_id,
                    content='{"approved": true, "message": "Deployment approved"}',
                ),
            ],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        # This is the critical step: if the remap doesn't work, ADK will raise
        # "No function call event found for function responses ids: [<client_id>]"
        run2_events: list[BaseEvent] = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(run2_input):
                run2_events.append(event)

        run2_types = [str(e.type).split(".")[-1] for e in run2_events]

        # Verify the run completed successfully (no RUN_ERROR)
        assert "RUN_ERROR" not in run2_types, (
            f"Run 2 failed with error. This likely means the LRO ID remap "
            f"did not work — ADK couldn't find the FunctionCall matching the "
            f"tool_call_id '{tool_call_id}'. Events: {run2_types}"
        )
        assert "RUN_STARTED" in run2_types, f"Missing RUN_STARTED. Got: {run2_types}"
        assert "RUN_FINISHED" in run2_types, f"Missing RUN_FINISHED. Got: {run2_types}"

    @pytest.mark.asyncio
    async def test_hitl_without_streaming_still_works(self, lro_tool):
        """Baseline: HITL works without streaming (no ID mismatch occurs)."""
        from google.adk.agents import LlmAgent
        from google.adk.sessions import InMemorySessionService
        from google.adk.agents.run_config import RunConfig, StreamingMode
        from ag_ui_adk.agui_toolset import AGUIToolset

        session_service = InMemorySessionService()
        app_name = f"test_hitl_no_stream_{uuid.uuid4().hex[:8]}"

        agent = LlmAgent(
            name="approval_agent",
            model=LIVE_TEST_MODEL,
            instruction=(
                "When asked to do anything, ALWAYS use the get_approval tool first. "
                "Pass the action description as the 'action' parameter."
            ),
            tools=[AGUIToolset()],
        )

        def no_streaming_config(inp):
            return RunConfig(streaming_mode=StreamingMode.NONE)

        adk_agent = ADKAgent(
            adk_agent=agent,
            app_name=app_name,
            user_id="test_user",
            session_service=session_service,
            run_config_factory=no_streaming_config,
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"

        # --- Run 1 ---
        run1_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(id="msg1", role="user", content="Please deploy version 2.0")
            ],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        run1_events = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(run1_input):
                run1_events.append(event)

        tool_call_id = None
        tool_call_name = None
        for evt in run1_events:
            if isinstance(evt, ToolCallStartEvent):
                tool_call_id = evt.tool_call_id
                tool_call_name = evt.tool_call_name
                break

        if tool_call_id is None:
            pytest.skip("Agent did not call the tool (non-streaming baseline)")

        # --- Run 2 ---
        run2_input = RunAgentInput(
            thread_id=thread_id,
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[
                UserMessage(id="msg1", role="user", content="Please deploy version 2.0"),
                AssistantMessage(
                    id="a1",
                    role="assistant",
                    content="",
                    tool_calls=[
                        ToolCall(
                            id=tool_call_id,
                            type="function",
                            function=FunctionCall(
                                name=tool_call_name or "get_approval",
                                arguments='{"action": "deploy version 2.0"}',
                            ),
                        )
                    ],
                ),
                ToolMessage(
                    id="t1",
                    role="tool",
                    tool_call_id=tool_call_id,
                    content='{"approved": true}',
                ),
            ],
            state={},
            tools=[lro_tool],
            context=[],
            forwarded_props={},
        )

        run2_events = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(run2_input):
                run2_events.append(event)

        run2_types = [str(e.type).split(".")[-1] for e in run2_events]
        assert "RUN_ERROR" not in run2_types, (
            f"Baseline (no streaming) failed. Events: {run2_types}"
        )


# =============================================================================
# Stale-session regression for the lro_tool_call_id_remap writer (issue #1754)
# =============================================================================

# The middleware writes ``lro_tool_call_id_remap`` to ``session.state`` from
# inside the producer's ``async for adk_event in runner.run_async(...)`` loop
# in ``_run_adk_in_background`` (``adk_agent.py:2497`` LRO drain branch and
# ``:2604`` main branch). That write goes through ``update_session_state`` ->
# ``session_service.append_event``, which bumps the storage marker on the
# session row that ADK's Runner still holds in ``invocation_context.session``.
# On resumable HITL (``ResumabilityConfig(is_resumable=True)``) ADK does NOT
# hard-stop the runner after the LRO event, so a subsequent ADK
# ``append_event`` on the stale in-memory session raises
# ``ValueError: The session has been modified in storage since it was loaded``
# from ``DatabaseSessionService``'s OCC check (ADK >= 1.27).
#
# Same OCC failure shape as #1732, but a separate writer that PR #1735's
# consumer-side fix can't reach (the writes live inside the producer task).
# See follow-up issue #1754.


_STALE_MARKER_1754 = (
    "The session has been modified in storage since it was loaded"
)


class _StaleSessionDetector1754(logging.Handler):
    """Catch the stale-session ValueError surfaced through the adk_agent logger.

    The ValueError is raised by ADK's runner
    (``DatabaseSessionService.append_event``) and propagates out of the
    background task, where ``_run_adk_in_background`` logs it via
    ``logger.error('Background execution error: ...', exc_info=True)`` before
    emitting a ``RunErrorEvent``. We listen on the root logger for the marker
    string so the test can detect the bug from outside ADKAgent.
    """

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)
        self.tripped: bool = False
        self.first: Optional[str] = None

    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if _STALE_MARKER_1754 in msg:
            self.tripped = True
            if self.first is None:
                self.first = f"{record.name}: {msg}"


def _make_db_url_1754(tmp_path: Path) -> str:
    """Default to a temporary sqlite+aiosqlite file (same OCC code path as
    Postgres). Override with ``AGUI_DATABASE_URL`` to run against a real
    Postgres in CI/local."""
    override = os.getenv("AGUI_DATABASE_URL")
    if override:
        return override
    db_path = tmp_path / f"repro_1754_{uuid.uuid4().hex}.db"
    return f"sqlite+aiosqlite:///{db_path}"


# Backend tool callable used by the deterministic scripted-LLM test. Returning
# a result (not None) is required: it forces ADK to build a function_response
# event AFTER the LRO event, which is the subsequent ``append_event`` call
# that exposes the stale in-memory session marker.
def log_action(action: str = "") -> str:
    """Backend tool callable used by the deterministic #1754 test."""
    return f"logged: {action}"


def _scripted_lro_plus_backend_llm(backend_tool_name: str, frontend_tool_name: str):
    """Stub LLM that emits the exact event shape needed to trip #1754.

    Drives a single turn that yields:
      1. ``partial=True`` with two parallel ``function_call`` parts (the
         backend tool plus the frontend tool). Both calls are emitted
         without IDs, so ADK's ``populate_client_function_call_id``
         assigns fresh UUIDs.
      2. ``partial=False`` with the same two function_call parts. ADK
         assigns NEW UUIDs again — divergent from chunk #1.

    The middleware's ``_extract_lro_id_remap`` sees the chunk-1 → chunk-2
    ID divergence and calls ``_store_lro_id_remap`` mid-runner (the bug
    site). ADK then dispatches both tools: the backend tool returns a
    result, so ADK builds a ``function_response`` event and calls
    ``append_event`` on it — that's the subsequent ADK write that fails
    OCC because the in-memory session is now stale.
    """
    from google.adk.models.base_llm import BaseLlm
    from google.adk.models.llm_response import LlmResponse
    from google.genai import types as genai_types

    class _ScriptedLroPlusBackend(BaseLlm):
        backend_tool: str = backend_tool_name
        frontend_tool: str = frontend_tool_name

        async def generate_content_async(
            self, llm_request, stream: bool = False
        ) -> AsyncGenerator[LlmResponse, None]:
            def _make_response(*, partial: bool) -> LlmResponse:
                return LlmResponse(
                    content=genai_types.Content(
                        role="model",
                        parts=[
                            genai_types.Part(
                                function_call=genai_types.FunctionCall(
                                    name=self.backend_tool,
                                    args={"action": "archive_files"},
                                )
                            ),
                            genai_types.Part(
                                function_call=genai_types.FunctionCall(
                                    name=self.frontend_tool,
                                    args={"action": "archive_files"},
                                )
                            ),
                        ],
                    ),
                    partial=partial,
                    turn_complete=not partial,
                )

            # Chunk: ADK skips function_call execution for partial=True
            # but the middleware still translates these into TOOL_CALL_*
            # events, populating ``lro_emitted_ids_by_name`` with id_A.
            yield _make_response(partial=True)
            # Final: ADK assigns NEW UUIDs (id_B), appends this event,
            # then dispatches both tools and builds the function_response.
            yield _make_response(partial=False)

    return _ScriptedLroPlusBackend(model="scripted-lro-plus-backend")


class TestLroIdRemapStaleSessionRegression:
    """Deterministic regression test for issue #1754.

    Drives a resumable HITL turn with a scripted LLM that emits a
    partial -> final pair containing parallel function_calls (one
    backend, one frontend). The scripted shape guarantees:

      - LRO ID divergence between partial and final events (because ADK
        assigns fresh UUIDs to function_calls without explicit IDs each
        time ``populate_client_function_call_id`` runs).
      - The middleware calls ``_store_lro_id_remap`` mid-runner.
      - ADK builds a ``function_response`` event for the backend tool
        AFTER the middleware's write, then calls ``append_event`` on it.
        That second ADK ``append_event`` is where the stale in-memory
        session triggers the OCC error.

    Real ADK runner + real ``DatabaseSessionService`` are used so the
    OCC check actually fires. No real LLM is needed.
    """

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest_asyncio.fixture
    async def detector(self):
        handler = _StaleSessionDetector1754()
        root = logging.getLogger()
        prev_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.ERROR)
        try:
            yield handler
        finally:
            root.removeHandler(handler)
            root.setLevel(prev_level)

    @pytest.mark.asyncio
    async def test_resumable_hitl_lro_remap_does_not_trip_stale_session(
        self, detector, tmp_path
    ):
        """End-to-end #1754 reproducer.

        Without the producer-side buffer-and-flush fix, this test fails
        with ``ValueError: The session has been modified in storage since
        it was loaded`` — same shape as #1732, different writer.
        """
        from ag_ui_adk.agui_toolset import AGUIToolset
        from google.adk.agents import LlmAgent
        from google.adk.apps import App, ResumabilityConfig
        from google.adk.sessions import DatabaseSessionService

        db_url = _make_db_url_1754(tmp_path)
        session_service = DatabaseSessionService(db_url=db_url)
        app_name = f"repro_1754_{uuid.uuid4().hex[:8]}"

        frontend_tool = AGUITool(
            name="approve_action",
            description="Ask the user to approve an action.",
            parameters={
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                },
                "required": ["action"],
            },
        )

        scripted_model = _scripted_lro_plus_backend_llm(
            backend_tool_name="log_action",
            frontend_tool_name="approve_action",
        )

        agent = LlmAgent(
            name="hitl_lro_remap_agent",
            model=scripted_model,
            instruction="Call the tools when asked.",
            # ``log_action`` is a real Python callable -> wrapped as
            # a regular FunctionTool (is_long_running=False) by ADK.
            # ``AGUIToolset()`` is the placeholder swapped at runtime
            # for ClientProxyToolset built from RunAgentInput.tools.
            tools=[log_action, AGUIToolset()],
        )

        adk_app = App(
            name=app_name,
            root_agent=agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )

        adk_agent = ADKAgent.from_app(
            adk_app,
            user_id="user_1",
            session_service=session_service,
        )

        thread_id = f"thread_{uuid.uuid4().hex[:8]}"
        events: List[BaseEvent] = []
        saw_run_error = False

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(
                RunAgentInput(
                    thread_id=thread_id,
                    run_id=str(uuid.uuid4()),
                    state={},
                    messages=[
                        UserMessage(
                            id=str(uuid.uuid4()),
                            content="Please archive the project files.",
                        )
                    ],
                    tools=[frontend_tool],
                    context=[],
                    forwarded_props={},
                )
            ):
                events.append(event)
                if type(event).__name__ == "RunErrorEvent":
                    saw_run_error = True
                    logging.getLogger(__name__).error(
                        f"RunErrorEvent: code={getattr(event, 'code', None)} "
                        f"message={getattr(event, 'message', None)}"
                    )

        # (1) The #1754 regression assertion. Without the producer-side
        # fix, _store_lro_id_remap bumps the DB version mid-runner and
        # ADK's next append_event (for the backend tool's function_response)
        # raises the OCC ValueError, which gets logged by
        # _run_adk_in_background as "Background execution error: ...".
        assert not detector.tripped, (
            f"Stale-session error logged during resumable HITL + LRO-remap "
            f"turn: {detector.first}. This is the regression from issue "
            f"#1754 (same OCC shape as #1732, different writer)."
        )

        # (2) No RUN_ERROR surfaces to the client.
        assert not saw_run_error, (
            "RunErrorEvent surfaced from resumable HITL + LRO-remap turn — "
            "#1754 regression. Check test logs for the underlying "
            "ValueError message."
        )

        # (3) If a remap was captured (chunk-1 IDs differ from chunk-2),
        # it must be persisted by run-end so future tool-result
        # submissions can translate the client-facing IDs back to
        # ADK-persisted IDs.
        metadata = adk_agent._get_session_metadata(thread_id, "user_1")
        if metadata is None:
            return
        session_id, lookup_app_name, user_id = metadata
        session = await session_service.get_session(
            session_id=session_id,
            app_name=lookup_app_name,
            user_id=user_id,
        )
        assert session is not None
        stored_remap = session.state.get("lro_tool_call_id_remap", {})
        assert isinstance(stored_remap, dict), (
            f"lro_tool_call_id_remap must be a dict; got {type(stored_remap)}"
        )
        for k, v in stored_remap.items():
            assert isinstance(k, str) and isinstance(v, str), (
                f"lro_tool_call_id_remap entries must be str->str; got "
                f"{type(k)}->{type(v)}"
            )


class TestLroNoDuplicateToolCallEndToEnd:
    """End-to-end regression: a long-running client tool streamed by ADK as a
    partial then final event (with different IDs, #1168) must surface exactly
    ONE TOOL_CALL_START to the client — not two. The duplicate is cross-path:
    the EventTranslator emits from the partial event while ADK separately
    invokes the ClientProxyTool for the final, each with a different ID, so the
    ID-based dedupe on both sides misses. Drives the real ADK runner + real
    ClientProxyTool + real EventTranslator (no real LLM, no DB).
    """

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    def _scripted_lro_llm(self, tool_name: str, shape: str = "partial-final"):
        from google.adk.models.base_llm import BaseLlm
        from google.adk.models.llm_response import LlmResponse
        from google.genai import types as gt

        class _ScriptedLro(BaseLlm):
            name_: str = tool_name
            shape_: str = shape

            async def generate_content_async(
                self, llm_request, stream: bool = False
            ) -> AsyncGenerator:
                def mk(partial, turn_complete=None):
                    return LlmResponse(
                        content=gt.Content(
                            role="model",
                            parts=[gt.Part(function_call=gt.FunctionCall(
                                name=self.name_, args={"action": "archive"}))],
                        ),
                        partial=partial,
                        turn_complete=(not partial) if turn_complete is None else turn_complete,
                    )
                # Each yield gets a FRESH ID from ADK's
                # populate_client_function_call_id — guaranteed divergence.
                if self.shape_ == "two-partials":
                    # streaming chunk + aggregated partial + persisted final
                    yield mk(partial=True)
                    yield mk(partial=True)
                    yield mk(partial=False)
                elif self.shape_ == "two-partials-no-final":
                    # the "last event is partial, which is not expected" shape
                    yield mk(partial=True)
                    yield mk(partial=True, turn_complete=True)
                else:  # partial-final
                    yield mk(partial=True)
                    yield mk(partial=False)

        return _ScriptedLro(model=f"scripted-lro-{shape}")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "shape", ["partial-final", "two-partials", "two-partials-no-final"]
    )
    async def test_partial_plus_proxy_emits_single_tool_call(self, shape):
        from ag_ui_adk.agui_toolset import AGUIToolset
        from google.adk.agents import LlmAgent
        from google.adk.apps import App, ResumabilityConfig

        frontend_tool = AGUITool(
            name="approve_action",
            description="Ask the user to approve an action.",
            parameters={
                "type": "object",
                "properties": {"action": {"type": "string"}},
                "required": ["action"],
            },
        )
        agent = LlmAgent(
            name="hitl_dupe_agent",
            model=self._scripted_lro_llm("approve_action", shape),
            instruction="Call the tool when asked.",
            tools=[AGUIToolset()],
        )
        adk_app = App(
            name=f"app_{uuid.uuid4().hex[:8]}",
            root_agent=agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        adk_agent = ADKAgent.from_app(
            adk_app, user_id="u1", use_in_memory_services=True,
        )

        starts = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            async for event in adk_agent.run(
                RunAgentInput(
                    thread_id=f"t_{uuid.uuid4().hex[:8]}",
                    run_id=str(uuid.uuid4()),
                    state={},
                    messages=[UserMessage(id=str(uuid.uuid4()), content="archive please")],
                    tools=[frontend_tool],
                    context=[],
                    forwarded_props={},
                )
            ):
                if event.type == EventType.TOOL_CALL_START:
                    starts.append((event.tool_call_id, getattr(event, "tool_call_name", None)))

        approve_starts = [s for s in starts if s[1] == "approve_action"]
        assert len(approve_starts) == 1, (
            f"Expected exactly one TOOL_CALL_START for approve_action, got "
            f"{len(approve_starts)}: {approve_starts}. The partial→proxy "
            f"cross-path duplicate (#1168) has regressed."
        )


# =============================================================================
# Direct Execution
# =============================================================================

if __name__ == "__main__":
    if _has_google_auth():
        print("Running all tests (Google authentication available)")
        pytest.main([__file__, "-v", "-s"])
    else:
        print("No Google authentication — running unit tests only")
        print("Set GOOGLE_API_KEY or configure Vertex AI to run integration tests")
        pytest.main([__file__, "-v", "-s", "-k", "not Integration"])
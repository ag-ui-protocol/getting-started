"""Tests for session manager provider integration in StrandsAgent."""

from __future__ import annotations

import copy
from unittest.mock import MagicMock, patch

import pytest
from strands.agent.state import AgentState
from strands.session import SessionManager

from ag_ui_strands.session_reconcile import AG_UI_WIRE_MAP_STATE_KEY

from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


def _mock_session_manager() -> MagicMock:
    """Create a MagicMock that passes isinstance(..., SessionManager)."""
    return MagicMock(spec=SessionManager)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_run_input(
    thread_id: str | None = "thread-1",
    run_id: str = "run-1",
    messages=None,
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        state={},
        messages=messages or [],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _collect_events(agent: StrandsAgent, input_data: RunAgentInput) -> list:
    events = []
    async for event in agent.run(input_data):
        events.append(event)
    return events


async def _empty_async_gen():
    """Async generator that yields nothing, simulating a completed agent stream."""
    return
    yield  # pragma: no cover — makes this an async generator


def _make_base_agent(session_manager_provider=None) -> StrandsAgent:
    """Create a StrandsAgent with a mocked underlying Strands agent."""
    mock_core = MagicMock()
    mock_core.model = MagicMock()
    mock_core.system_prompt = "You are a test assistant."
    mock_core.tool_registry = MagicMock()
    mock_core.tool_registry.registry = {}
    mock_core.record_direct_tool_call = True

    config = StrandsAgentConfig(session_manager_provider=session_manager_provider)
    return StrandsAgent(agent=mock_core, name="test_agent", config=config)


def _make_mock_instance():
    instance = MagicMock()
    instance.tool_registry = MagicMock()
    instance.tool_registry.registry = {}
    instance.stream_async = MagicMock(side_effect=lambda _: _empty_async_gen())
    return instance


class _MockStrandsAgentWithPrivateSessionManager:
    def __init__(self, session_manager):
        self._session_manager = session_manager
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.stream_prompts = []

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        return
        yield  # pragma: no cover


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSessionManagerProvider:
    @pytest.mark.asyncio
    async def test_provider_called_for_new_thread(self):
        """Provider is invoked exactly once when a new thread is first seen."""
        mock_session_manager = _mock_session_manager()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)
        input_data = _make_run_input(thread_id="new-thread")

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, input_data)

        provider.assert_called_once_with(input_data)
        _, kwargs = MockCore.call_args
        assert kwargs.get("session_manager") is mock_session_manager

    @pytest.mark.asyncio
    async def test_provider_not_called_for_existing_thread(self):
        """Provider is NOT called again for subsequent requests on the same thread."""
        mock_session_manager = _mock_session_manager()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)
        thread_id = "cached-thread"

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, _make_run_input(thread_id=thread_id, run_id="run-1"))
            await _collect_events(agent, _make_run_input(thread_id=thread_id, run_id="run-2"))

        # Provider and constructor each called only once despite two runs
        provider.assert_called_once()
        MockCore.assert_called_once()

    @pytest.mark.asyncio
    async def test_provider_exception_yields_error_events(self):
        """When the provider raises, RunStartedEvent and RunErrorEvent are yielded."""
        def failing_provider(input_data):
            raise RuntimeError("session store unavailable")

        agent = _make_base_agent(session_manager_provider=failing_provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            events = await _collect_events(agent, _make_run_input())

        # StrandsAgentCore should never be constructed
        MockCore.assert_not_called()

        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_ERROR in event_types
        # Early return means no RUN_FINISHED
        assert EventType.RUN_FINISHED not in event_types

        error_event = next(e for e in events if e.type == EventType.RUN_ERROR)
        assert "session store unavailable" in error_event.message
        assert error_event.code == "SESSION_MANAGER_ERROR"

    @pytest.mark.asyncio
    async def test_async_provider_is_awaited(self):
        """Async provider functions are properly awaited and their result used."""
        mock_session_manager = _mock_session_manager()

        async def async_provider(input_data):
            return mock_session_manager

        agent = _make_base_agent(session_manager_provider=async_provider)
        input_data = _make_run_input(thread_id="async-thread")

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            events = await _collect_events(agent, input_data)

        event_types = [e.type for e in events]
        assert EventType.RUN_STARTED in event_types
        assert EventType.RUN_FINISHED in event_types
        assert EventType.RUN_ERROR not in event_types

        _, kwargs = MockCore.call_args
        assert kwargs.get("session_manager") is mock_session_manager

    @pytest.mark.asyncio
    async def test_no_provider_passes_none_session_manager(self):
        """When no provider is configured, session_manager=None is passed."""
        agent = _make_base_agent(session_manager_provider=None)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, _make_run_input())

        _, kwargs = MockCore.call_args
        assert kwargs.get("session_manager") is None

    @pytest.mark.asyncio
    async def test_empty_thread_id_uses_default_key(self):
        """Empty/falsy thread_id falls back to the 'default' cache key."""
        provider = MagicMock(return_value=_mock_session_manager())
        agent = _make_base_agent(session_manager_provider=provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            await _collect_events(agent, _make_run_input(thread_id=""))

        provider.assert_called_once()
        assert "default" in agent._agents_by_thread

    @pytest.mark.asyncio
    async def test_provider_failure_does_not_cache_thread(self):
        """A failed provider must not cache the thread — the next request
        must re-invoke the provider so a transient failure can recover."""
        call_count = {"n": 0}

        def flaky_provider(_input_data):
            call_count["n"] += 1
            raise RuntimeError(f"failure #{call_count['n']}")

        agent = _make_base_agent(session_manager_provider=flaky_provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore"):
            await _collect_events(agent, _make_run_input(thread_id="retry-thread", run_id="r1"))
            assert "retry-thread" not in agent._agents_by_thread, (
                "thread must not be cached after provider failure"
            )
            await _collect_events(agent, _make_run_input(thread_id="retry-thread", run_id="r2"))

        assert call_count["n"] == 2, (
            f"provider must be re-invoked on the next request; got {call_count['n']} call(s)"
        )

    @pytest.mark.asyncio
    async def test_provider_returning_invalid_type_yields_error(self):
        """Provider returning a non-SessionManager instance yields RUN_ERROR
        with SESSION_MANAGER_INVALID_TYPE code, rather than silently passing
        garbage into Strands."""
        # Common footgun: provider returns the class instead of an instance.
        def bad_provider(_input_data):
            return "not-a-session-manager"

        agent = _make_base_agent(session_manager_provider=bad_provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            events = await _collect_events(agent, _make_run_input())

        MockCore.assert_not_called()
        error_event = next(e for e in events if e.type == EventType.RUN_ERROR)
        assert error_event.code == "SESSION_MANAGER_INVALID_TYPE"
        assert "str" in error_event.message  # the actual type is reported
        assert EventType.RUN_FINISHED not in [e.type for e in events]

    @pytest.mark.asyncio
    async def test_provider_returns_none_logs_warning(self, caplog):
        """Provider returning None logs a warning but continues the run."""
        import logging

        provider = MagicMock(return_value=None)
        agent = _make_base_agent(session_manager_provider=provider)

        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = _make_mock_instance()
            with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
                events = await _collect_events(agent, _make_run_input())

        event_types = [e.type for e in events]
        assert EventType.RUN_FINISHED in event_types
        assert any("returned None" in msg for msg in caplog.messages)

    @pytest.mark.asyncio
    async def test_session_manager_plain_turn_does_not_replay_history(self):
        """On a plain (non-frontend-tool) turn, a session manager owns history:
        the adapter must not clobber ``messages`` and just streams the user
        message. (Frontend-tool continuations are reconciled instead — see
        ``TestSessionFrontendToolReconciliation``.)"""
        mock_session_manager = _mock_session_manager()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)
        input_data = _make_run_input(
            messages=[UserMessage(id="u1", content="hello from user")]
        )

        instance = _MockStrandsAgentWithPrivateSessionManager(mock_session_manager)
        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = instance
            await _collect_events(agent, input_data)

        assert instance.stream_prompts == ["hello from user"]
        assert not hasattr(instance, "messages")


class _MockSessionAgentWithHistory:
    """Session-manager-backed mock that records ``stream_async`` prompts and
    exposes a native Strands ``messages`` history (as a real session manager
    would). Used for continuations with no non-empty frontend-tool result to
    reconcile, which take the legacy ``stream_async(user_message)`` path."""

    def __init__(self, session_manager, messages=None):
        self._session_manager = session_manager
        self.messages = messages if messages is not None else []
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.stream_prompts = []

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        return
        yield  # pragma: no cover


def _delta_continuation_input(tools):
    """A delta-only continuation payload: just the trailing ``tool`` result,
    with NO preceding assistant message carrying ``tool_calls`` (mirrors what
    CopilotKit sends after a void-handler frontend tool resolves)."""
    return RunAgentInput(
        thread_id="thread-delta",
        run_id="run-2",
        state={},
        messages=[
            ToolMessage(id="t1", role="tool", content="", tool_call_id="call-xyz"),
        ],
        tools=tools,
        context=[],
        forwarded_props={},
    )


def _frontend_tool(name: str) -> Tool:
    return Tool(name=name, description=f"{name} tool", parameters={})


class TestFrontendToolContinuation:
    """Regression tests for the 'Hello' injection on delta-only frontend-tool
    continuation runs (PR #1761)."""

    @pytest.mark.asyncio
    async def test_delta_only_continuation_does_not_inject_hello(self):
        """Session-manager path + delta-only trailing tool message + missing
        assistant tool_calls: ``stream_async`` must NOT receive ``"Hello"``,
        and must not guess an arbitrary frontend tool when several exist."""
        mock_session_manager = _mock_session_manager()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)

        # Multiple frontend tools — the old code would arbitrarily pick one.
        tools = [_frontend_tool("setBackground"), _frontend_tool("setForeground")]
        input_data = _delta_continuation_input(tools)

        # No session history that resolves call-xyz → name is unresolvable.
        instance = _MockSessionAgentWithHistory(mock_session_manager, messages=[])
        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = instance
            await _collect_events(agent, input_data)

        assert instance.stream_prompts == [""]
        assert "Hello" not in instance.stream_prompts
        # No arbitrary frontend tool name leaked into the prompt.
        assert not any(
            "executed successfully" in (p or "") for p in instance.stream_prompts
        )

    @pytest.mark.asyncio
    async def test_delta_only_continuation_resolves_name_from_session_history(self):
        """When the assistant ``tool_calls`` message is absent from the delta
        payload but present in the session's native history, the correct tool
        name is recovered (not an arbitrary one)."""
        mock_session_manager = _mock_session_manager()
        provider = MagicMock(return_value=mock_session_manager)
        agent = _make_base_agent(session_manager_provider=provider)

        tools = [_frontend_tool("setBackground"), _frontend_tool("setForeground")]
        input_data = _delta_continuation_input(tools)

        # Native Strands history holds the toolUse that owns call-xyz.
        session_history = [
            {"role": "user", "content": [{"text": "make it blue"}]},
            {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "call-xyz",
                            "name": "setBackground",
                            "input": {"color": "blue"},
                        }
                    }
                ],
            },
        ]
        instance = _MockSessionAgentWithHistory(
            mock_session_manager, messages=session_history
        )
        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = instance
            await _collect_events(agent, input_data)

        assert instance.stream_prompts == [
            "setBackground executed successfully with no return value."
        ]
        assert "Hello" not in instance.stream_prompts


class _MockSessionAgentReal:
    """Session-manager-backed mock exposing a real ``session_manager`` (public
    attribute, like ``StrandsAgentCore``) plus an ``agent_id`` and native
    ``messages``, so the frontend-tool reconciliation path can run against a
    real session repository."""

    def __init__(self, session_manager, agent_id="default", messages=None):
        self.session_manager = session_manager
        self.agent_id = agent_id
        self.messages = messages if messages is not None else []
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.stream_prompts = []

    async def stream_async(self, prompt):
        self.stream_prompts.append(prompt)
        return
        yield  # pragma: no cover


def _seed_session(sm, agent_id, messages):
    from strands.types.session import SessionAgent, SessionMessage

    sm.session_repository.create_agent(
        sm.session_id,
        SessionAgent(agent_id=agent_id, state={}, conversation_manager_state={}),
    )
    for index, message in enumerate(messages):
        sm.session_repository.create_message(
            sm.session_id, agent_id, SessionMessage(message=message, message_id=index)
        )


def _store_tool_use(native_id, name, tool_input=None):
    return {
        "role": "assistant",
        "content": [
            {"toolUse": {"toolUseId": native_id, "name": name, "input": tool_input or {}}}
        ],
    }


def _store_placeholder(native_id, text="Forwarded to client"):
    return {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": native_id,
                    "status": "success",
                    "content": [{"text": text}],
                }
            }
        ],
    }


def _payload_assistant(wire_id, name, args="{}"):
    return AssistantMessage(
        id="a-" + wire_id,
        role="assistant",
        content="",
        tool_calls=[
            ToolCall(
                id=wire_id,
                type="function",
                function=FunctionCall(name=name, arguments=args),
            )
        ],
    )


def _payload_tool(wire_id, content):
    return ToolMessage(id="t-" + wire_id, role="tool", content=content, tool_call_id=wire_id)


def _result_content(sm, agent_id, index):
    persisted = sm.session_repository.list_messages(sm.session_id, agent_id)
    return persisted[index].message["content"]


async def _run_session_continuation(sm, agent_id, messages, tools, wire_map, store):
    """Drive run() for a continuation and return the mock agent instance."""
    _seed_session(sm, agent_id, store)
    provider = MagicMock(return_value=sm)
    agent = _make_base_agent(session_manager_provider=provider)
    input_data = RunAgentInput(
        thread_id=sm.session_id,
        run_id="run-2",
        state={},
        messages=messages,
        tools=tools,
        context=[],
        forwarded_props={},
    )
    instance = _MockSessionAgentReal(
        sm, agent_id=agent_id, messages=copy.deepcopy(store)
    )
    # The wire->native map lives on the agent's session state (durable), set on
    # the prior emission run. Seed it directly to simulate that.
    if wire_map:
        instance.state.set(AG_UI_WIRE_MAP_STATE_KEY, dict(wire_map))
    with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
        MockCore.return_value = instance
        await _collect_events(agent, input_data)
    return instance


class _MockStreamingAgent:
    """Mock whose ``stream_async`` replays canned Strands events, exercising the
    real tool-call handling in ``run()`` (including wire->native map capture)."""

    def __init__(self, events, session_manager=None):
        self._events = events
        self.session_manager = session_manager
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.messages = []

    async def stream_async(self, *args, **kwargs):
        for event in self._events:
            yield event


class TestWireToNativeMapCapture:
    @pytest.mark.asyncio
    async def test_emission_populates_wire_to_native_map(self):
        # Driving a frontend tool-call event through run() must record the fresh
        # wire id -> Strands native toolUseId, which reconciliation later relies
        # on. (Primary resolution path's data source.) Capture is gated on a
        # session manager being configured.
        agent = _make_base_agent(
            session_manager_provider=MagicMock(return_value=_mock_session_manager())
        )
        input_data = RunAgentInput(
            thread_id="t-emit",
            run_id="r1",
            state={},
            messages=[UserMessage(id="u1", content="please approve")],
            tools=[_frontend_tool("approve")],
            context=[],
            forwarded_props={},
        )
        instance = _MockStreamingAgent(
            [{"current_tool_use": {"name": "approve", "toolUseId": "native-1", "input": {}}}],
            session_manager=_mock_session_manager(),
        )
        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = instance
            await _collect_events(agent, input_data)

        wire_map = instance.state.get(AG_UI_WIRE_MAP_STATE_KEY) or {}
        assert list(wire_map.values()) == ["native-1"]

    @pytest.mark.asyncio
    async def test_wire_map_is_size_capped(self, monkeypatch):
        # Abandoned frontend calls are never consumed/pruned, so the map is
        # bounded at emission: an emission over the cap drops the oldest entries.
        import ag_ui_strands.agent as agent_mod

        monkeypatch.setattr(agent_mod, "_WIRE_MAP_MAX", 2)
        agent = _make_base_agent(
            session_manager_provider=MagicMock(return_value=_mock_session_manager())
        )
        input_data = RunAgentInput(
            thread_id="t-cap",
            run_id="r1",
            state={},
            messages=[UserMessage(id="u1", content="approve")],
            tools=[_frontend_tool("approve")],
            context=[],
            forwarded_props={},
        )
        instance = _MockStreamingAgent(
            [{"current_tool_use": {"name": "approve", "toolUseId": "native-new", "input": {}}}],
            session_manager=_mock_session_manager(),
        )
        # Pre-seed a full map (oldest first).
        instance.state.set(AG_UI_WIRE_MAP_STATE_KEY, {"w-a": "n-a", "w-b": "n-b"})
        with patch("ag_ui_strands.agent.StrandsAgentCore") as MockCore:
            MockCore.return_value = instance
            await _collect_events(agent, input_data)

        wire_map = instance.state.get(AG_UI_WIRE_MAP_STATE_KEY) or {}
        assert len(wire_map) == 2
        assert "w-a" not in wire_map  # oldest evicted
        assert "native-new" in wire_map.values()


class TestSessionFrontendToolReconciliation:
    """Approach (B): on a session-manager continuation carrying a real frontend
    tool result, the persisted ``"Forwarded to client"`` placeholder is
    overwritten with the real result (found via the wire->native id map, since
    the client's wire id differs from Strands' native toolUseId) and the model
    continues from the corrected native history (``stream_async(None)``)."""

    @pytest.mark.asyncio
    async def test_reconciles_via_wire_to_native_map_delta_only(self, tmp_path):
        # Native id in the store differs from the client's wire id, and the
        # payload is delta-only (no assistant message) — only the wire->native
        # map can bridge them. This is the E1 regression: keying on the wire id
        # would match nothing and stream the uncorrected placeholder.
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-map", storage_dir=str(tmp_path))
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[_payload_tool("wire-1", '{"approved": false}')],
            tools=[_frontend_tool("approve")],
            wire_map={"wire-1": "native-1"},
            store=[_store_tool_use("native-1", "approve"), _store_placeholder("native-1")],
        )
        assert instance.stream_prompts == [None]
        assert _result_content(sm, "default", 1)[0]["toolResult"]["content"] == [
            {"text": '{"approved": false}'}
        ]

    @pytest.mark.asyncio
    async def test_no_wire_map_degrades_to_legacy(self, tmp_path):
        # No durable wire->native map for this result's wire id (e.g. a session
        # created before this feature): the wire id can't be resolved, so the
        # adapter degrades to the legacy synthetic-message path and leaves the
        # placeholder rather than streaming a stub.
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-nomap", storage_dir=str(tmp_path))
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[
                _payload_assistant("wire-2", "setColor", '{"color": "blue"}'),
                _payload_tool("wire-2", "ok"),
            ],
            tools=[_frontend_tool("setColor")],
            wire_map={},  # nothing recorded -> unresolvable
            store=[
                _store_tool_use("native-2", "setColor", {"color": "blue"}),
                _store_placeholder("native-2"),
            ],
        )
        assert instance.stream_prompts != [None]
        assert _result_content(sm, "default", 1)[0]["toolResult"]["content"] == [
            {"text": "Forwarded to client"}
        ]

    @pytest.mark.asyncio
    async def test_mixed_void_and_real_clears_both_placeholders(self, tmp_path):
        # A void call in the same turn as a real one: the void placeholder must
        # be cleared (to "") rather than left as the literal "Forwarded to
        # client" fed to the model.
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-mixed", storage_dir=str(tmp_path))
        store = [
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"toolUseId": "native-A", "name": "doThing", "input": {}}},
                    {"toolUse": {"toolUseId": "native-B", "name": "approve", "input": {}}},
                ],
            },
            {
                "role": "user",
                "content": [
                    _store_placeholder("native-A")["content"][0],
                    _store_placeholder("native-B")["content"][0],
                ],
            },
        ]
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[
                _payload_assistant("wire-A", "doThing"),
                _payload_assistant("wire-B", "approve"),
                _payload_tool("wire-A", ""),  # void
                _payload_tool("wire-B", '{"approved": true}'),  # real
            ],
            tools=[_frontend_tool("doThing"), _frontend_tool("approve")],
            wire_map={"wire-A": "native-A", "wire-B": "native-B"},
            store=store,
        )
        assert instance.stream_prompts == [None]
        results = _result_content(sm, "default", 1)
        assert results[0]["toolResult"]["content"] == [{"text": ""}]  # void cleared
        assert results[1]["toolResult"]["content"] == [{"text": '{"approved": true}'}]

    @pytest.mark.asyncio
    async def test_multi_turn_reconciles_only_the_trailing_result(self, tmp_path):
        # The client re-sends full history: two earlier identical approve() calls
        # (already reconciled, and whose wire->native entries were pruned) plus
        # the just-returned one. Only the trailing result may gate
        # reconciliation. This PINS trailing-scoping: without it, the historical
        # calls would be re-collected, fail to resolve (their entries are gone
        # from the durable map), and force the legacy fallback every turn.
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-multi", storage_dir=str(tmp_path))
        store = [
            _store_tool_use("native-o1", "approve", {}),
            _store_placeholder("native-o1", text="OLD1"),  # already corrected
            _store_tool_use("native-o2", "approve", {}),
            _store_placeholder("native-o2", text="OLD2"),  # already corrected
            _store_tool_use("native-new", "approve", {}),
            _store_placeholder("native-new"),  # this turn's placeholder
        ]
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[
                _payload_assistant("wire-o1", "approve", "{}"),
                _payload_tool("wire-o1", "OLD1"),
                _payload_assistant("wire-o2", "approve", "{}"),
                _payload_tool("wire-o2", "OLD2"),
                _payload_assistant("wire-new", "approve", "{}"),
                _payload_tool("wire-new", '{"approved": true}'),
            ],
            tools=[_frontend_tool("approve")],
            wire_map={"wire-new": "native-new"},  # historical entries already pruned
            store=store,
        )
        assert instance.stream_prompts == [None]
        results = sm.session_repository.list_messages(sm.session_id, "default")
        assert results[1].message["content"][0]["toolResult"]["content"] == [{"text": "OLD1"}]
        assert results[3].message["content"][0]["toolResult"]["content"] == [{"text": "OLD2"}]
        assert results[5].message["content"][0]["toolResult"]["content"] == [
            {"text": '{"approved": true}'}
        ]

    @pytest.mark.asyncio
    async def test_partially_resolvable_turn_falls_back_to_legacy(self, tmp_path):
        # Two frontend results in one turn, both recognized as frontend, but only
        # one resolves to a native id (wire-2 is not in the map and its
        # name+args match no stored toolUse). Streaming None would feed wire-2's
        # uncorrected placeholder to the model, so the adapter falls back.
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-partial", storage_dir=str(tmp_path))
        store = [
            _store_tool_use("native-1", "approve", {}),
            _store_placeholder("native-1"),
        ]
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[
                _payload_assistant("wire-1", "approve", "{}"),
                _payload_assistant("wire-2", "approve", '{"x": 1}'),  # no store match
                _payload_tool("wire-1", "R1"),
                _payload_tool("wire-2", "R2"),
            ],
            tools=[_frontend_tool("approve")],
            wire_map={"wire-1": "native-1"},  # wire-2 missing -> unresolvable
            store=store,
        )
        # Not all non-void results resolved -> legacy fallback: a single
        # synthetic user message (not None/empty). The resolvable result's store
        # placeholder is still corrected (partial correction is safe — the value
        # is real); only the model-facing continuation falls back.
        assert instance.stream_prompts == ["approve returned: R2"]
        assert _result_content(sm, "default", 1)[0]["toolResult"]["content"] == [
            {"text": "R1"}
        ]

    @pytest.mark.asyncio
    async def test_historical_void_placeholder_does_not_block_reconcile(self, tmp_path):
        # A prior void frontend call left a permanent placeholder in the store.
        # It must NOT block reconciling THIS turn's real result (the gate is
        # scoped to this turn's results, not the whole history).
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-histvoid", storage_dir=str(tmp_path))
        store = [
            _store_tool_use("native-void", "ping"),
            _store_placeholder("native-void"),  # old void call, never corrected
            _store_tool_use("native-new", "approve"),
            _store_placeholder("native-new"),
        ]
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[
                _payload_assistant("wire-new", "approve"),
                _payload_tool("wire-new", '{"approved": true}'),
            ],
            tools=[_frontend_tool("approve")],
            wire_map={"wire-new": "native-new"},
            store=store,
        )
        assert instance.stream_prompts == [None]
        results = sm.session_repository.list_messages(sm.session_id, "default")
        assert results[3].message["content"][0]["toolResult"]["content"] == [
            {"text": '{"approved": true}'}
        ]

    @pytest.mark.asyncio
    async def test_wire_to_native_map_pruned_after_reconcile(self, tmp_path):
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-prune", storage_dir=str(tmp_path))
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[
                _payload_assistant("wire-1", "approve"),
                _payload_tool("wire-1", '{"approved": true}'),
            ],
            tools=[_frontend_tool("approve")],
            wire_map={"wire-1": "native-1", "wire-other": "native-other"},
            store=[_store_tool_use("native-1", "approve"), _store_placeholder("native-1")],
        )

        # The corrected wire id is pruned from the durable state map; unrelated
        # outstanding entries are kept.
        remaining = instance.state.get(AG_UI_WIRE_MAP_STATE_KEY) or {}
        assert "wire-1" not in remaining
        assert remaining == {"wire-other": "native-other"}

    @pytest.mark.asyncio
    async def test_reconcile_failure_keeps_map_and_falls_back(self, tmp_path):
        # If reconciliation raises, the wire->native entry must NOT be pruned
        # (so a later turn can retry) and the run must degrade to the legacy
        # path rather than streaming an uncorrected stub.
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-reconfail", storage_dir=str(tmp_path))
        with patch(
            "ag_ui_strands.agent.reconcile_frontend_tool_results",
            side_effect=RuntimeError("boom"),
        ):
            instance = await _run_session_continuation(
                sm,
                "default",
                messages=[
                    _payload_assistant("wire-1", "approve"),
                    _payload_tool("wire-1", '{"approved": true}'),
                ],
                tools=[_frontend_tool("approve")],
                wire_map={"wire-1": "native-1"},
                store=[
                    _store_tool_use("native-1", "approve"),
                    _store_placeholder("native-1"),
                ],
            )

        assert instance.stream_prompts != [None]  # legacy fallback on error
        remaining = instance.state.get(AG_UI_WIRE_MAP_STATE_KEY) or {}
        assert remaining == {"wire-1": "native-1"}  # entry kept for retry

    @pytest.mark.asyncio
    async def test_unmapped_results_do_not_corrupt_store_and_fall_back(self, tmp_path):
        # Two same-turn calls with no durable wire->native entries: neither
        # resolves, so nothing is written (no corruption) and the turn degrades
        # to the legacy path.
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-collide", storage_dir=str(tmp_path))
        store = [
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"toolUseId": "native-1", "name": "approve", "input": {}}},
                    {"toolUse": {"toolUseId": "native-2", "name": "approve", "input": {}}},
                ],
            },
            {
                "role": "user",
                "content": [
                    _store_placeholder("native-1")["content"][0],
                    _store_placeholder("native-2")["content"][0],
                ],
            },
        ]
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[
                _payload_assistant("wire-1", "approve"),
                _payload_assistant("wire-2", "approve"),
                _payload_tool("wire-1", "R1"),
                _payload_tool("wire-2", "R2"),
            ],
            tools=[_frontend_tool("approve")],
            wire_map={},  # nothing recorded -> unresolvable
            store=store,
        )
        assert instance.stream_prompts != [None]  # unresolvable -> legacy
        results = sm.session_repository.list_messages(sm.session_id, "default")[1].message[
            "content"
        ]
        # Neither placeholder was overwritten with the wrong result.
        assert results[0]["toolResult"]["content"] == [{"text": "Forwarded to client"}]
        assert results[1]["toolResult"]["content"] == [{"text": "Forwarded to client"}]

    @pytest.mark.asyncio
    async def test_already_reconciled_result_streams_none_idempotently(self, tmp_path):
        # The result resolves to a native id whose stored toolResult is already a
        # real value (not the placeholder). There is nothing to correct and no
        # placeholder remains, so streaming the clean native history is safe; the
        # idempotency guard leaves the stored value untouched (first result wins).
        from strands.session.file_session_manager import FileSessionManager

        sm = FileSessionManager(session_id="thread-idem", storage_dir=str(tmp_path))
        instance = await _run_session_continuation(
            sm,
            "default",
            messages=[
                _payload_assistant("wire-Z", "approve"),
                _payload_tool("wire-Z", '{"approved": false}'),
            ],
            tools=[_frontend_tool("approve")],
            wire_map={"wire-Z": "native-Z"},
            store=[
                _store_tool_use("native-Z", "approve"),
                _store_placeholder("native-Z", text="already real"),
            ],
        )
        assert instance.stream_prompts == [None]
        assert _result_content(sm, "default", 1)[0]["toolResult"]["content"] == [
            {"text": "already real"}
        ]

"""Tests for ToolBehavior.tool_stream_event_handler in StrandsAgent.

Covers:
  1. Happy path — events yielded by the handler are forwarded into the stream.
  2. Handler raises — warning is logged, stream continues without crashing.
  3. No handler + {"state": ...} payload — default StateSnapshotEvent is emitted.
  4. No handler + non-state payload — nothing extra emitted, no crash.
  5. Missing toolUseId — handler is NOT called, stream continues cleanly.
  6. Context fields — ToolStreamEventContext carries correct tool_use_id,
     tool_name, and stream_data values.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock

import pytest
from ag_ui.core import EventType, StateSnapshotEvent
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior, ToolStreamEventContext


# ---------------------------------------------------------------------------
# Shared helpers (mirrors the pattern in test_parallel_tool_call_handling.py)
# ---------------------------------------------------------------------------


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent(
    stream_events: list,
    config: StrandsAgentConfig | None = None,
    thread_id: str = "test-thread",
) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=config or StrandsAgentConfig()
    )

    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner._interrupt_state = None

    async def _stream(_msg: str):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _make_input(thread_id: str = "test-thread"):
    inp = MagicMock()
    inp.thread_id = thread_id
    inp.run_id = "test-run"
    inp.state = {}
    inp.messages = []
    inp.tools = []
    return inp


def _tool_stream_event(
    tool_name: str,
    tool_use_id: str | None,
    data: object,
) -> dict:
    """Build a Strands tool_stream_event dict."""
    tool_use = {"name": tool_name}
    if tool_use_id is not None:
        tool_use["toolUseId"] = tool_use_id
    return {"tool_stream_event": {"tool_use": tool_use, "data": data}}


# ---------------------------------------------------------------------------
# 1. Happy path — handler events are forwarded
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handler_events_forwarded():
    """Events yielded by tool_stream_event_handler appear in the output stream."""
    from ag_ui.core import CustomEvent

    captured_ctx: list[ToolStreamEventContext] = []

    async def my_handler(ctx: ToolStreamEventContext):
        captured_ctx.append(ctx)
        yield CustomEvent(type=EventType.CUSTOM, name="SubAgentProgress", value={"pct": 50})
        yield CustomEvent(type=EventType.CUSTOM, name="SubAgentProgress", value={"pct": 100})

    config = StrandsAgentConfig(
        tool_behaviors={
            "sub_agent": ToolBehavior(tool_stream_event_handler=my_handler)
        }
    )

    stream_events = [
        _tool_stream_event("sub_agent", "tool-id-1", {"progress": 50}),
        {"complete": True},
    ]

    agent = _build_agent(stream_events, config)
    events = [e async for e in agent.run(_make_input())]

    custom = [e for e in events if e.type == EventType.CUSTOM and e.name == "SubAgentProgress"]
    assert len(custom) == 2
    assert custom[0].value == {"pct": 50}
    assert custom[1].value == {"pct": 100}


# ---------------------------------------------------------------------------
# 2. Handler raises — warning logged, stream continues
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handler_exception_logged_stream_continues(caplog):
    """A raising handler logs a warning and does not crash the run."""

    async def bad_handler(ctx: ToolStreamEventContext):
        raise RuntimeError("handler exploded")
        yield  # make it an async generator

    config = StrandsAgentConfig(
        tool_behaviors={
            "sub_agent": ToolBehavior(tool_stream_event_handler=bad_handler)
        }
    )

    stream_events = [
        _tool_stream_event("sub_agent", "tool-id-1", {"x": 1}),
        {"data": "All good after the error."},
        {"complete": True},
    ]

    agent = _build_agent(stream_events, config)

    with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
        events = [e async for e in agent.run(_make_input())]

    # Run must finish cleanly
    assert any(e.type == EventType.RUN_FINISHED for e in events)

    # Warning must mention the tool name
    assert any("sub_agent" in r.message for r in caplog.records if r.levelno == logging.WARNING)

    # Text from after the error must still arrive
    assert any(
        e.type == EventType.TEXT_MESSAGE_CONTENT and "All good" in e.delta
        for e in events
    )


# ---------------------------------------------------------------------------
# 3. No handler + {"state": ...} payload → default StateSnapshotEvent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_default_state_snapshot_emitted_when_no_handler():
    """Without a handler the default path emits StateSnapshotEvent for state payloads."""
    stream_events = [
        _tool_stream_event("some_tool", "tool-id-1", {"state": {"counter": 7}}),
        {"complete": True},
    ]

    agent = _build_agent(stream_events)  # no config → no handler
    events = [e async for e in agent.run(_make_input())]

    snapshots = [e for e in events if e.type == EventType.STATE_SNAPSHOT]
    # At least one snapshot must carry the tool-streamed state
    tool_snapshots = [s for s in snapshots if s.snapshot == {"counter": 7}]
    assert len(tool_snapshots) == 1


# ---------------------------------------------------------------------------
# 4. No handler + non-state payload → no extra events, no crash
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_handler_non_state_payload_no_crash():
    """Non-state payloads without a handler are silently ignored."""
    stream_events = [
        _tool_stream_event("some_tool", "tool-id-1", {"progress": 42}),
        {"complete": True},
    ]

    agent = _build_agent(stream_events)
    events = [e async for e in agent.run(_make_input())]

    # Run must finish cleanly
    assert any(e.type == EventType.RUN_FINISHED for e in events)

    # No spurious state snapshots from the non-state payload
    tool_snapshots = [
        e for e in events
        if e.type == EventType.STATE_SNAPSHOT and e.snapshot == {"progress": 42}
    ]
    assert len(tool_snapshots) == 0


# ---------------------------------------------------------------------------
# 5. Missing toolUseId → handler NOT called, stream continues
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_tool_use_id_handler_not_called():
    """When toolUseId is absent the handler is skipped and the run finishes cleanly."""
    handler_called = []

    async def my_handler(ctx: ToolStreamEventContext):
        handler_called.append(ctx)
        yield  # pragma: no cover

    config = StrandsAgentConfig(
        tool_behaviors={
            "sub_agent": ToolBehavior(tool_stream_event_handler=my_handler)
        }
    )

    # Build event without toolUseId
    stream_events = [
        _tool_stream_event("sub_agent", None, {"x": 1}),
        {"complete": True},
    ]

    agent = _build_agent(stream_events, config)
    events = [e async for e in agent.run(_make_input())]

    assert handler_called == [], "handler must not be called when toolUseId is missing"
    assert any(e.type == EventType.RUN_FINISHED for e in events)


# ---------------------------------------------------------------------------
# 6. Context fields are populated correctly
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_context_fields_populated():
    """ToolStreamEventContext carries the correct tool_use_id, tool_name, stream_data."""
    captured: list[ToolStreamEventContext] = []

    async def capturing_handler(ctx: ToolStreamEventContext):
        captured.append(ctx)
        return
        yield  # make it an async generator

    config = StrandsAgentConfig(
        tool_behaviors={
            "my_tool": ToolBehavior(tool_stream_event_handler=capturing_handler)
        }
    )

    payload = {"key": "value", "nested": [1, 2, 3]}
    stream_events = [
        _tool_stream_event("my_tool", "abc-123", payload),
        {"complete": True},
    ]

    agent = _build_agent(stream_events, config)
    await agent.run(_make_input()).__anext__()  # prime the generator
    # Collect all events to drive the generator to completion
    events = [e async for e in agent.run(_make_input())]

    assert len(captured) == 1
    ctx = captured[0]
    assert ctx.tool_use_id == "abc-123"
    assert ctx.tool_name == "my_tool"
    assert ctx.stream_data == payload


# ---------------------------------------------------------------------------
# 7. Handler yielding None values — None items are filtered out
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handler_none_values_filtered():
    """None values yielded by the handler are not forwarded into the event stream."""
    from ag_ui.core import CustomEvent

    async def handler_with_nones(ctx: ToolStreamEventContext):
        yield None
        yield CustomEvent(type=EventType.CUSTOM, name="Real", value={})
        yield None

    config = StrandsAgentConfig(
        tool_behaviors={
            "sub_agent": ToolBehavior(tool_stream_event_handler=handler_with_nones)
        }
    )

    stream_events = [
        _tool_stream_event("sub_agent", "tool-id-1", {}),
        {"complete": True},
    ]

    agent = _build_agent(stream_events, config)
    events = [e async for e in agent.run(_make_input())]

    custom = [e for e in events if e.type == EventType.CUSTOM and e.name == "Real"]
    assert len(custom) == 1

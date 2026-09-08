"""Tests for ``ToolCallStartEvent.parent_message_id`` in Strands.

Issue #1610 originally found a phantom parent id in streams without a visible
tool-call assistant message. Current main emits ``MessagesSnapshotEvent`` by
default, so the tool-call assistant id is visible through the snapshot and must
stay aligned with #1638's snapshot contract. These tests pin both modes.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from ag_ui.core import AssistantMessage, EventType, RunAgentInput, Tool, UserMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent(
    thread_id: str,
    stream_events: list,
    config: StrandsAgentConfig | None = None,
) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(),
        name="test-agent",
        config=config or StrandsAgentConfig(),
    )
    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.session_manager = None

    async def _stream(_msg):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


def _run_input(thread_id: str, tools: list | None = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", content="hello")],
        tools=tools or [],
        context=[],
        forwarded_props={},
    )


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


def _tool_start(events: list, tool_call_id: str | None = None):
    return next(
        e
        for e in events
        if e.type == EventType.TOOL_CALL_START
        and (tool_call_id is None or e.tool_call_id == tool_call_id)
    )


def _snapshot_assistant_id_for_tool(events: list, tool_call_id: str) -> str:
    snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
    assert snapshots, "expected a MessagesSnapshotEvent"

    for message in snapshots[-1].messages:
        if isinstance(message, AssistantMessage) and message.tool_calls:
            if any(tool_call.id == tool_call_id for tool_call in message.tool_calls):
                return message.id

    raise AssertionError(f"tool call {tool_call_id!r} missing from final snapshot")


async def _args_streamer(context):
    yield context.args_str


THREAD = "parent-msg-id-thread"
TOOLS = [Tool(name="frontend_tool", description="d", parameters={})]
STREAM_TEXT_THEN_TOOL = [
    {"data": "Let me check those tables:"},
    {
        "current_tool_use": {
            "name": "frontend_tool",
            "toolUseId": "st-1",
            "input": {"ok": True},
        }
    },
    {"event": {"contentBlockStop": {}}},
]


async def test_default_parent_id_matches_tool_call_snapshot_message_id():
    agent = _build_agent(THREAD + "-default", STREAM_TEXT_THEN_TOOL)
    events = await _collect(agent, _run_input(THREAD + "-default", tools=TOOLS))

    text_end = next(e for e in events if e.type == EventType.TEXT_MESSAGE_END)
    tool_start = _tool_start(events)
    snapshot_id = _snapshot_assistant_id_for_tool(events, tool_start.tool_call_id)

    assert tool_start.parent_message_id == snapshot_id
    assert tool_start.parent_message_id != text_end.message_id


async def test_default_args_streamer_parent_id_matches_snapshot_message_id():
    config = StrandsAgentConfig(
        tool_behaviors={
            "frontend_tool": ToolBehavior(args_streamer=_args_streamer),
        },
    )
    agent = _build_agent(THREAD + "-args-default", STREAM_TEXT_THEN_TOOL, config)
    events = await _collect(
        agent,
        _run_input(THREAD + "-args-default", tools=TOOLS),
    )

    tool_start = _tool_start(events)
    snapshot_id = _snapshot_assistant_id_for_tool(events, tool_start.tool_call_id)

    assert tool_start.parent_message_id == snapshot_id


async def test_snapshot_disabled_parent_id_uses_preceding_text_message():
    config = StrandsAgentConfig(emit_messages_snapshot=False)
    agent = _build_agent(THREAD + "-disabled", STREAM_TEXT_THEN_TOOL, config)
    events = await _collect(agent, _run_input(THREAD + "-disabled", tools=TOOLS))

    text_end = next(e for e in events if e.type == EventType.TEXT_MESSAGE_END)
    tool_start = _tool_start(events)

    assert [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT] == []
    assert tool_start.parent_message_id == text_end.message_id


async def test_snapshot_disabled_tool_first_call_has_no_parent_id():
    config = StrandsAgentConfig(emit_messages_snapshot=False)
    stream = [
        {
            "current_tool_use": {
                "name": "frontend_tool",
                "toolUseId": "st-1",
                "input": {},
            }
        },
        {"event": {"contentBlockStop": {}}},
    ]
    agent = _build_agent(THREAD + "-tool-first", stream, config)
    events = await _collect(agent, _run_input(THREAD + "-tool-first", tools=TOOLS))

    assert [e for e in events if e.type == EventType.TEXT_MESSAGE_START] == []
    assert _tool_start(events).parent_message_id is None


async def test_snapshot_disabled_back_to_back_tool_calls_share_text_parent():
    config = StrandsAgentConfig(emit_messages_snapshot=False)
    stream = [
        {"data": "Calling two tools:"},
        {
            "current_tool_use": {
                "name": "backend_tool",
                "toolUseId": "st-a",
                "input": {},
            }
        },
        {"event": {"contentBlockStop": {}}},
        {
            "current_tool_use": {
                "name": "backend_tool",
                "toolUseId": "st-b",
                "input": {},
            }
        },
        {"event": {"contentBlockStop": {}}},
    ]
    agent = _build_agent(THREAD + "-back-to-back", stream, config)
    events = await _collect(agent, _run_input(THREAD + "-back-to-back"))

    text_end = next(e for e in events if e.type == EventType.TEXT_MESSAGE_END)
    tool_starts = [e for e in events if e.type == EventType.TOOL_CALL_START]

    assert len(tool_starts) == 2
    assert [e.parent_message_id for e in tool_starts] == [
        text_end.message_id,
        text_end.message_id,
    ]


async def test_snapshot_disabled_args_streamer_uses_preceding_text_parent():
    config = StrandsAgentConfig(
        emit_messages_snapshot=False,
        tool_behaviors={
            "frontend_tool": ToolBehavior(args_streamer=_args_streamer),
        },
    )
    agent = _build_agent(THREAD + "-args-disabled", STREAM_TEXT_THEN_TOOL, config)
    events = await _collect(
        agent,
        _run_input(THREAD + "-args-disabled", tools=TOOLS),
    )

    text_end = next(e for e in events if e.type == EventType.TEXT_MESSAGE_END)
    tool_start = _tool_start(events)

    assert [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT] == []
    assert tool_start.parent_message_id == text_end.message_id


async def test_skip_messages_snapshot_uses_visible_text_parent():
    config = StrandsAgentConfig(
        tool_behaviors={
            "frontend_tool": ToolBehavior(skip_messages_snapshot=True),
        },
    )
    agent = _build_agent(THREAD + "-skip", STREAM_TEXT_THEN_TOOL, config)
    events = await _collect(agent, _run_input(THREAD + "-skip", tools=TOOLS))

    text_end = next(e for e in events if e.type == EventType.TEXT_MESSAGE_END)
    tool_start = _tool_start(events)
    snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]

    assert tool_start.parent_message_id == text_end.message_id
    assert snapshots
    for message in snapshots[-1].messages:
        assert not (
            isinstance(message, AssistantMessage)
            and message.tool_calls
            and any(
                tool_call.id == tool_start.tool_call_id
                for tool_call in message.tool_calls
            )
        )

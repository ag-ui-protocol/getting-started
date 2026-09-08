"""Verify compact, Unicode-preserving output at every JSON wire site.

The fixture covers separator and string-escaping behavior shared with the
TypeScript adapter's ``JSON.stringify``. Numeric spelling remains Python-native
and is outside this parity fixture.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from ag_ui.core import EventType, RunAgentInput, Tool, UserMessage
from strands.tools.registry import ToolRegistry

from ag_ui_strands.a2ui_tool import _tool_result_text
from ag_ui_strands.agent import (
    StrandsAgent,
    _forward_inner_agent_events,
    _serialize_tool_result_data,
)
from tests.json_wire_fixture import (
    PARITY_JSON,
    PARITY_JSON_PYTHON_DEFAULT,
    PARITY_VALUE,
)


def test_the_fixture_covers_the_normalized_axes():
    assert PARITY_JSON != PARITY_JSON_PYTHON_DEFAULT
    assert json.loads(PARITY_JSON) == PARITY_VALUE


# ---------------------------------------------------------------------------
# Sites reachable as plain functions
# ---------------------------------------------------------------------------


def test_a2ui_detection_text_from_a_json_result_block():
    assert _tool_result_text([{"json": PARITY_VALUE}]) == PARITY_JSON


def test_backend_tool_result_content():
    assert _serialize_tool_result_data(PARITY_VALUE) == PARITY_JSON


async def _forwarded(inner_event, seen) -> list:
    return [
        event
        async for event in _forward_inner_agent_events(
            inner_event, {"toolUseId": "parent-1"}, seen
        )
    ]


@pytest.mark.asyncio
async def test_sub_agent_tool_call_arguments():
    events = await _forwarded(
        {
            "current_tool_use": {
                "toolUseId": "inner-1",
                "name": "lookup",
                "input": PARITY_VALUE,
            }
        },
        {},
    )

    args = [e for e in events if e.type == EventType.TOOL_CALL_ARGS]
    assert [e.delta for e in args] == [PARITY_JSON]


@pytest.mark.asyncio
async def test_sub_agent_tool_result_content():
    seen: dict = {}
    await _forwarded(
        {
            "current_tool_use": {
                "toolUseId": "inner-1",
                "name": "lookup",
                "input": "{}",
            }
        },
        seen,
    )

    events = await _forwarded(
        {
            "message": {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "inner-1",
                            "content": [{"text": PARITY_JSON_PYTHON_DEFAULT}],
                        }
                    }
                ],
            }
        },
        seen,
    )

    results = [e for e in events if e.type == EventType.TOOL_CALL_RESULT]
    assert [e.content for e in results] == [PARITY_JSON]


# ---------------------------------------------------------------------------
# Sites inside the run loop, driven through a scripted Strands stream
# ---------------------------------------------------------------------------


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


async def _run_with_tool_input(thread_id: str, tool_input) -> list:
    """Stream one frontend tool call whose ``input`` is *tool_input*."""
    adapter = StrandsAgent(_template_agent(), name="wire-parity")

    core = MagicMock()
    core.tool_registry = ToolRegistry()
    stream = [
        {
            "current_tool_use": {
                "name": "render",
                "toolUseId": "st-1",
                "input": tool_input,
            }
        },
        {"event": {"contentBlockStop": {}}},
    ]

    async def _stream(_message: str):
        for event in stream:
            yield event

    core.stream_async = _stream
    adapter._agents_by_thread[thread_id] = core

    input_data = RunAgentInput(
        thread_id=thread_id,
        run_id="r-1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="render")],
        tools=[Tool(name="render", description="render", parameters={})],
        context=[],
        forwarded_props={},
    )
    return [event async for event in adapter.run(input_data)]


@pytest.mark.asyncio
async def test_streamed_tool_call_argument_deltas():
    """A provider that hands the adapter a dict rather than a JSON string.

    The delta stream is what the frontend incrementally parses for
    predict_state, so it is serialized on the same terms as everything else.
    """
    events = await _run_with_tool_input("wire-parity-deltas", PARITY_VALUE)

    deltas = [
        event.delta for event in events if event.type == EventType.TOOL_CALL_ARGS
    ]
    assert "".join(deltas) == PARITY_JSON


@pytest.mark.asyncio
async def test_tool_call_arguments_in_the_messages_snapshot():
    """The snapshot re-serializes the parsed input rather than forwarding it."""
    events = await _run_with_tool_input(
        "wire-parity-snapshot", PARITY_JSON_PYTHON_DEFAULT
    )

    arguments = [
        call.function.arguments
        for event in events
        if event.type == EventType.MESSAGES_SNAPSHOT
        for message in event.messages
        for call in (getattr(message, "tool_calls", None) or [])
    ]
    assert arguments and set(arguments) == {PARITY_JSON}

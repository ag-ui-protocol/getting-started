"""Where a tool call's MESSAGES_SNAPSHOT sits on the wire.

A tool call's snapshot follows its own TOOL_CALL_END. On the backend path the
two go out together, one snapshot per call. On the frontend path the end is
deferred until this turn's backend results have been emitted, and the deferred
batch is closed by a SINGLE snapshot after the last flushed end: the append
into the running snapshot is eager, so one full-state snapshot carries exactly
what a per-call snapshot would have repeated byte for byte.

That eagerness is also what the deferral does not buy. In a mixed
frontend-plus-backend turn the backend result's snapshot already carries the
frontend tool call before that call's deferred end goes out.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    MessagesSnapshotEvent,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolCallEndEvent,
    UserMessage,
)
from strands import Agent
from strands.models.model import Model
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent

_TOOL_ARGS = '{"cell": "B4"}'


# ---------------------------------------------------------------------------
# The ordering claim, as a predicate over events
# ---------------------------------------------------------------------------


def _snapshot_lists_call(snapshot, tool_call_id: str) -> bool:
    return any(
        call.id == tool_call_id
        for message in snapshot.messages
        for call in (getattr(message, "tool_calls", None) or [])
    )


def snapshot_follows_every_tool_call_end(events: list) -> bool:
    """Does every TOOL_CALL_END have a later snapshot that lists its call?

    Written as a predicate over a list rather than as an assertion helper:
    positional pairing would accept one call's snapshot standing in for
    another's, and a helper that only looks forward from an end can never be
    shown to reject anything. The counterexamples below construct inputs it
    has to return False for.
    """
    for index, event in enumerate(events):
        if event.type != EventType.TOOL_CALL_END:
            continue
        if not any(
            later.type == EventType.MESSAGES_SNAPSHOT
            and _snapshot_lists_call(later, event.tool_call_id)
            for later in events[index + 1 :]
        ):
            return False
    return True


def _end(tool_call_id: str) -> ToolCallEndEvent:
    return ToolCallEndEvent(
        type=EventType.TOOL_CALL_END, tool_call_id=tool_call_id
    )


def _snapshot(*tool_call_ids: str) -> MessagesSnapshotEvent:
    return MessagesSnapshotEvent(
        type=EventType.MESSAGES_SNAPSHOT,
        messages=[
            AssistantMessage(
                id=f"a-{tool_call_id}",
                role="assistant",
                content="",
                tool_calls=[
                    ToolCall(
                        id=tool_call_id,
                        type="function",
                        function=FunctionCall(name="t", arguments="{}"),
                    )
                ],
            )
            for tool_call_id in tool_call_ids
        ],
    )


def test_ordering_holds_when_the_snapshot_follows_the_end():
    assert snapshot_follows_every_tool_call_end([_end("a"), _snapshot("a")])


def test_ordering_holds_when_one_batch_snapshot_closes_several_ends():
    assert snapshot_follows_every_tool_call_end(
        [_end("a"), _end("b"), _snapshot("a", "b")]
    )


def test_ordering_is_violated_when_the_snapshot_precedes_the_end():
    assert not snapshot_follows_every_tool_call_end([_snapshot("a"), _end("a")])


def test_ordering_is_violated_when_the_later_snapshot_omits_the_call():
    assert not snapshot_follows_every_tool_call_end([_end("a"), _snapshot("b")])


# ---------------------------------------------------------------------------
# Driving the adapter
# ---------------------------------------------------------------------------


class _ScriptedToolUse(Model):
    """Turn 1 emits the scripted tool-use blocks; later turns narrate and stop."""

    def __init__(self, blocks: list[tuple[str, str, str]]) -> None:
        self.blocks = blocks
        self.calls = 0

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt=None, **kwargs):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        yield {"messageStart": {"role": "assistant"}}
        if self.calls == 1:
            for tool_use_id, name, args in self.blocks:
                yield {
                    "contentBlockStart": {
                        "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}
                    }
                }
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": args}}}}
                yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


def _cell_tool(name: str) -> Tool:
    return Tool(
        name=name,
        description="Read a cell",
        parameters={
            "type": "object",
            "properties": {"cell": {"type": "string"}},
            "required": ["cell"],
        },
    )


def _server_tool(name: str):
    from strands.tools.decorator import tool

    @tool(name=name)
    def _run_on_server(cell: str) -> dict:
        """Read a cell."""
        return {"cell": cell, "value": 7}

    return _run_on_server


async def _run(
    thread_id: str,
    *,
    blocks: list[tuple[str, str, str]],
    server_tool_names: tuple[str, ...],
    client_tool_names: tuple[str, ...],
) -> list:
    """Drive one turn of the scripted model through the adapter."""
    core = Agent(
        model=_ScriptedToolUse(blocks),
        tools=[_server_tool(name) for name in server_tool_names],
    )
    adapter = StrandsAgent(core, name="snapshot-order")
    input_data = RunAgentInput(
        thread_id=thread_id,
        run_id="r-1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="read B4")],
        tools=[_cell_tool(name) for name in client_tool_names],
        context=[],
        forwarded_props={},
    )

    async def drive():
        return [event async for event in adapter.run(input_data)]

    return await asyncio.wait_for(drive(), timeout=30)


async def _run_one_call(thread_id: str, *, frontend: bool) -> list:
    """One ``get_cell`` call, executing on the client or on the server."""
    return await _run(
        thread_id,
        blocks=[("native-1", "get_cell", _TOOL_ARGS)],
        server_tool_names=() if frontend else ("get_cell",),
        client_tool_names=("get_cell",) if frontend else (),
    )


def _index_of_end(events: list, tool_call_id: str) -> int:
    for index, event in enumerate(events):
        if (
            event.type == EventType.TOOL_CALL_END
            and event.tool_call_id == tool_call_id
        ):
            return index
    raise AssertionError(f"no TOOL_CALL_END for {tool_call_id}")


@pytest.mark.asyncio
@pytest.mark.parametrize("frontend", [False, True], ids=["backend", "frontend"])
async def test_tool_call_snapshot_follows_its_tool_call_end(frontend: bool):
    events = await _run_one_call(f"snapshot-order-{frontend}", frontend=frontend)

    assert snapshot_follows_every_tool_call_end(events)


@pytest.mark.asyncio
async def test_one_snapshot_closes_the_whole_deferred_batch():
    """Two frontend calls in one turn: both ends, then one snapshot for both."""
    events = await _run(
        "snapshot-two-frontend",
        blocks=[
            ("native-1", "pick_a", '{"cell": "A1"}'),
            ("native-2", "pick_b", '{"cell": "B2"}'),
        ],
        server_tool_names=(),
        client_tool_names=("pick_a", "pick_b"),
    )

    assert snapshot_follows_every_tool_call_end(events)

    # Both ends are deferred to the end of the turn, after both starts.
    starts = [
        index
        for index, event in enumerate(events)
        if event.type == EventType.TOOL_CALL_START
    ]
    first_end = _index_of_end(events, "native-1")
    last_end = _index_of_end(events, "native-2")
    assert max(starts) < first_end

    # One snapshot for the batch, not one per deferred call: nothing between
    # the two ends, one after the last of them.
    trailing = [
        (index, event)
        for index, event in enumerate(events)
        if index > first_end and event.type == EventType.MESSAGES_SNAPSHOT
    ]
    assert len(trailing) == 1
    index, snapshot = trailing[0]
    assert index > last_end
    assert _snapshot_lists_call(snapshot, "native-1")
    assert _snapshot_lists_call(snapshot, "native-2")


@pytest.mark.asyncio
async def test_no_two_snapshots_in_a_turn_are_byte_identical():
    events = await _run(
        "snapshot-no-duplicates",
        blocks=[
            ("native-1", "pick_a", '{"cell": "A1"}'),
            ("native-2", "pick_b", '{"cell": "B2"}'),
        ],
        server_tool_names=(),
        client_tool_names=("pick_a", "pick_b"),
    )

    payloads = [
        event.model_dump_json()
        for event in events
        if event.type == EventType.MESSAGES_SNAPSHOT
    ]
    assert len(payloads) == len(set(payloads)), "duplicate MESSAGES_SNAPSHOT payloads"


@pytest.mark.asyncio
async def test_mixed_turn_defers_the_frontend_end_past_the_backend_result():
    """The deferral holds in a mixed turn, and what it does not buy.

    The frontend end still lands after the backend TOOL_CALL_RESULT. What it
    does not get is exclusivity: the append into history is eager, so the
    backend result's snapshot already carries the frontend tool call before
    that call's end goes out.
    """
    events = await _run(
        "snapshot-mixed",
        blocks=[
            ("native-1", "read_cell", '{"cell": "A1"}'),
            ("native-2", "pick_b", '{"cell": "B2"}'),
        ],
        server_tool_names=("read_cell",),
        client_tool_names=("pick_b",),
    )

    result_index = next(
        index
        for index, event in enumerate(events)
        if event.type == EventType.TOOL_CALL_RESULT
        and event.tool_call_id == "native-1"
    )
    frontend_end_index = _index_of_end(events, "native-2")
    assert result_index < frontend_end_index
    assert snapshot_follows_every_tool_call_end(events)

    # The eager append: a snapshot between the backend result and the deferred
    # end already lists the frontend call.
    early = [
        event
        for index, event in enumerate(events)
        if result_index < index < frontend_end_index
        and event.type == EventType.MESSAGES_SNAPSHOT
        and _snapshot_lists_call(event, "native-2")
    ]
    assert early, "expected the backend result's snapshot to carry the frontend call"


# ---------------------------------------------------------------------------
# The safety flush: a stream that ends with no backend tool-result message
# ---------------------------------------------------------------------------


def _mock_core_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


@pytest.mark.asyncio
async def test_deferred_batch_is_flushed_when_no_tool_result_message_arrives():
    """A frontend-only turn whose stream stops after the tool-use blocks.

    Strands normally follows a tool batch with a user-role message carrying the
    results, and the per-batch flush rides on that message. When the stream
    simply ends instead, the buffered ends and the snapshot they owe are
    flushed on the way out rather than lost.
    """
    thread_id = "snapshot-safety-flush"
    adapter = StrandsAgent(_mock_core_agent(), name="safety-flush")

    core = MagicMock()
    core.tool_registry = ToolRegistry()
    stream = [
        {"current_tool_use": {"name": "pick_a", "toolUseId": "st-a", "input": {}}},
        {"current_tool_use": {"name": "pick_b", "toolUseId": "st-b", "input": {}}},
        {"event": {"contentBlockStop": {}}},
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
        messages=[UserMessage(id="u1", role="user", content="pick")],
        tools=[
            Tool(name="pick_a", description="a", parameters={}),
            Tool(name="pick_b", description="b", parameters={}),
        ],
        context=[],
        forwarded_props={},
    )
    events = [event async for event in adapter.run(input_data)]

    assert not any(
        event.type == EventType.TOOL_CALL_RESULT for event in events
    ), "this scenario must not produce a tool-result message"

    starts = {
        event.tool_call_id
        for event in events
        if event.type == EventType.TOOL_CALL_START
    }
    ends = {
        event.tool_call_id
        for event in events
        if event.type == EventType.TOOL_CALL_END
    }
    assert starts == ends and len(ends) == 2
    assert snapshot_follows_every_tool_call_end(events)

    first_end = min(
        index
        for index, event in enumerate(events)
        if event.type == EventType.TOOL_CALL_END
    )
    last_end = max(
        index
        for index, event in enumerate(events)
        if event.type == EventType.TOOL_CALL_END
    )
    trailing = [
        index
        for index, event in enumerate(events)
        if index > first_end and event.type == EventType.MESSAGES_SNAPSHOT
    ]
    assert trailing == [index for index in trailing if index > last_end]
    assert len(trailing) == 1

"""Streaming and event emission: ``copilotkit_stream`` reassembly, the
per-delta chunk events, ``copilotkit_predict_state``/``copilotkit_emit_state``,
and the endpoint listener's translation of bridged events to wire events.
No network."""

from types import SimpleNamespace

import pytest

from ag_ui.core import EventType
from ag_ui_crewai import endpoint as ep
from ag_ui_crewai.context import flow_context
from ag_ui_crewai.events import (
    BridgedTextMessageChunkEvent,
    BridgedToolCallChunkEvent,
)
from litellm import CustomStreamWrapper

from ag_ui_crewai.sdk import (
    copilotkit_emit_state,
    copilotkit_predict_state,
    copilotkit_stream,
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _stream_chunk(chunk_id, *, content=None, tool_calls=None, finish_reason=None):
    """A LiteLLM-shaped streaming chunk (tool-call entries are attribute-style)."""
    return {
        "id": chunk_id,
        "created": 1700000000,
        "model": "gpt-4o",
        "system_fingerprint": "fp_test",
        "choices": [
            {
                "delta": {"content": content, "tool_calls": tool_calls},
                "finish_reason": finish_reason,
            }
        ],
    }


def _tool_call_delta(*, call_id, name, arguments):
    return SimpleNamespace(id=call_id, function={"name": name, "arguments": arguments})


class _FakeStreamWrapper(CustomStreamWrapper):
    """A real ``CustomStreamWrapper`` subclass (so ``copilotkit_stream``'s
    ``isinstance`` dispatch picks the streaming branch) that iterates a
    supplied async generator. Base ``__init__`` bypassed on purpose."""

    def __init__(self, gen):  # pylint: disable=super-init-not-called
        self._gen = gen

    def __aiter__(self):
        return self._gen


class _FakeFlow:
    """Minimal flow stand-in the endpoint listener can route events to."""

    def __init__(self, state=None):
        self.state = state if state is not None else {}


def _drain(queue):
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items


# --------------------------------------------------------------------------
# copilotkit_stream reassembly (through the public dispatch)
# --------------------------------------------------------------------------

async def test_copilotkit_stream_reassembles_text_and_tool_calls():
    """Text deltas + a tool call spread across chunks reassemble into one
    ModelResponse with concatenated content and one accumulated tool call."""
    flow_context.set(None)

    async def _gen():
        yield _stream_chunk("msg-1", content="Hello ")
        yield _stream_chunk("msg-1", content="world")
        yield _stream_chunk("msg-1", tool_calls=[
            _tool_call_delta(call_id="call-1", name="searchTool", arguments='{"q":')
        ])
        yield _stream_chunk("msg-1", tool_calls=[
            _tool_call_delta(call_id=None, name=None, arguments='1}')
        ])
        yield _stream_chunk("msg-1", finish_reason="stop")

    resp = await copilotkit_stream(_FakeStreamWrapper(_gen()))

    message = resp.choices[0].message
    assert message.content == "Hello world"
    assert resp.id == "msg-1"
    assert resp.model == "gpt-4o"
    assert resp.system_fingerprint == "fp_test"
    assert resp.created == 1700000000
    assert resp.choices[0].finish_reason == "stop"

    assert message.tool_calls is not None
    assert len(message.tool_calls) == 1
    tc = message.tool_calls[0]
    assert tc.id == "call-1"
    assert tc.function.name == "searchTool"
    assert tc.function.arguments == '{"q":1}'
    assert tc.type == "function"


async def test_copilotkit_stream_emits_chunk_events_per_delta():
    """Reassembly emits a bridged TEXT_MESSAGE_CHUNK per text delta and a
    TOOL_CALL_CHUNK per argument delta, deltas passed through verbatim."""
    from crewai.utilities.events import crewai_event_bus

    flow_context.set(None)
    text_chunks = []
    tool_chunks = []

    with crewai_event_bus.scoped_handlers():
        @crewai_event_bus.on(BridgedTextMessageChunkEvent)
        def _on_text(source, event):  # pylint: disable=unused-argument
            text_chunks.append((event.message_id, event.role, event.delta))

        @crewai_event_bus.on(BridgedToolCallChunkEvent)
        def _on_tool(source, event):  # pylint: disable=unused-argument
            tool_chunks.append((event.tool_call_id, event.tool_call_name, event.delta))

        async def _gen():
            yield _stream_chunk("msg-2", content="A")
            yield _stream_chunk("msg-2", content="B")
            yield _stream_chunk("msg-2", tool_calls=[
                _tool_call_delta(call_id="c-1", name="tool", arguments="{}")
            ])
            yield _stream_chunk("msg-2", finish_reason="stop")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))

    assert text_chunks == [("msg-2", "assistant", "A"), ("msg-2", "assistant", "B")]
    assert tool_chunks == [("c-1", "tool", "{}")]


async def test_copilotkit_stream_passthrough_model_response():
    """A ready ``ModelResponse`` is returned unchanged (non-streaming)."""
    from litellm.types.utils import ModelResponse

    mr = ModelResponse()
    assert (await copilotkit_stream(mr)) is mr


async def test_copilotkit_stream_rejects_unknown_type():
    """An unrecognised response type raises ``ValueError``."""
    with pytest.raises(ValueError):
        await copilotkit_stream(object())


# --------------------------------------------------------------------------
# copilotkit_predict_state / copilotkit_emit_state
# --------------------------------------------------------------------------

async def test_copilotkit_predict_state_emits_custom_event():
    """``copilotkit_predict_state`` emits a CUSTOM ``PredictState`` event."""
    ep.FastAPICrewFlowEventListener()  # registers bus handlers
    flow = _FakeFlow()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        result = await copilotkit_predict_state(
            {"steps": {"tool_name": "SearchTool", "tool_argument": "steps"}}
        )
        assert result is True
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    assert len(items) == 1
    event = items[0]
    assert event.type == EventType.CUSTOM
    assert event.name == "PredictState"
    assert event.value == [
        {"state_key": "steps", "tool": "SearchTool", "tool_argument": "steps"}
    ]


async def test_copilotkit_emit_state_emits_state_snapshot():
    """``copilotkit_emit_state`` emits a STATE_SNAPSHOT carrying the state."""
    ep.FastAPICrewFlowEventListener()
    flow = _FakeFlow()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        result = await copilotkit_emit_state({"progress": 5})
        assert result is True
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    assert len(items) == 1
    event = items[0]
    assert event.type == EventType.STATE_SNAPSHOT
    assert event.snapshot == {"progress": 5}


# --------------------------------------------------------------------------
# Endpoint listener translation (Bridged* -> wire events)
# --------------------------------------------------------------------------

async def test_listener_translates_text_and_tool_chunks():
    """The listener maps bridged text/tool chunks onto wire
    TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK events with payloads preserved."""
    from crewai.utilities.events import crewai_event_bus

    ep.FastAPICrewFlowEventListener()
    flow = _FakeFlow()
    queue = await ep.create_queue(flow)
    try:
        crewai_event_bus.emit(flow, BridgedTextMessageChunkEvent(
            type=EventType.TEXT_MESSAGE_CHUNK,
            message_id="m1", role="assistant", delta="hi",
        ))
        crewai_event_bus.emit(flow, BridgedToolCallChunkEvent(
            type=EventType.TOOL_CALL_CHUNK,
            tool_call_id="tc1", tool_call_name="searchTool", delta='{"q":1}',
        ))
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    assert [i.type for i in items] == [
        EventType.TEXT_MESSAGE_CHUNK, EventType.TOOL_CALL_CHUNK,
    ]
    text_event, tool_event = items
    assert text_event.message_id == "m1"
    assert text_event.role == "assistant"
    assert text_event.delta == "hi"
    assert tool_event.tool_call_id == "tc1"
    assert tool_event.tool_call_name == "searchTool"
    assert tool_event.delta == '{"q":1}'


async def test_listener_emits_messages_and_state_snapshot_on_method_finish():
    """On flow-method finish the listener emits MESSAGES_SNAPSHOT +
    STATE_SNAPSHOT + STEP_FINISHED, in that order."""
    from crewai.utilities.events import crewai_event_bus, MethodExecutionFinishedEvent

    state = {
        "messages": [{"role": "assistant", "content": "done", "id": "m9"}],
        "outputs": "result-text",
    }
    ep.FastAPICrewFlowEventListener()
    flow = _FakeFlow(state=state)
    queue = await ep.create_queue(flow)
    try:
        crewai_event_bus.emit(flow, MethodExecutionFinishedEvent(
            type="method_execution_finished",
            method_name="chat",
            flow_name="ChatWithCrewFlow",
            result=None,
            state=state,
        ))
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    assert [i.type for i in items] == [
        EventType.MESSAGES_SNAPSHOT,
        EventType.STATE_SNAPSHOT,
        EventType.STEP_FINISHED,
    ]
    messages_event, state_event, step_event = items

    assert len(messages_event.messages) == 1
    assert messages_event.messages[0].role == "assistant"
    assert messages_event.messages[0].content == "done"
    assert messages_event.messages[0].id == "m9"

    assert state_event.snapshot == state
    assert step_event.step_name == "chat"

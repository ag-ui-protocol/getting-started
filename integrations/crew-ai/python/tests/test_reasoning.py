"""Reasoning surfacing: provider-agnostic REASONING_* emission across both
channels (the litellm streaming delta via ``copilotkit_stream`` and crewai's
native ``LLMThinkingChunkEvent``) and both transports (the legacy event-bus
listener and the StreamFrame translator). No network.

Ordering note: the crewai 1.x event bus dispatches sync handlers on a
ThreadPoolExecutor, so bus-path tests assert the MULTISET of emitted events
(counts + content by message id), not cross-event capture order. That covers
delta CONTENT as well as lifecycle: two deltas drained from a per-run queue need
not be in emit order, so a bus-path test never asserts their concatenation.
Exact ordering (lifecycle and multi-delta reassembly alike) is asserted against
the synchronous ``StreamFrameTranslator`` and, end-to-end, by driving a real Flow
through ``_run_flow_frame_stream`` and decoding the SSE, where it is
deterministic.
"""

import contextlib
import importlib
import json as _json
import logging
import uuid
from collections import Counter
from types import SimpleNamespace

import pytest

from crewai.flow.flow import Flow, start
from litellm import CustomStreamWrapper
from litellm.types.utils import Delta

from ag_ui.core import EventType
from ag_ui.encoder import EventEncoder
from ag_ui_crewai import endpoint as ep
from ag_ui_crewai import _frames as frames_mod
from ag_ui_crewai._capabilities import CAPABILITIES, LLMThinkingChunkEvent, crewai_event_bus
from ag_ui_crewai._reasoning import (
    DeltaReasoning,
    is_thinking_event,
    reasoning_from_delta,
    thinking_event_text,
)
from ag_ui_crewai.context import flow_context
from ag_ui_crewai.events import (
    BridgedReasoningStartEvent,
    BridgedReasoningMessageStartEvent,
    BridgedReasoningMessageContentEvent,
    BridgedReasoningMessageEndEvent,
    BridgedReasoningEndEvent,
    BridgedReasoningEncryptedValueEvent,
)
from ag_ui_crewai.sdk import copilotkit_stream


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _chunk(chunk_id, *, content=None, tool_calls=None, delta=None, finish_reason=None):
    """A LiteLLM-shaped streaming chunk. ``delta`` overrides the delta object
    (e.g. a real ``litellm.Delta`` carrying reasoning), else a plain dict."""
    if delta is None:
        delta = {"content": content, "tool_calls": tool_calls}
    return {
        "id": chunk_id,
        "created": 1700000000,
        "model": "gpt-4o",
        "system_fingerprint": "fp_test",
        "choices": [{"delta": delta, "finish_reason": finish_reason}],
    }


class _FakeStreamWrapper(CustomStreamWrapper):
    def __init__(self, gen):  # pylint: disable=super-init-not-called
        self._gen = gen

    def __aiter__(self):
        return self._gen


class _FakeFlow:
    def __init__(self, state=None):
        self.state = state if state is not None else {}


class _RawThinking:
    """A minimal native thinking-chunk stand-in (``type`` + ``chunk``), for the
    translator's string-based dispatch. A real ``LLMThinkingChunkEvent`` is
    exercised separately."""

    def __init__(self, chunk):
        self.type = "llm_thinking_chunk"
        self.chunk = chunk


async def _settle_bus():
    """Flush off-thread bus handlers then tick (mirrors test_streaming)."""
    import asyncio

    from ag_ui_crewai._capabilities import crewai_event_bus

    flush = getattr(crewai_event_bus, "flush", None)
    if callable(flush):
        try:
            await asyncio.get_running_loop().run_in_executor(None, lambda: flush(5.0))
        except Exception:  # noqa: BLE001
            pass
    await asyncio.sleep(0)


def _drain(queue):
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    return items


def _translator():
    return frames_mod.StreamFrameTranslator(
        thread_id="t-1", run_id="r-1", state_provider=lambda: {}
    )


# --------------------------------------------------------------------------
# reasoning_from_delta extraction (litellm delta, provider-agnostic)
# --------------------------------------------------------------------------

def test_reasoning_from_delta_reasoning_content_string():
    """``delta.reasoning_content`` (o1/o3, deepseek) yields text, no encrypted."""
    r = reasoning_from_delta(Delta(content=None, reasoning_content="because X"))
    assert r.text == "because X"
    assert r.encrypted == ()
    assert bool(r) is True


def test_reasoning_from_delta_thinking_blocks_text_and_signature():
    """Anthropic extended thinking: ``thinking`` -> text, ``signature`` -> encrypted."""
    r = reasoning_from_delta(
        Delta(
            content=None,
            thinking_blocks=[{"type": "thinking", "thinking": "hmm", "signature": "sig1"}],
        )
    )
    assert r.text == "hmm"
    assert r.encrypted == ("sig1",)


def test_reasoning_from_delta_redacted_thinking_is_encrypted():
    """A ``redacted_thinking`` block surfaces its ``data`` as an encrypted value."""
    r = reasoning_from_delta(
        Delta(content=None, thinking_blocks=[{"type": "redacted_thinking", "data": "ENC"}])
    )
    assert r.text == ""
    assert r.encrypted == ("ENC",)


def test_reasoning_from_delta_reasoning_content_wins_over_block_text():
    """When a delta carries reasoning_content, the thinking-block text is NOT
    also appended (litellm mirrors it, so appending both double-emits); both
    encrypted blobs are still kept."""
    r = reasoning_from_delta(
        Delta(
            content=None,
            reasoning_content="step1",
            thinking_blocks=[
                {"type": "thinking", "thinking": "step1", "signature": "sig"},
                {"type": "redacted_thinking", "data": "ENC"},
            ],
        )
    )
    assert r.text == "step1"
    assert r.encrypted == ("sig", "ENC")


def test_reasoning_from_delta_anthropic_no_double_emit():
    """Anthropic extended thinking: litellm sets reasoning_content == the
    thinking block's text on the same delta. The text must be emitted once."""
    r = reasoning_from_delta(
        Delta(
            content=None,
            reasoning_content="Let me think",
            thinking_blocks=[{"type": "thinking", "thinking": "Let me think"}],
        )
    )
    assert r.text == "Let me think"


def test_reasoning_from_delta_block_text_when_no_reasoning_content():
    """A thinking block with no sibling reasoning_content contributes its text."""
    r = reasoning_from_delta(
        Delta(content=None, thinking_blocks=[{"type": "thinking", "thinking": "solo"}])
    )
    assert r.text == "solo"


def test_reasoning_from_delta_skips_non_dict_blocks():
    """Non-dict entries in thinking_blocks are skipped, not fatal."""
    r = reasoning_from_delta(
        Delta(
            content=None,
            thinking_blocks=["garbage", {"type": "thinking", "thinking": "ok"}],
        )
    )
    assert r.text == "ok"


def test_reasoning_from_delta_empty_and_non_dict_safe():
    """No reasoning -> falsy result; a non-delta object degrades to empty."""
    assert bool(reasoning_from_delta(Delta(content="answer"))) is False
    assert reasoning_from_delta(object()) == DeltaReasoning()


# --------------------------------------------------------------------------
# copilotkit_stream: litellm-path lifecycle emitted as Bridged events
# --------------------------------------------------------------------------

async def test_copilotkit_stream_emits_reasoning_then_text():
    """A reasoning delta then answer text emits the full reasoning lifecycle
    (START / MESSAGE_START / MESSAGE_CONTENT / MESSAGE_END / END) under one id,
    all before the answer's text chunk."""
    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    reasoning = []
    text_ids = []

    with crewai_event_bus.scoped_handlers():
        crewai_event_bus.on(BridgedReasoningStartEvent)(
            lambda s, e: reasoning.append(("start", e.message_id))
        )
        crewai_event_bus.on(BridgedReasoningMessageStartEvent)(
            lambda s, e: reasoning.append(("msg_start", e.message_id, e.role))
        )
        crewai_event_bus.on(BridgedReasoningMessageContentEvent)(
            lambda s, e: reasoning.append(("content", e.message_id, e.delta))
        )
        crewai_event_bus.on(BridgedReasoningMessageEndEvent)(
            lambda s, e: reasoning.append(("msg_end", e.message_id))
        )
        crewai_event_bus.on(BridgedReasoningEndEvent)(
            lambda s, e: reasoning.append(("end", e.message_id))
        )
        from ag_ui_crewai.events import BridgedTextMessageChunkEvent

        crewai_event_bus.on(BridgedTextMessageChunkEvent)(
            lambda s, e: text_ids.append(e.message_id)
        )

        async def _gen():
            yield _chunk("m1", delta=Delta(content=None, reasoning_content="thinking..."))
            yield _chunk("m1", content="answer")
            yield _chunk("m1", finish_reason="stop")

        resp = await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    kinds = [r[0] for r in reasoning]
    assert kinds.count("start") == 1
    assert kinds.count("msg_start") == 1
    assert kinds.count("msg_end") == 1
    assert kinds.count("end") == 1
    # One reasoning message id across the whole lifecycle, distinct from the
    # answer's text message id.
    rids = {r[1] for r in reasoning}
    assert len(rids) == 1
    rid = rids.pop()
    assert rid != "m1"
    assert str(uuid.UUID(rid)) == rid
    contents = [r[2] for r in reasoning if r[0] == "content"]
    assert contents == ["thinking..."]
    roles = [r[2] for r in reasoning if r[0] == "msg_start"]
    assert roles == ["reasoning"]
    # The answer text still reassembles normally.
    assert resp.choices[0].message.content == "answer"


async def test_copilotkit_stream_reasoning_encrypted_value():
    """A signature on a thinking block emits a REASONING_ENCRYPTED_VALUE carrying
    it under the reasoning message id, subtype ``message``."""
    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    starts = []
    encrypted = []

    with crewai_event_bus.scoped_handlers():
        crewai_event_bus.on(BridgedReasoningStartEvent)(
            lambda s, e: starts.append(e.message_id)
        )
        crewai_event_bus.on(BridgedReasoningEncryptedValueEvent)(
            lambda s, e: encrypted.append((e.subtype, e.entity_id, e.encrypted_value))
        )

        async def _gen():
            yield _chunk(
                "m2",
                delta=Delta(
                    content=None,
                    thinking_blocks=[
                        {"type": "thinking", "thinking": "t", "signature": "SIG"}
                    ],
                ),
            )
            yield _chunk("m2", content="done")
            yield _chunk("m2", finish_reason="stop")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    assert len(starts) == 1
    assert len(encrypted) == 1
    subtype, entity_id, value = encrypted[0]
    assert subtype == "message"
    assert value == "SIG"
    assert entity_id == starts[0]


async def test_copilotkit_stream_no_reasoning_emits_nothing():
    """A plain text stream (no reasoning) emits no reasoning events."""
    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    seen = []
    with crewai_event_bus.scoped_handlers():
        for cls in (
            BridgedReasoningStartEvent,
            BridgedReasoningMessageStartEvent,
            BridgedReasoningMessageContentEvent,
            BridgedReasoningMessageEndEvent,
            BridgedReasoningEndEvent,
        ):
            crewai_event_bus.on(cls)(lambda s, e: seen.append(e.type))

        async def _gen():
            yield _chunk("m3", content="hi")
            yield _chunk("m3", finish_reason="stop")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    assert seen == []


def _capture_reasoning(bus, sink):
    """Register handlers appending (kind, event) to ``sink`` for every Bridged
    reasoning event. Caller owns the scoped_handlers context."""
    bus.on(BridgedReasoningStartEvent)(lambda s, e: sink.append(("start", e)))
    bus.on(BridgedReasoningMessageStartEvent)(lambda s, e: sink.append(("msg_start", e)))
    bus.on(BridgedReasoningMessageContentEvent)(lambda s, e: sink.append(("content", e)))
    bus.on(BridgedReasoningMessageEndEvent)(lambda s, e: sink.append(("msg_end", e)))
    bus.on(BridgedReasoningEndEvent)(lambda s, e: sink.append(("end", e)))
    bus.on(BridgedReasoningEncryptedValueEvent)(lambda s, e: sink.append(("enc", e)))


async def test_copilotkit_stream_tool_call_closes_reasoning():
    """Reasoning is closed before a tool call streams."""
    from types import SimpleNamespace

    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    events = []
    with crewai_event_bus.scoped_handlers():
        _capture_reasoning(crewai_event_bus, events)

        async def _gen():
            yield _chunk("mt", delta=Delta(content=None, reasoning_content="planning"))
            yield _chunk(
                "mt",
                delta={
                    "content": None,
                    "tool_calls": [
                        SimpleNamespace(
                            id="c-1", function={"name": "tool", "arguments": "{}"}
                        )
                    ],
                },
            )
            yield _chunk("mt", finish_reason="tool_calls")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    kinds = [k for k, _ in events]
    assert kinds.count("start") == 1
    assert kinds.count("msg_end") == 1
    assert kinds.count("end") == 1


async def test_copilotkit_stream_encrypted_only_reasoning():
    """A redacted-thinking delta with no text still opens and closes a reasoning
    message and emits exactly one encrypted value, no content."""
    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    events = []
    with crewai_event_bus.scoped_handlers():
        _capture_reasoning(crewai_event_bus, events)

        async def _gen():
            yield _chunk(
                "me",
                delta=Delta(
                    content=None,
                    thinking_blocks=[{"type": "redacted_thinking", "data": "ENC"}],
                ),
            )
            yield _chunk("me", content="answer")
            yield _chunk("me", finish_reason="stop")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    kinds = [k for k, _ in events]
    assert kinds.count("start") == 1
    assert kinds.count("content") == 0
    encs = [e for k, e in events if k == "enc"]
    assert len(encs) == 1
    assert encs[0].encrypted_value == "ENC"
    assert kinds.count("msg_end") == 1
    assert kinds.count("end") == 1


async def test_copilotkit_stream_closes_reasoning_on_error():
    """A stream that raises mid-reasoning still closes the reasoning message
    (REASONING_MESSAGE_END + END) via the finally, so the lifecycle is not left
    half-open."""
    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    events = []
    with crewai_event_bus.scoped_handlers():
        _capture_reasoning(crewai_event_bus, events)

        async def _gen():
            yield _chunk("mx", delta=Delta(content=None, reasoning_content="mid"))
            raise RuntimeError("stream blew up")

        with pytest.raises(RuntimeError, match="stream blew up"):
            await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    kinds = [k for k, _ in events]
    assert kinds.count("start") == 1
    assert kinds.count("msg_end") == 1
    assert kinds.count("end") == 1


def _group_by_id(events, kind, id_attr, value_attr):
    """``{message id: [payloads]}`` for one captured reasoning event kind."""
    grouped = {}
    for captured_kind, event in events:
        if captured_kind == kind:
            grouped.setdefault(getattr(event, id_attr), []).append(
                getattr(event, value_attr)
            )
    return grouped


def _assert_lifecycles_for(events, message_ids):
    """Each id in ``message_ids`` has exactly one START/MESSAGE_START/END pair, and
    no other id appears in the lifecycle."""
    for kind in ("start", "msg_start", "msg_end", "end"):
        ids = sorted(e.message_id for k, e in events if k == kind)
        assert ids == sorted(message_ids), (kind, ids)


async def test_copilotkit_stream_reasoning_text_after_close_opens_a_second_block():
    """Reasoning TEXT arriving after the answer text closed the first block is a
    genuine SECOND thinking block: it gets its own complete lifecycle under a new
    message id. Latching the channel shut on close discards that reasoning
    instead, which is content loss on a working reasoning channel."""
    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    events = []
    with crewai_event_bus.scoped_handlers():
        _capture_reasoning(crewai_event_bus, events)

        async def _gen():
            yield _chunk("mr", delta=Delta(content=None, reasoning_content="first"))
            yield _chunk("mr", content="answer")
            yield _chunk("mr", delta=Delta(content=None, reasoning_content="late"))
            yield _chunk("mr", finish_reason="stop")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    content_by_id = _group_by_id(events, "content", "message_id", "delta")
    assert sorted(content_by_id.values()) == [["first"], ["late"]], content_by_id
    _assert_lifecycles_for(events, content_by_id)


async def test_copilotkit_stream_anthropic_thinking_interleaved_with_tool_call():
    """Anthropic extended thinking around a tool call: the driver closes the
    reasoning message when the tool call streams, and the thinking block that
    FOLLOWS opens a second complete one. Both texts and both signatures surface,
    so the working Anthropic channel never loses a block."""
    from types import SimpleNamespace

    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    events = []
    with crewai_event_bus.scoped_handlers():
        _capture_reasoning(crewai_event_bus, events)

        async def _gen():
            yield _chunk("ma", delta=Delta(
                content=None,
                thinking_blocks=[
                    {"type": "thinking", "thinking": "step one", "signature": "SIG1"}
                ],
            ))
            yield _chunk("ma", delta={
                "content": None,
                "tool_calls": [
                    SimpleNamespace(id="c-1", function={"name": "tool", "arguments": "{}"})
                ],
            })
            yield _chunk("ma", delta=Delta(
                content=None,
                thinking_blocks=[
                    {"type": "thinking", "thinking": "step two", "signature": "SIG2"}
                ],
            ))
            yield _chunk("ma", finish_reason="tool_calls")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    content_by_id = _group_by_id(events, "content", "message_id", "delta")
    assert sorted(content_by_id.values()) == [["step one"], ["step two"]], content_by_id
    encrypted_by_id = _group_by_id(events, "enc", "entity_id", "encrypted_value")
    assert sorted(encrypted_by_id.values()) == [["SIG1"], ["SIG2"]], encrypted_by_id
    # Each signature rides the block it belongs to, not a stray message.
    assert set(encrypted_by_id) == set(content_by_id)
    _assert_lifecycles_for(events, content_by_id)


async def test_copilotkit_stream_encrypted_only_reasoning_after_close_is_dropped():
    """A redacted-thinking blob (no text) arriving after the block closed must NOT
    open a second reasoning message: it carries nothing renderable, so the client
    would show an empty second trace under the answer. Only the blob is dropped."""
    from ag_ui_crewai._capabilities import crewai_event_bus

    flow_context.set(None)
    events = []
    with crewai_event_bus.scoped_handlers():
        _capture_reasoning(crewai_event_bus, events)

        async def _gen():
            yield _chunk("mz", delta=Delta(content=None, reasoning_content="first"))
            yield _chunk("mz", content="answer")
            yield _chunk("mz", delta=Delta(
                content=None,
                thinking_blocks=[{"type": "redacted_thinking", "data": "LATE"}],
            ))
            yield _chunk("mz", finish_reason="stop")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))
        await _settle_bus()

    content_by_id = _group_by_id(events, "content", "message_id", "delta")
    assert sorted(content_by_id.values()) == [["first"]], content_by_id
    _assert_lifecycles_for(events, content_by_id)
    assert [e.encrypted_value for k, e in events if k == "enc"] == []


# --------------------------------------------------------------------------
# Legacy transport: endpoint listener translates Bridged -> wire events
# --------------------------------------------------------------------------

async def test_legacy_listener_translates_reasoning_events():
    """The bus listener maps each Bridged reasoning event to its wire event on
    the per-flow queue."""
    from ag_ui_crewai._capabilities import crewai_event_bus

    ep.FastAPICrewFlowEventListener()  # registers bus handlers
    flow = _FakeFlow()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        crewai_event_bus.emit(
            flow,
            BridgedReasoningStartEvent(type=EventType.REASONING_START, message_id="rid"),
        )
        crewai_event_bus.emit(
            flow,
            BridgedReasoningMessageContentEvent(
                type=EventType.REASONING_MESSAGE_CONTENT, message_id="rid", delta="why"
            ),
        )
        crewai_event_bus.emit(
            flow,
            BridgedReasoningEncryptedValueEvent(
                type=EventType.REASONING_ENCRYPTED_VALUE,
                subtype="message",
                entity_id="rid",
                encrypted_value="SIG",
            ),
        )
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    by_type = {e.type: e for e in items}
    assert EventType.REASONING_START in by_type
    assert EventType.REASONING_MESSAGE_CONTENT in by_type
    assert EventType.REASONING_ENCRYPTED_VALUE in by_type
    assert by_type[EventType.REASONING_MESSAGE_CONTENT].delta == "why"
    assert by_type[EventType.REASONING_START].message_id == "rid"
    enc = by_type[EventType.REASONING_ENCRYPTED_VALUE]
    assert enc.encrypted_value == "SIG"
    assert enc.entity_id == "rid"


# --------------------------------------------------------------------------
# Frame transport: translator maps Bridged reasoning 1:1 (deterministic order)
# --------------------------------------------------------------------------

def test_frame_translator_maps_bridged_reasoning_one_to_one():
    """Each Bridged reasoning event translates to exactly its wire event."""
    tr = _translator()
    assert tr.translate(
        BridgedReasoningStartEvent(type=EventType.REASONING_START, message_id="r")
    )[0].type == EventType.REASONING_START
    msg_start = tr.translate(
        BridgedReasoningMessageStartEvent(
            type=EventType.REASONING_MESSAGE_START, message_id="r", role="reasoning"
        )
    )[0]
    assert msg_start.type == EventType.REASONING_MESSAGE_START
    assert msg_start.role == "reasoning"
    content = tr.translate(
        BridgedReasoningMessageContentEvent(
            type=EventType.REASONING_MESSAGE_CONTENT, message_id="r", delta="d"
        )
    )[0]
    assert content.type == EventType.REASONING_MESSAGE_CONTENT
    assert content.delta == "d"
    assert tr.translate(
        BridgedReasoningMessageEndEvent(type=EventType.REASONING_MESSAGE_END, message_id="r")
    )[0].type == EventType.REASONING_MESSAGE_END
    assert tr.translate(
        BridgedReasoningEndEvent(type=EventType.REASONING_END, message_id="r")
    )[0].type == EventType.REASONING_END
    enc = tr.translate(
        BridgedReasoningEncryptedValueEvent(
            type=EventType.REASONING_ENCRYPTED_VALUE,
            subtype="message",
            entity_id="r",
            encrypted_value="SIG",
        )
    )[0]
    assert enc.type == EventType.REASONING_ENCRYPTED_VALUE
    assert enc.encrypted_value == "SIG"


# --------------------------------------------------------------------------
# Frame transport: native crewai thinking-chunk lifecycle (Gemini)
# --------------------------------------------------------------------------

def test_native_thinking_opens_lifecycle_and_streams_content():
    """The first native thinking chunk opens START + MESSAGE_START then CONTENT;
    a following chunk just streams CONTENT under the same id."""
    tr = _translator()
    first = tr.translate(_RawThinking("a"))
    assert [e.type for e in first] == [
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
    ]
    mid = first[0].message_id
    assert first[1].role == "reasoning"
    assert first[2].delta == "a"

    second = tr.translate(_RawThinking("b"))
    assert [e.type for e in second] == [EventType.REASONING_MESSAGE_CONTENT]
    assert second[0].message_id == mid
    assert second[0].delta == "b"


def test_native_thinking_flushed_before_next_event():
    """A non-thinking event closes the open reasoning message first: its
    MESSAGE_END + END precede the next event's translation."""
    tr = _translator()
    tr.translate(_RawThinking("a"))
    from ag_ui_crewai.events import BridgedTextMessageChunkEvent

    out = tr.translate(
        BridgedTextMessageChunkEvent(
            type=EventType.TEXT_MESSAGE_CHUNK, message_id="m", role="assistant", delta="hi"
        )
    )
    assert [e.type for e in out] == [
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
    ]
    # Closed: a later non-thinking event no longer re-flushes reasoning, and the
    # same open message_id continues with CONTENT (no fresh START).
    again = tr.translate(
        BridgedTextMessageChunkEvent(
            type=EventType.TEXT_MESSAGE_CHUNK, message_id="m", role="assistant", delta="!"
        )
    )
    assert [e.type for e in again] == [EventType.TEXT_MESSAGE_CONTENT]


def test_native_thinking_flushed_on_finalize():
    """A run that ends with reasoning still open is closed by finalize()."""
    tr = _translator()
    # Open the run so finalize also emits RUN_FINISHED.
    tr.translate(type("F", (), {"type": "flow_started"})())
    tr.translate(_RawThinking("a"))
    out = tr.finalize()
    assert out[0].type == EventType.REASONING_MESSAGE_END
    assert out[1].type == EventType.REASONING_END
    assert out[-1].type == EventType.RUN_FINISHED


def test_native_thinking_real_event_translates():
    """A REAL crewai ``LLMThinkingChunkEvent`` drives the lifecycle (not just a
    stand-in): proves the ``type`` / ``chunk`` contract against the installed
    crewai."""
    if LLMThinkingChunkEvent is None:
        pytest.skip("crewai build without LLMThinkingChunkEvent (< 1.10.1)")
    real = LLMThinkingChunkEvent(chunk="native reasoning", call_id="c1")
    assert is_thinking_event(real) is True
    assert thinking_event_text(real) == "native reasoning"
    # The frame sink parks events by ``event_id``; a native thinking event must
    # carry a non-None one or it could never surface on the StreamFrame path.
    assert getattr(real, "event_id", None) is not None
    tr = _translator()
    out = tr.translate(real)
    assert [e.type for e in out] == [
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
    ]
    assert out[2].delta == "native reasoning"


def test_native_thinking_frame_pipeline_correlation():
    """Simulate the sink -> frame-lookup -> translate pipeline the frame driver
    runs: a native thinking event parked by ``event_id`` is retrievable by
    ``frame.id`` (crewai's documented ``frame.id == event.event_id`` contract)
    and translates to the reasoning lifecycle."""
    if LLMThinkingChunkEvent is None:
        pytest.skip("crewai build without LLMThinkingChunkEvent (< 1.10.1)")
    event = LLMThinkingChunkEvent(chunk="parked", call_id="c1")
    # Sink gate: native thinking events are parked by type even though their
    # source is the LLM (not the flow), keyed by event_id.
    assert is_thinking_event(event) is True
    raw_events = {}
    raw_events[event.event_id] = event
    # Frame driver looks the raw event up by frame.id == event_id.
    looked_up = raw_events.pop(event.event_id, None)
    assert looked_up is event
    out = _translator().translate(looked_up)
    assert [e.type for e in out] == [
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
    ]


# --------------------------------------------------------------------------
# Frame transport: flush open reasoning on the error path
# --------------------------------------------------------------------------

def test_flush_open_reasoning_closes_native():
    """An open native reasoning message is closed by flush_open_reasoning."""
    tr = _translator()
    tr.translate(_RawThinking("a"))
    out = tr.flush_open_reasoning()
    assert [e.type for e in out] == [
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
    ]
    # Idempotent: a second flush is a no-op.
    assert tr.flush_open_reasoning() == []


def test_flush_open_reasoning_closes_litellm():
    """An open litellm reasoning message (START+MESSAGE_START passed through, END
    dropped by a mid-run error) is closed by flush_open_reasoning."""
    tr = _translator()
    tr.translate(BridgedReasoningStartEvent(type=EventType.REASONING_START, message_id="r"))
    tr.translate(
        BridgedReasoningMessageStartEvent(
            type=EventType.REASONING_MESSAGE_START, message_id="r", role="reasoning"
        )
    )
    tr.translate(
        BridgedReasoningMessageContentEvent(
            type=EventType.REASONING_MESSAGE_CONTENT, message_id="r", delta="x"
        )
    )
    out = tr.flush_open_reasoning()
    assert [e.type for e in out] == [
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
    ]
    assert out[0].message_id == "r"


def test_flush_open_reasoning_noop_after_clean_litellm_close():
    """A litellm reasoning message closed normally leaves nothing to flush."""
    tr = _translator()
    tr.translate(BridgedReasoningStartEvent(type=EventType.REASONING_START, message_id="r"))
    tr.translate(
        BridgedReasoningMessageStartEvent(
            type=EventType.REASONING_MESSAGE_START, message_id="r", role="reasoning"
        )
    )
    tr.translate(
        BridgedReasoningMessageEndEvent(type=EventType.REASONING_MESSAGE_END, message_id="r")
    )
    tr.translate(BridgedReasoningEndEvent(type=EventType.REASONING_END, message_id="r"))
    assert tr.flush_open_reasoning() == []


# --------------------------------------------------------------------------
# Capability surface
# --------------------------------------------------------------------------

def test_reasoning_capability_available():
    """Reasoning is reported available (the litellm channel is always live)."""
    assert CAPABILITIES.reasoning_available is True
    # native_reasoning_event_available requires crewai >= 1.10.1; the pyproject
    # floor is >= 1.0, so only assert it against whether the event resolved.
    assert CAPABILITIES.native_reasoning_event_available is (
        LLMThinkingChunkEvent is not None
    )


# --------------------------------------------------------------------------
# End-to-end through the real StreamFrame driver (deterministic ordering).
# These drive a real crewai Flow through ``_run_flow_frame_stream`` and decode
# the SSE, so they catch removal of the load-bearing lines that per-event-count
# assertions cannot: the close-before-answer ordering hooks in ``sdk.py`` and
# the native thinking-chunk parking in the endpoint sink gate.
# --------------------------------------------------------------------------

requires_stream_frames = pytest.mark.skipif(
    not CAPABILITIES.stream_frame_available,
    reason="installed crewai has no StreamFrame transport",
)


def _decode_sse(encoded_items):
    payloads = []
    for chunk in encoded_items:
        for line in chunk.splitlines():
            if line.startswith("data:"):
                payloads.append(_json.loads(line[len("data:"):].strip()))
    return payloads


async def _collect(agen):
    return [item async for item in agen]


def _run_input(thread_id="t-1", run_id="r-1"):
    from ag_ui.core import RunAgentInput

    return RunAgentInput(
        thread_id=thread_id, run_id=run_id, state={}, messages=[], tools=[],
        context=[], forwarded_props={},
    )


class _ReasoningThenTextFlow(Flow):
    """A real Flow whose method drives ``copilotkit_stream`` with a litellm stream
    that emits reasoning deltas THEN answer text, exactly as a reasoning model
    does. Exercises the sdk state machine end-to-end through the frame driver."""

    @start()
    async def chat(self):
        async def _gen():
            yield _chunk("m1", delta=Delta(content=None, reasoning_content="Because "))
            yield _chunk("m1", delta=Delta(content=None, reasoning_content="X."))
            yield _chunk("m1", content="Answer")
            yield _chunk("m1", finish_reason="stop")

        await copilotkit_stream(_FakeStreamWrapper(_gen()))
        return "done"


class _NativeThinkingFlow(Flow):
    """A real Flow emitting crewai's native ``LLMThinkingChunkEvent`` the way the
    Gemini provider does: with the LLM (not the flow) as source."""

    @start()
    async def chat(self):
        crewai_event_bus.emit(
            object(),
            event=LLMThinkingChunkEvent(chunk="pondering", call_id="c-1"),
        )
        return "done"


@requires_stream_frames
async def test_litellm_reasoning_closes_before_answer_text_e2e():
    """The full reasoning lifecycle is emitted, and it CLOSES
    (REASONING_MESSAGE_END + REASONING_END) BEFORE the first answer
    TEXT_MESSAGE_START. Deleting either ``_close_reasoning()`` hook in
    ``sdk.py`` moves the close after the text (only the finally would fire), so
    this ordering assertion fails."""
    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=_ReasoningThenTextFlow(),
        encoder=EventEncoder(),
        input_data=_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    )))
    types = [p["type"] for p in payloads]
    for t in (
        "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END", "REASONING_END", "TEXT_MESSAGE_START",
    ):
        assert t in types, types
    first_text = types.index("TEXT_MESSAGE_START")
    # Every reasoning event precedes the answer text.
    assert types.index("REASONING_START") < first_text
    assert types.index("REASONING_MESSAGE_END") < first_text
    assert types.index("REASONING_END") < first_text
    # Lifecycle is well-ordered within itself.
    assert (
        types.index("REASONING_START")
        < types.index("REASONING_MESSAGE_START")
        < types.index("REASONING_MESSAGE_CONTENT")
        < types.index("REASONING_MESSAGE_END")
        < types.index("REASONING_END")
    )
    # Multi-delta reasoning reassembles in the order the provider sent it. This
    # is the deterministic home for that claim: on the bus path the drained order
    # is not guaranteed, so those tests assert the multiset instead.
    deltas = [p["delta"] for p in payloads if p["type"] == "REASONING_MESSAGE_CONTENT"]
    assert len(deltas) == 2, payloads
    assert "".join(deltas) == "Because X."


@requires_stream_frames
async def test_native_thinking_surfaces_reasoning_e2e():
    """A native ``LLMThinkingChunkEvent`` (LLM as source, not the flow) surfaces
    as REASONING_* on the wire. Removing ``is_thinking_event`` from the endpoint
    sink gate stops the event being parked, so no REASONING_* is produced and
    this fails."""
    if LLMThinkingChunkEvent is None:  # pragma: no cover
        pytest.skip("installed crewai does not expose LLMThinkingChunkEvent")
    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=_NativeThinkingFlow(),
        encoder=EventEncoder(),
        input_data=_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    )))
    types = [p["type"] for p in payloads]
    assert "REASONING_START" in types, types
    assert "REASONING_MESSAGE_START" in types, types
    content = next(
        (p for p in payloads if p["type"] == "REASONING_MESSAGE_CONTENT"), None
    )
    assert content is not None, types
    assert content["delta"] == "pondering"
    # RAW passthrough is off in this call, so "no RAW here" says nothing about the
    # recognized-channel rule; that claim is asserted with ``emit_raw_events=True``
    # by test_native_thinking_not_double_emitted_under_raw_passthrough.


@requires_stream_frames
async def test_native_thinking_not_double_emitted_under_raw_passthrough():
    """With ``emit_raw_events=True`` the native thinking chunk is TRANSLATED to
    REASONING_* and NOT also RAW-mirrored (it is a recognized channel), so it
    appears exactly once as reasoning and never as RAW."""
    if LLMThinkingChunkEvent is None:  # pragma: no cover
        pytest.skip("installed crewai does not expose LLMThinkingChunkEvent")
    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=_NativeThinkingFlow(),
        encoder=EventEncoder(),
        input_data=_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
        emit_raw_events=True,
    )))
    types = [p["type"] for p in payloads]
    assert types.count("REASONING_MESSAGE_CONTENT") == 1, types
    raw_thinking = [
        p for p in payloads
        if p["type"] == "RAW" and p.get("event", {}).get("type") == "llm_thinking_chunk"
    ]
    assert raw_thinking == [], payloads


# --------------------------------------------------------------------------
# OpenAI Responses channel: reasoning summaries never appear on the
# chat-completions delta, so this is the ONLY channel that can surface an
# OpenAI thinking trace. These build the same event objects litellm produces
# (typed events where litellm knows the type, ``GenericEvent`` for the
# reasoning-summary deltas it does not) so the projection is exercised against
# real shapes, not hand-rolled stand-ins.
#
# Those event models are Responses-API additions, so they are NOT present on
# every litellm this package's declared floor (``litellm>=1.60.2``) permits.
# Import them DEFENSIVELY: an unguarded module-level import raises at COLLECTION
# time on such a build and takes down every test in this file, including the
# chat-completions and native-thinking channels that have nothing to do with the
# Responses API.
#
# What a test that needs an absent model must do is SKIP, never fail: the build
# genuinely cannot exercise the code. Two layers deliver that, and the second is
# the one that holds as tests are added:
#
# 1. ``requires_responses_types`` skips at COLLECTION time. Cheap and explicit,
#    but it only protects the tests someone remembered to decorate.
# 2. Each absent model is bound to an ``_AbsentResponsesType`` PROXY rather than
#    ``None``. Constructing, subscripting or reading an attribute off it skips the
#    test that reached it. So a new Responses test needs no decorator and CANNOT
#    turn a permitted litellm red; binding ``None`` instead made every undecorated
#    test raise ``TypeError: 'NoneType' object is not callable``.
#
# Symbols imported at CALL time rather than through the block below go through
# ``_responses_symbol``, which skips the same way.
# --------------------------------------------------------------------------

from pydantic import ValidationError  # noqa: E402

_RESPONSES_TYPES_ERROR: ImportError | None = None


class _AbsentResponsesType:
    """Stand-in for a Responses-API model the installed litellm does not expose.

    Any use of it skips the calling test. ``pytest.skip`` raises a
    ``BaseException``, so a production ``except Exception`` in the path under test
    cannot swallow the skip into a pass or into some unrelated assertion failure.
    """

    def __init__(self, name):
        self._name = name

    def _skip(self, *_args, **_kwargs):
        pytest.skip(
            f"installed litellm exposes no {self._name}: {_RESPONSES_TYPES_ERROR}"
        )

    __call__ = _skip
    __getitem__ = _skip

    def __getattr__(self, name):
        # Dunder lookups are INTROSPECTION, not use: pytest's own collection reads
        # ``__test__`` off every module global. Report those absent instead of
        # skipping the whole module.
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        self._skip()

    def __repr__(self):
        return f"<absent Responses-API model {self._name}>"


try:  # noqa: E402
    from litellm.types.llms.openai import (
        FunctionCallArgumentsDeltaEvent,
        GenericEvent,
        IncompleteDetails,
        OutputItemAddedEvent,
        OutputTextDeltaEvent,
        ResponseCompletedEvent,
        ResponseCreatedEvent,
        ResponseIncompleteEvent,
        ResponsesAPIResponse,
    )
except ImportError as exc:  # pragma: no cover - depends on the installed litellm
    _RESPONSES_TYPES_ERROR = exc
    FunctionCallArgumentsDeltaEvent = _AbsentResponsesType(
        "FunctionCallArgumentsDeltaEvent"
    )
    GenericEvent = _AbsentResponsesType("GenericEvent")
    IncompleteDetails = _AbsentResponsesType("IncompleteDetails")
    OutputItemAddedEvent = _AbsentResponsesType("OutputItemAddedEvent")
    OutputTextDeltaEvent = _AbsentResponsesType("OutputTextDeltaEvent")
    ResponseCompletedEvent = _AbsentResponsesType("ResponseCompletedEvent")
    ResponseCreatedEvent = _AbsentResponsesType("ResponseCreatedEvent")
    ResponseIncompleteEvent = _AbsentResponsesType("ResponseIncompleteEvent")
    ResponsesAPIResponse = _AbsentResponsesType("ResponsesAPIResponse")

requires_responses_types = pytest.mark.skipif(
    _RESPONSES_TYPES_ERROR is not None,
    reason=(
        "installed litellm exposes no Responses-API event models: "
        f"{_RESPONSES_TYPES_ERROR}"
    ),
)


def test_locked_litellm_exposes_the_responses_event_models():
    """The pinned litellm actually resolves the Responses-API event models.

    UNDECORATED on purpose. ``requires_responses_types`` skips ~70 tests when the
    models cannot be imported, and CI runs a single ``uv sync --locked`` litellm,
    so a build that re-homed those models would take that whole block dark on an
    otherwise green job. This canary turns that silent hole into one red line
    naming the cause: green on the locked build, red the moment the import — or
    the production registry lookup — stops resolving on the build under test."""
    assert _RESPONSES_TYPES_ERROR is None, _RESPONSES_TYPES_ERROR
    # An import that succeeds but a registry lookup that re-homed would skip just
    # as silently, so assert the production probe resolved too.
    from ag_ui_crewai._capabilities import responses_event_modelling

    modelling = responses_event_modelling()
    assert modelling.resolver_available is True
    assert modelling.usable is True
    assert modelling.unmodellable_event_types == ()


def _responses_symbol(module_path, name):
    """Return ``module_path.name``, skipping the calling test if it is absent.

    For Responses-API symbols a single assertion needs, imported where they are
    used rather than through the guarded block above. An unguarded call-time
    import is the same red build in a different place.
    """
    try:
        module = importlib.import_module(module_path)
        return getattr(module, name)
    except (ImportError, AttributeError) as exc:  # pragma: no cover - build-dependent
        pytest.skip(f"installed litellm exposes no {module_path}.{name}: {exc}")


from ag_ui_crewai import _responses as responses_mod  # noqa: E402
from ag_ui_crewai import sdk as sdk_mod  # noqa: E402
from ag_ui_crewai._reasoning import (  # noqa: E402
    reasoning_from_responses_event,
    responses_event_type,
)
from ag_ui_crewai.examples.agentic_chat_reasoning import (  # noqa: E402
    AgenticChatReasoningFlow,
)


def _responses_api_response(status="completed", *, created_at=1700000000,
                            incomplete_details=None):
    """A real ``ResponsesAPIResponse``, as litellm hands back on created/completed.

    ``created_at`` is typed ``float`` here exactly as it is on the wire, so a
    fractional timestamp can be exercised.
    """
    return ResponsesAPIResponse(
        id="resp_1",
        object="response",
        created_at=created_at,
        model="gpt-5.4",
        status=status,
        output=[],
        error=None,
        incomplete_details=incomplete_details,
        instructions=None,
        metadata={},
        parallel_tool_calls=False,
        temperature=1.0,
        tool_choice="auto",
        tools=[],
        top_p=1.0,
        max_output_tokens=None,
        previous_response_id=None,
        reasoning={"effort": "medium", "summary": "auto"},
        text={"format": {"type": "text"}},
        truncation="disabled",
        usage=None,
        user=None,
    )


def _summary_delta(text, *, item_id="rs_1"):
    """The reasoning-summary delta litellm surfaces as a ``GenericEvent``."""
    return GenericEvent(
        type="response.reasoning_summary_text.delta",
        item_id=item_id,
        output_index=0,
        summary_index=0,
        delta=text,
    )


class _FakeResponsesStream:
    """Duck-types litellm's Responses streaming iterator.

    ``is_responses_stream`` probes for an async-iterable exposing
    ``_process_chunk``; that is exactly the iterator's public shape.
    """

    def __init__(self, events):
        self._events = list(events)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)

    def _process_chunk(self, chunk):  # pragma: no cover - probe target only
        return None


def _reasoning_then_text_events():
    return [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        _summary_delta("Weighing the "),
        _summary_delta("options."),
        OutputItemAddedEvent(
            type="response.output_item.added",
            output_index=1,
            item={"id": "msg_1", "type": "message", "role": "assistant", "content": []},
        ),
        OutputTextDeltaEvent(
            type="response.output_text.delta",
            item_id="msg_1",
            output_index=1,
            content_index=0,
            delta="Answer",
        ),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ]


def _function_call_added(item_id="fc_1", *, call_id="call_abc", arguments=""):
    """The ``output_item.added`` event that opens a Responses function call.

    ``OutputItemAddedEvent`` defines NO ``item_id`` field: the item's id lives at
    ``item["id"]``, which is why the message-id lookup must read both shapes.
    """
    return OutputItemAddedEvent(
        type="response.output_item.added",
        output_index=0,
        item={
            "id": item_id,
            "call_id": call_id,
            "type": "function_call",
            "name": "change_background",
            "arguments": arguments,
        },
    )


def _reasoning_item_done(encrypted="BLOB", *, item_id="rs_1"):
    """The finished ``reasoning`` output item carrying the encrypted blob."""
    return GenericEvent(
        type="response.output_item.done",
        output_index=0,
        item={"id": item_id, "type": "reasoning", "encrypted_content": encrypted},
    )


def _reasoning_item_done_object(encrypted="BLOB", *, item_id="rs_1"):
    """A completed item with the object shape used by current LiteLLM."""
    output_item_done_event = _responses_symbol(
        "litellm.types.llms.openai", "OutputItemDoneEvent"
    )
    response_reasoning_item = _responses_symbol(
        "openai.types.responses", "ResponseReasoningItem"
    )
    return output_item_done_event.model_construct(
        type="response.output_item.done",
        output_index=0,
        item=response_reasoning_item(
            id=item_id,
            summary=[],
            type="reasoning",
            encrypted_content=encrypted,
        ),
    )


def _text_delta(text, *, item_id="msg_1"):
    return OutputTextDeltaEvent(
        type="response.output_text.delta",
        item_id=item_id, output_index=1, content_index=0, delta=text,
    )


# -- projection ------------------------------------------------------------

@requires_responses_types
def test_responses_event_type_normalizes_enum_and_string():
    """A typed event's enum ``type`` and a GenericEvent's string both read as the
    wire string, so the projection matches either.

    The returned value must be a PLAIN ``str``: litellm's
    ``ResponsesAPIStreamEvents`` is a str-mixin enum, so an equality check alone
    passes on the un-normalised enum too. Callers put these values in
    ``frozenset`` membership tests and serialise them, so the type is the point."""
    typed = OutputTextDeltaEvent(
        type="response.output_text.delta",
        item_id="i", output_index=0, content_index=0, delta="x",
    )
    # The raw field really is an enum here, else the normalisation is untested.
    assert type(typed.type) is not str
    normalized = responses_event_type(typed)
    assert normalized == "response.output_text.delta"
    assert type(normalized) is str
    generic = responses_event_type(_summary_delta("x"))
    assert generic == "response.reasoning_summary_text.delta"
    assert type(generic) is str
    assert responses_event_type(object()) is None


@requires_responses_types
def test_reasoning_from_responses_summary_delta():
    """A reasoning-summary delta keeps the provider reasoning-item identity."""
    r = reasoning_from_responses_event(_summary_delta("because X"))
    assert r == DeltaReasoning(text="because X", encrypted=(), item_id="rs_1")
    assert r.item_id == "rs_1"
    assert bool(r) is True


@requires_responses_types
def test_reasoning_from_responses_raw_reasoning_text_delta():
    """The raw ``reasoning_text`` variant is projected too."""
    event = GenericEvent(
        type="response.reasoning_text.delta", item_id="rs_1", output_index=0, delta="hm"
    )
    assert reasoning_from_responses_event(event).text == "hm"


@requires_responses_types
def test_reasoning_from_responses_encrypted_content():
    """A finished ``reasoning`` output item surfaces its encrypted blob."""
    event = GenericEvent(
        type="response.output_item.done",
        output_index=0,
        item={"id": "rs_1", "type": "reasoning", "encrypted_content": "BLOB"},
    )
    r = reasoning_from_responses_event(event)
    assert r.text == ""
    assert r.encrypted == ("BLOB",)
    assert r.item_id == "rs_1"


@requires_responses_types
def test_reasoning_from_responses_object_item_keeps_identity_and_encrypted_content():
    """Current LiteLLM exposes completed output items as response objects.

    ``model_construct`` lets the locked version's event model carry that current
    object shape without weakening the test into a hand-written event double.
    """
    event = _reasoning_item_done_object(
        "OBJECT_BLOB",
        item_id="rs_object",
    )

    r = reasoning_from_responses_event(event)

    assert r == DeltaReasoning(
        encrypted=("OBJECT_BLOB",),
        item_id="rs_object",
    )


@requires_responses_types
@pytest.mark.parametrize(
    "event_kind",
    ["summary_delta", "completed_item"],
)
def test_reasoning_from_responses_requires_provider_item_id(event_kind):
    """Silently minting an id makes the item impossible to replay correctly."""
    if event_kind == "summary_delta":
        event = GenericEvent(
            type="response.reasoning_summary_text.delta",
            output_index=0,
            summary_index=0,
            delta="orphaned",
        )
    else:
        event = GenericEvent(
            type="response.output_item.done",
            output_index=0,
            item={"type": "reasoning", "encrypted_content": "BLOB"},
        )
    with pytest.raises(RuntimeError, match="reasoning item id"):
        reasoning_from_responses_event(event)


@requires_responses_types
def test_reasoning_from_responses_ignores_other_events():
    """Text deltas, non-reasoning finished items and empty deltas are no-ops, so a
    non-reasoning model produces nothing."""
    text_delta = OutputTextDeltaEvent(
        type="response.output_text.delta",
        item_id="i", output_index=0, content_index=0, delta="hello",
    )
    assert not reasoning_from_responses_event(text_delta)
    message_done = GenericEvent(
        type="response.output_item.done",
        output_index=0,
        item={"id": "msg_1", "type": "message"},
    )
    assert not reasoning_from_responses_event(message_done)
    assert not reasoning_from_responses_event(_summary_delta(""))
    assert not reasoning_from_responses_event(object())


# -- copilotkit_stream over the Responses channel --------------------------

@requires_responses_types
async def test_copilotkit_stream_responses_emits_reasoning_then_text():
    """A Responses stream surfaces REASONING_* for its summary deltas, closes the
    reasoning message before the answer text, and returns a chat-shaped
    ModelResponse. Without the Responses path in ``copilotkit_stream`` there is
    no reasoning at all on OpenAI.

    Bus path, so the MULTISET of reasoning deltas is asserted (see the module
    docstring). Their exact concatenation is asserted on the deterministic frame
    path by ``test_responses_reasoning_closes_before_tool_call_e2e``."""
    flow = _FakeFlow()
    ep.FastAPICrewFlowEventListener()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        result = await copilotkit_stream(
            _FakeResponsesStream(_reasoning_then_text_events())
        )
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    types = [e.type for e in items]
    assert EventType.REASONING_START in types
    assert EventType.REASONING_MESSAGE_START in types
    assert EventType.REASONING_MESSAGE_END in types
    assert EventType.REASONING_END in types
    assert Counter(
        e.delta for e in items if e.type == EventType.REASONING_MESSAGE_CONTENT
    ) == Counter(["Weighing the ", "options."])
    # One reasoning message id across every delta: a fresh id per delta would
    # split one trace into a message per token on the client.
    assert len({
        e.message_id for e in items
        if e.type == EventType.REASONING_MESSAGE_CONTENT
    }) == 1
    text = "".join(
        e.delta for e in items if e.type == EventType.TEXT_MESSAGE_CHUNK
    )
    assert text == "Answer"

    assert result.choices[0].message.content == "Answer"
    assert result.choices[0].finish_reason == "stop"
    assert result.model == "gpt-5.4"


@requires_responses_types
async def test_copilotkit_stream_responses_tool_call_round_trip():
    """A Responses function call streams as TOOL_CALL_CHUNK under its ``call_id``
    (what a later ``function_call_output`` must reference), closes reasoning
    first, and lands on the returned message's ``tool_calls``.

    Bus path, so the streamed argument fragments are asserted as a MULTISET (see
    the module docstring); their exact concatenation is asserted on the
    deterministic frame path by
    ``test_responses_reasoning_closes_before_tool_call_e2e``. The REASSEMBLED
    arguments on the returned message are order-critical and asserted exactly
    below, because ``copilotkit_stream`` builds them synchronously."""
    events = [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        _summary_delta("Picking a gradient."),
        OutputItemAddedEvent(
            type="response.output_item.added",
            output_index=1,
            item={
                "id": "fc_1",
                "call_id": "call_abc",
                "type": "function_call",
                "name": "change_background",
                "arguments": "",
            },
        ),
        FunctionCallArgumentsDeltaEvent(
            type="response.function_call_arguments.delta",
            item_id="fc_1", output_index=1, delta='{"background":',
        ),
        FunctionCallArgumentsDeltaEvent(
            type="response.function_call_arguments.delta",
            item_id="fc_1", output_index=1, delta='"red"}',
        ),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ]
    flow = _FakeFlow()
    ep.FastAPICrewFlowEventListener()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        result = await copilotkit_stream(_FakeResponsesStream(events))
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    chunks = [e for e in items if e.type == EventType.TOOL_CALL_CHUNK]
    assert chunks, [e.type for e in items]
    assert {c.tool_call_id for c in chunks} == {"call_abc"}
    assert {c.tool_call_name for c in chunks} == {"change_background"}
    # The opening chunk carries the name with empty args, then one chunk per
    # argument fragment.
    assert Counter(c.delta or "" for c in chunks) == Counter(
        ["", '{"background":', '"red"}']
    )
    # Reasoning closed: the tool call is not swallowed into the reasoning message.
    assert EventType.REASONING_END in [e.type for e in items]

    tool_calls = result.choices[0].message.tool_calls
    assert len(tool_calls) == 1
    assert tool_calls[0].id == "call_abc"
    assert tool_calls[0].function.name == "change_background"
    assert tool_calls[0].function.arguments == '{"background":"red"}'
    assert result.choices[0].finish_reason == "tool_calls"


@requires_responses_types
async def test_copilotkit_stream_responses_tool_call_item_as_object():
    """A function call streams even when ``item`` arrives as an OBJECT, not a dict.

    Real OpenAI delivers ``output_item.added``'s ``item`` as a
    ``BaseLiteLLMOpenAIResponseObject`` (litellm builds the event by construction,
    not dict validation). Gating on ``isinstance(item, dict)`` dropped every such
    call and returned a reasoning-only message; the item must be read by attribute
    as well as by key."""
    from types import SimpleNamespace

    item = SimpleNamespace(
        id="fc_1",
        call_id="call_abc",
        type="function_call",
        name="change_background",
        arguments="",
    )
    events = [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        OutputItemAddedEvent.model_construct(
            type="response.output_item.added", output_index=0, item=item
        ),
        FunctionCallArgumentsDeltaEvent(
            type="response.function_call_arguments.delta",
            item_id="fc_1", output_index=0, delta='{"background":"red"}',
        ),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ]
    flow = _FakeFlow()
    ep.FastAPICrewFlowEventListener()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        result = await copilotkit_stream(_FakeResponsesStream(events))
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    chunks = [e for e in items if e.type == EventType.TOOL_CALL_CHUNK]
    assert chunks, [e.type for e in items]
    assert {c.tool_call_id for c in chunks} == {"call_abc"}
    assert {c.tool_call_name for c in chunks} == {"change_background"}

    tool_calls = result.choices[0].message.tool_calls
    assert len(tool_calls) == 1
    assert tool_calls[0].id == "call_abc"
    assert tool_calls[0].function.name == "change_background"
    assert tool_calls[0].function.arguments == '{"background":"red"}'
    assert result.choices[0].finish_reason == "tool_calls"


@requires_responses_types
async def test_copilotkit_stream_responses_failure_raises():
    """A failed Responses stream raises rather than returning an empty message, so
    the drivers' RUN_ERROR taxonomy reports it."""
    events = [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        GenericEvent(type="error", code="server_error", message="upstream exploded"),
    ]
    with pytest.raises(RuntimeError, match="upstream exploded"):
        await copilotkit_stream(_FakeResponsesStream(events))


@requires_responses_types
async def test_copilotkit_stream_responses_closes_reasoning_on_error():
    """A stream that raises mid-reasoning still closes the reasoning message, so no
    half-open lifecycle reaches the client."""

    class _Boom(_FakeResponsesStream):
        async def __anext__(self):
            if not self._events:
                raise ValueError("stream died")
            return self._events.pop(0)

    flow = _FakeFlow()
    ep.FastAPICrewFlowEventListener()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        with pytest.raises(ValueError, match="stream died"):
            await copilotkit_stream(_Boom([_summary_delta("half a thought")]))
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    types = [e.type for e in items]
    assert EventType.REASONING_MESSAGE_END in types, types
    assert EventType.REASONING_END in types, types


async def test_copilotkit_stream_rejects_unknown_response_type():
    """A response that is neither a ModelResponse, a CustomStreamWrapper nor a
    Responses stream still raises, so the new branch did not widen the gate."""
    with pytest.raises(ValueError, match="Invalid response type"):
        await copilotkit_stream(object())


def test_is_responses_stream_rejects_chat_stream():
    """The chat-completions wrapper must not be routed to the Responses driver."""

    async def _gen():  # pragma: no cover - never iterated
        yield _chunk("m1", content="x")

    assert responses_mod.is_responses_stream(_FakeStreamWrapper(_gen())) is False
    assert responses_mod.is_responses_stream(_FakeResponsesStream([])) is True


requires_responses_iterator_base = pytest.mark.skipif(
    responses_mod.ResponsesAPIStreamingIteratorBase is None,
    reason="litellm exposes no BaseResponsesAPIStreamingIterator to subclass",
)


def _sync_responses_iterator(events=()):
    """A SYNCHRONOUS Responses iterator, shaped like litellm's own.

    ``SyncResponsesAPIStreamingIterator`` subclasses the SAME
    ``BaseResponsesAPIStreamingIterator`` the async one does but exposes
    ``__iter__`` only, so an isinstance-only probe cannot tell the two apart.
    """
    base = responses_mod.ResponsesAPIStreamingIteratorBase

    class _SyncResponsesStream(base):  # pylint: disable=too-few-public-methods
        def __init__(self, items):  # pylint: disable=super-init-not-called
            self._events = list(items)

        def __iter__(self):
            return self

        def __next__(self):
            if not self._events:
                raise StopIteration
            return self._events.pop(0)

        def _process_chunk(self, chunk):  # pragma: no cover - probe target only
            return None

    return _SyncResponsesStream(events)


def _async_responses_iterator(events=()):
    """An ASYNC Responses iterator that subclasses litellm's real base class."""
    base = responses_mod.ResponsesAPIStreamingIteratorBase

    class _AsyncResponsesStream(base):  # pylint: disable=too-few-public-methods
        def __init__(self, items):  # pylint: disable=super-init-not-called
            self._events = list(items)

        def __aiter__(self):
            return self

        async def __anext__(self):
            if not self._events:
                raise StopAsyncIteration
            return self._events.pop(0)

        def _process_chunk(self, chunk):  # pragma: no cover - probe target only
            return None

    return _AsyncResponsesStream(events)


@requires_responses_iterator_base
def test_is_responses_stream_rejects_sync_iterator():
    """A synchronous Responses iterator is NOT usable by the async driver.

    It shares the base class with the async one, so an isinstance-only check
    would route it into ``_copilotkit_stream_responses`` and die there on a
    missing ``__aiter__``.
    """
    assert responses_mod.is_responses_stream(_sync_responses_iterator()) is False


def test_is_responses_stream_rejects_duck_typed_sync_iterator():
    """The duck-typed branch agrees: ``_process_chunk`` without ``__aiter__`` is
    not an async Responses stream."""

    class _DuckSync:  # pylint: disable=too-few-public-methods
        def __iter__(self):  # pragma: no cover - probe target only
            return iter(())

        def _process_chunk(self, chunk):  # pragma: no cover - probe target only
            return None

    assert responses_mod.is_responses_stream(_DuckSync()) is False


@requires_responses_iterator_base
def test_is_responses_stream_accepts_async_iterator_subclass():
    """The async iterator, matched through the base class, is still accepted."""
    assert responses_mod.is_responses_stream(_async_responses_iterator()) is True


@requires_responses_iterator_base
async def test_copilotkit_stream_rejects_sync_responses_iterator():
    """A sync Responses stream raises the SAME ``ValueError`` as any other
    unusable response type, naming the async entrypoint, instead of an
    ``AttributeError`` from the async driver."""
    with pytest.raises(ValueError) as excinfo:
        await copilotkit_stream(_sync_responses_iterator())
    message = str(excinfo.value)
    assert "synchronous" in message, message
    assert "copilotkit_responses" in message, message


@requires_responses_types
@requires_responses_iterator_base
async def test_copilotkit_stream_routes_async_responses_iterator():
    """An async Responses iterator still reaches the Responses driver and returns
    the chat-shaped result."""
    result = await copilotkit_stream(
        _async_responses_iterator(_reasoning_then_text_events())
    )
    assert result.choices[0].message.content == "Answer"


async def test_copilotkit_stream_routes_chat_wrapper_to_chat_driver(monkeypatch):
    """A chat-completions ``CustomStreamWrapper`` keeps going to the chat driver:
    tightening the Responses probe must not steal or reroute it."""

    async def _unreachable(response):  # pragma: no cover - must not be called
        raise AssertionError("chat stream was routed to the Responses driver")

    monkeypatch.setattr(sdk_mod, "_copilotkit_stream_responses", _unreachable)

    async def _gen():
        yield _chunk("m1", content="hello")
        yield _chunk("m1", finish_reason="stop")

    result = await copilotkit_stream(_FakeStreamWrapper(_gen()))
    assert result.choices[0].message.content == "hello"


# -- input / tool conversion ----------------------------------------------

def test_chat_tools_to_responses_tools_flattens():
    """The nested chat-completions tool spec is flattened, and ``strict`` is opted
    out so a schema written for chat-completions is still accepted."""
    converted = responses_mod.chat_tools_to_responses_tools([
        {
            "type": "function",
            "function": {
                "name": "change_background",
                "description": "d",
                "parameters": {"type": "object", "properties": {"b": {"type": "string"}}},
            },
        }
    ])
    assert converted == [
        {
            "type": "function",
            "name": "change_background",
            "description": "d",
            "parameters": {"type": "object", "properties": {"b": {"type": "string"}}},
            "strict": False,
        }
    ]
    assert responses_mod.chat_tools_to_responses_tools([]) is None
    assert responses_mod.chat_tools_to_responses_tools(None) is None


def test_chat_messages_to_responses_input_tool_round_trip():
    """An assistant tool call becomes a ``function_call`` and its tool message the
    matching ``function_call_output``, keyed by the same ``call_id``."""
    items = responses_mod.chat_messages_to_responses_input([
        {"role": "system", "content": "be helpful"},
        {"role": "user", "content": "make it red"},
        {
            "role": "assistant",
            "content": "sure",
            "tool_calls": [
                {
                    "id": "call_abc",
                    "type": "function",
                    "function": {"name": "change_background", "arguments": '{"b":"red"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_abc", "content": "done"},
    ])
    assert items == [
        {"role": "system", "content": "be helpful"},
        {"role": "user", "content": "make it red"},
        {"role": "assistant", "content": "sure"},
        {
            "type": "function_call",
            "call_id": "call_abc",
            "name": "change_background",
            "arguments": '{"b":"red"}',
        },
        {"type": "function_call_output", "call_id": "call_abc", "output": "done"},
    ]


@pytest.mark.parametrize("encrypted_key", ["encrypted_value", "encryptedValue"])
def test_chat_messages_to_responses_input_replays_reasoning_item_in_order(
    encrypted_key,
):
    """A client-held reasoning message reconstructs the provider output item.

    Position is part of the Responses contract: the reasoning item belongs
    between the prior user input and the assistant answer it preceded.
    """
    reasoning_message = {
        "id": "rs_replayable",
        "role": "reasoning",
        "content": "Weighing the options.",
        encrypted_key: "ENCRYPTED_STATE",
    }

    items = responses_mod.chat_messages_to_responses_input([
        {"role": "system", "content": "be helpful"},
        {"role": "user", "content": "Which option?"},
        reasoning_message,
        {"role": "assistant", "content": "Choose A."},
        {"role": "user", "content": "Why?"},
    ])

    assert items == [
        {"role": "system", "content": "be helpful"},
        {"role": "user", "content": "Which option?"},
        {
            "id": "rs_replayable",
            "type": "reasoning",
            "summary": [
                {"type": "summary_text", "text": "Weighing the options."}
            ],
            "encrypted_content": "ENCRYPTED_STATE",
        },
        {"role": "assistant", "content": "Choose A."},
        {"role": "user", "content": "Why?"},
    ]
    _assert_valid_responses_input(items)


def test_chat_messages_to_responses_input_keeps_empty_reasoning_summary():
    """An id-only reasoning message remains replayable with an empty summary."""
    items = responses_mod.chat_messages_to_responses_input([
        {"id": "rs_empty", "role": "reasoning", "content": ""},
    ])

    assert items == [
        {"id": "rs_empty", "type": "reasoning", "summary": []},
    ]
    _assert_valid_responses_input(items)


def test_chat_messages_to_responses_input_rejects_reasoning_without_provider_id():
    """A generated or missing id cannot refer back to OpenAI's reasoning item."""
    with pytest.raises(ValueError, match="reasoning message.*provider item id"):
        responses_mod.chat_messages_to_responses_input([
            {"role": "reasoning", "content": "orphaned"},
        ])


def test_chat_messages_to_responses_input_drops_unresolved_call():
    """A tool call whose output never arrived is dropped: the Responses API rejects
    the whole request over one unmatched call, which would break every later turn."""
    items = responses_mod.chat_messages_to_responses_input([
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_orphan",
                    "type": "function",
                    "function": {"name": "change_background", "arguments": "{}"},
                }
            ],
        },
    ])
    assert items == [{"role": "user", "content": "hi"}]


def test_chat_messages_to_responses_input_multimodal():
    """Multimodal user content is converted to Responses input parts.

    ``detail`` is carried because the Responses input-image part requires it;
    ``auto`` is the value the API itself defaults to, so nothing changes about
    what the model sees.
    """
    items = responses_mod.chat_messages_to_responses_input([
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "what is this"},
                {"type": "image_url", "image_url": {"url": "https://x/y.png"}},
            ],
        }
    ])
    assert items == [
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": "what is this"},
                {"type": "input_image", "image_url": "https://x/y.png", "detail": "auto"},
            ],
        }
    ]
    _assert_valid_responses_input(items)


def _assert_valid_responses_input(items):
    """Validate ``items`` against the Responses ``input`` contract.

    The union comes from the openai types litellm re-exports (litellm types its
    own ``input`` as ``ResponseInputParam``), so this asserts the shape the API
    is handed, not a hand-rolled idea of it.
    """
    from pydantic import TypeAdapter

    response_input_param = _responses_symbol(
        "litellm.types.llms.openai", "ResponseInputParam"
    )
    TypeAdapter(response_input_param).validate_python(items)


def test_chat_messages_to_responses_input_tool_pair_is_accepted_by_openai_types():
    """A round trip: an assistant tool call plus its result convert to a
    ``function_call`` / ``function_call_output`` pair the Responses input union
    accepts, with the arguments as the JSON string the API requires."""
    items = responses_mod.chat_messages_to_responses_input([
        {"role": "user", "content": "make it red"},
        {
            "role": "assistant",
            "content": "on it",
            "tool_calls": [
                {
                    "id": "call_abc",
                    "type": "function",
                    "function": {"name": "change_background", "arguments": '{"b":"red"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_abc", "content": "done"},
    ])
    assert items[-2:] == [
        {
            "type": "function_call",
            "call_id": "call_abc",
            "name": "change_background",
            "arguments": '{"b":"red"}',
        },
        {"type": "function_call_output", "call_id": "call_abc", "output": "done"},
    ]
    # Last: the union validation is the one step a litellm without the Responses
    # types cannot run, and it skips the test when it cannot. Everything this test
    # can assert on such a build has already been asserted above.
    _assert_valid_responses_input(items)


def test_chat_messages_to_responses_input_drops_orphan_output(caplog):
    """An output with no matching call is dropped, the mirror of dropping a call
    with no output: the Responses API rejects either shape."""
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._responses"):
        items = responses_mod.chat_messages_to_responses_input([
            {"role": "user", "content": "hi"},
            {"role": "tool", "tool_call_id": "call_ghost", "content": "done"},
        ])
    assert items == [{"role": "user", "content": "hi"}]
    assert any("call_ghost" in r.getMessage() for r in caplog.records), caplog.text
    _assert_valid_responses_input(items)


def test_chat_messages_to_responses_input_drops_output_of_a_dropped_call(caplog):
    """Dropping a malformed call must not leave its output behind: the drop that
    protects the request would otherwise create the shape it protects against."""
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._responses"):
        items = responses_mod.chat_messages_to_responses_input([
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "content": "",
                # No function name: this call cannot be emitted at all.
                "tool_calls": [{"id": "call_nameless", "type": "function", "function": {}}],
            },
            {"role": "tool", "tool_call_id": "call_nameless", "content": "done"},
        ])
    assert items == [{"role": "user", "content": "hi"}]
    _assert_valid_responses_input(items)


def test_tool_call_arguments_are_serialised_when_not_a_string(caplog):
    """Non-string arguments (a dict, as some providers produce) are serialised,
    not discarded: emptying them would silently change what the model is told
    it called."""
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._responses"):
        items = responses_mod.chat_messages_to_responses_input([
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_abc",
                        "type": "function",
                        "function": {"name": "change_background", "arguments": {"b": "red"}},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_abc", "content": "done"},
        ])
    call = next(item for item in items if item.get("type") == "function_call")
    assert _json.loads(call["arguments"]) == {"b": "red"}
    assert any("arguments" in r.getMessage() for r in caplog.records), caplog.text
    _assert_valid_responses_input(items)


def test_assistant_content_parts_are_not_emitted_as_input_parts(caplog):
    """Assistant content parts cannot ride the input-part shape: no Responses
    input item accepts ``input_text`` under the assistant role, so the parts
    collapse onto the string content that item does accept, and a part with no
    assistant representation is dropped with a log."""
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._responses"):
        items = responses_mod.chat_messages_to_responses_input([
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "here it is"},
                    {"type": "image_url", "image_url": {"url": "https://x/y.png"}},
                ],
            },
        ])
    assert items == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "here it is"},
    ]
    assert any("image" in r.getMessage().lower() for r in caplog.records), caplog.text
    _assert_valid_responses_input(items)


def test_tool_message_dict_content_is_json_not_a_python_repr():
    """A tool result that is not a string is serialised as JSON. ``str()`` would
    hand the model a single-quoted Python repr no JSON parser accepts, the same
    hazard the backend_tool_rendering example documents for crewai."""
    items = responses_mod.chat_messages_to_responses_input([
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call_abc", "type": "function", "function": {"name": "w", "arguments": "{}"}}
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_abc",
            "content": {"temperature": 20, "conditions": "sunny", "ok": True},
        },
    ])
    output = next(item for item in items if item.get("type") == "function_call_output")["output"]
    assert _json.loads(output) == {"temperature": 20, "conditions": "sunny", "ok": True}
    assert "'" not in output
    _assert_valid_responses_input(items)


async def test_copilotkit_responses_requires_the_channel(monkeypatch):
    """With no ``aresponses`` entrypoint the helper raises a named error instead of
    silently answering with no trace."""
    monkeypatch.setattr(responses_mod, "responses_entrypoint", lambda: None)
    with pytest.raises(RuntimeError, match="aresponses"):
        await responses_mod.copilotkit_responses(
            model="openai/gpt-5.4", messages=[{"role": "user", "content": "hi"}]
        )


def _capture_responses_calls(monkeypatch):
    """Install a no-network Responses entrypoint and return its call list."""
    calls = []

    async def _fake_entrypoint(**kwargs):
        calls.append(kwargs)
        return _FakeResponsesStream([])

    monkeypatch.setattr(responses_mod, "responses_entrypoint", lambda: _fake_entrypoint)
    return calls


async def test_copilotkit_responses_passes_reasoning_and_stream(monkeypatch):
    """The helper streams, converts messages + tools, and forwards ``reasoning``
    verbatim: without a ``summary`` OpenAI emits no reasoning deltas at all."""
    calls = _capture_responses_calls(monkeypatch)
    await responses_mod.copilotkit_responses(
        model="openai/gpt-5.4",
        messages=[{"role": "user", "content": "hi"}],
        tools=[{"type": "function", "function": {"name": "t", "parameters": {}}}],
        reasoning={"effort": "medium", "summary": "auto"},
    )
    captured = calls[0]
    assert captured["stream"] is True
    assert captured["model"] == "openai/gpt-5.4"
    assert captured["input"] == [{"role": "user", "content": "hi"}]
    assert captured["reasoning"] == {"effort": "medium", "summary": "auto"}
    assert captured["tools"][0]["name"] == "t"


async def test_copilotkit_responses_replays_reasoning_in_stateless_mode(monkeypatch):
    """A two-turn tool flow replays object-shaped encrypted reasoning in order."""
    turn_one, wire_events = await _drive_responses([
        _summary_delta("Weighing the options.", item_id="rs_turn_1"),
        _reasoning_item_done_object("TURN_1_STATE", item_id="rs_turn_1"),
        _function_call_added(arguments="{}"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])
    start_events = [
        event for event in wire_events if event.type == EventType.REASONING_START
    ]
    content_events = [
        event
        for event in wire_events
        if event.type == EventType.REASONING_MESSAGE_CONTENT
    ]
    encrypted_events = [
        event
        for event in wire_events
        if event.type == EventType.REASONING_ENCRYPTED_VALUE
    ]
    assert len(start_events) == 1
    assert len(encrypted_events) == 1
    reasoning_message = {
        "id": start_events[0].message_id,
        "role": "reasoning",
        "content": "".join(event.delta for event in content_events),
        "encrypted_value": encrypted_events[0].encrypted_value,
    }
    calls = _capture_responses_calls(monkeypatch)

    await responses_mod.copilotkit_responses(
        model="openai/gpt-5.4",
        store=False,
        messages=[
            {"role": "user", "content": "Which option?"},
            reasoning_message,
            turn_one.choices[0].message,
            {"role": "tool", "tool_call_id": "call_abc", "content": "done"},
            {"role": "user", "content": "Why?"},
        ],
    )

    assert calls[0]["input"] == [
        {"role": "user", "content": "Which option?"},
        {
            "id": "rs_turn_1",
            "type": "reasoning",
            "summary": [
                {"type": "summary_text", "text": "Weighing the options."}
            ],
            "encrypted_content": "TURN_1_STATE",
        },
        {
            "type": "function_call",
            "call_id": "call_abc",
            "name": "change_background",
            "arguments": "{}",
        },
        {"type": "function_call_output", "call_id": "call_abc", "output": "done"},
        {"role": "user", "content": "Why?"},
    ]
    _assert_valid_responses_input(calls[0]["input"])
    assert calls[0]["store"] is False


async def test_copilotkit_responses_stateless_explicit_input_still_wins(monkeypatch):
    """Raw stateless input remains an intentional escape hatch."""
    calls = _capture_responses_calls(monkeypatch)

    def _must_not_convert_history(_messages):
        raise AssertionError("explicit raw input converted historical messages")

    monkeypatch.setattr(
        responses_mod,
        "chat_messages_to_responses_input",
        _must_not_convert_history,
    )
    raw_input = "new input"
    await responses_mod.copilotkit_responses(
        model="openai/gpt-5.4",
        messages=[{"role": "user", "content": "historical"}],
        input=raw_input,
    )

    assert calls[0]["input"] == raw_input


async def test_copilotkit_responses_stored_mode_sends_only_explicit_new_input(
    monkeypatch,
):
    """``previous_response_id`` and replayed history are alternative modes."""
    calls = _capture_responses_calls(monkeypatch)

    def _must_not_convert_history(_messages):
        raise AssertionError("stored continuation converted historical messages")

    monkeypatch.setattr(
        responses_mod,
        "chat_messages_to_responses_input",
        _must_not_convert_history,
    )
    new_input = [{"role": "user", "content": "Why?"}]
    await responses_mod.copilotkit_responses(
        model="openai/gpt-5.4",
        messages=[
            {"id": "rs_old", "role": "reasoning", "content": "old trace"},
        ],
        previous_response_id="resp_turn_1",
        input=new_input,
    )

    assert calls[0]["input"] is new_input
    assert calls[0]["previous_response_id"] == "resp_turn_1"
    assert calls[0]["stream"] is True


@pytest.mark.parametrize("previous_response_id", ["resp_turn_1", ""])
async def test_copilotkit_responses_stored_mode_requires_explicit_input(
    monkeypatch,
    previous_response_id,
):
    """Stored continuation never guesses that converted history is new input."""
    calls = _capture_responses_calls(monkeypatch)

    with pytest.raises(ValueError, match="previous_response_id.*explicit.*input"):
        await responses_mod.copilotkit_responses(
            model="openai/gpt-5.4",
            messages=[{"role": "user", "content": "historical"}],
            previous_response_id=previous_response_id,
        )

    assert calls == []


@pytest.mark.parametrize(
    "reasoning_item",
    [
        {"id": "rs_old", "type": "reasoning", "summary": []},
        SimpleNamespace(id="rs_old", type="reasoning", summary=[]),
    ],
)
async def test_copilotkit_responses_stored_mode_rejects_replayed_reasoning(
    monkeypatch,
    reasoning_item,
):
    """Mixing stored continuation with a replayed item would duplicate state."""
    calls = _capture_responses_calls(monkeypatch)

    with pytest.raises(ValueError, match="previous_response_id.*reasoning"):
        await responses_mod.copilotkit_responses(
            model="openai/gpt-5.4",
            messages=[],
            previous_response_id="resp_turn_1",
            input=[reasoning_item, {"role": "user", "content": "Why?"}],
        )

    assert calls == []


# -- the demo picks the channel that actually carries OpenAI reasoning -----

class _ChannelSpy:
    """Records which channel the reasoning demo opened for a provider choice.

    Both channels are faked, and the Responses PROBE is pinned live. The demo
    routes OpenAI on ``responses_channel_available()``, so without the pin the
    branch under test depends on the installed litellm: on a build without
    ``aresponses`` the demo correctly degrades to chat-completions and every
    assertion about the Responses branch reports that supported degrade as a
    failure. Pinning makes the branch deterministic without weakening anything:
    the probe's own effect is asserted by
    ``test_reasoning_demo_degrades_without_the_responses_channel`` (which pins it
    dark, after this constructor, and asserts the fallback) and by
    ``test_responses_channel_capability_follows_the_probe``. A test that wants the
    dark branch overrides the pin the same way.
    """

    def __init__(self, monkeypatch, *, channel_available=True):
        # ``channel_available=None`` leaves the REAL probe in place, so a test
        # can exercise the registry -> probe -> degrade chain end to end.
        self.chat_calls = []
        self.responses_calls = []
        import ag_ui_crewai.examples.agentic_chat_reasoning as demo

        async def _fake_acompletion(**kwargs):
            self.chat_calls.append(kwargs)

            async def _gen():
                yield _chunk("m1", content="plain answer")
                yield _chunk("m1", finish_reason="stop")

            return _FakeStreamWrapper(_gen())

        async def _fake_responses(**kwargs):
            self.responses_calls.append(kwargs)
            return _FakeResponsesStream(_reasoning_then_text_events())

        monkeypatch.setattr(demo, "acompletion", _fake_acompletion)
        monkeypatch.setattr(demo, "copilotkit_responses", _fake_responses)
        if channel_available is not None:
            monkeypatch.setattr(
                demo, "responses_channel_available", lambda: channel_available
            )


async def _drive_reasoning_demo(model, *, messages=None):
    state_messages = [] if messages is None else messages
    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=AgenticChatReasoningFlow(),
        encoder=EventEncoder(),
        input_data=_run_input(),
        inputs={
            "id": "t-1",
            "model": model,
            "messages": state_messages,
            "copilotkit": {"actions": []},
        },
        timeout=30.0,
    )))
    return payloads


@requires_stream_frames
@requires_responses_types
async def test_reasoning_demo_openai_surfaces_a_trace(monkeypatch):
    """Selecting OpenAI streams over the Responses channel and surfaces a real
    thinking trace. This is the reported defect: routed to chat-completions
    (``acompletion``) OpenAI returns no reasoning content, so no REASONING_* is
    emitted and this fails.

    ``_ChannelSpy`` pins the Responses probe live, so this asserts the routing and
    the projection on every litellm rather than depending on the installed build's
    channel."""
    spy = _ChannelSpy(monkeypatch)
    payloads = await _drive_reasoning_demo("OpenAI")
    types = [p["type"] for p in payloads]

    assert spy.responses_calls, "OpenAI must not stream over chat-completions"
    assert spy.chat_calls == []
    # A summary is what makes OpenAI stream reasoning deltas at all.
    assert spy.responses_calls[0]["reasoning"].get("summary")

    assert "REASONING_START" in types, types
    trace = "".join(
        p["delta"] for p in payloads if p["type"] == "REASONING_MESSAGE_CONTENT"
    )
    assert trace == "Weighing the options."
    first_text = types.index("TEXT_MESSAGE_START")
    assert types.index("REASONING_END") < first_text


@requires_stream_frames
@pytest.mark.parametrize("provider", ["Anthropic", "Gemini"])
async def test_reasoning_demo_keeps_chat_completions_channel(monkeypatch, provider):
    """Anthropic and Gemini reason on the chat-completions delta and MUST keep
    streaming through ``acompletion``: the Responses path is additive, not a
    replacement."""
    spy = _ChannelSpy(monkeypatch)
    await _drive_reasoning_demo(provider)
    assert spy.responses_calls == []
    assert len(spy.chat_calls) == 1
    assert spy.chat_calls[0]["stream"] is True


@requires_stream_frames
@pytest.mark.parametrize("provider", ["Anthropic", "Gemini"])
async def test_reasoning_demo_omits_replayed_reasoning_from_chat_completions(
    monkeypatch,
    provider,
):
    """AG-UI reasoning history is not a valid chat-completions message role."""
    spy = _ChannelSpy(monkeypatch)
    await _drive_reasoning_demo(
        provider,
        messages=[
            {"id": "user-1", "role": "user", "content": "Start"},
            {"id": "rs-1", "role": "reasoning", "content": "private trace"},
            {"id": "assistant-1", "role": "assistant", "content": "Answer"},
            {"id": "user-2", "role": "user", "content": "Follow up"},
        ],
    )

    assert [message["role"] for message in spy.chat_calls[0]["messages"]] == [
        "system",
        "user",
        "assistant",
        "user",
    ]


@requires_stream_frames
async def test_reasoning_demo_degrades_without_the_responses_channel(monkeypatch):
    """With the Responses channel unavailable, OpenAI falls back to
    chat-completions rather than raising."""
    import ag_ui_crewai.examples.agentic_chat_reasoning as demo

    spy = _ChannelSpy(monkeypatch)
    # After the spy: it pins the probe live, and this test owns the dark branch.
    monkeypatch.setattr(demo, "responses_channel_available", lambda: False)
    payloads = await _drive_reasoning_demo(
        "OpenAI",
        messages=[
            {"id": "rs-1", "role": "reasoning", "content": "private trace"},
            {"id": "user-2", "role": "user", "content": "Follow up"},
        ],
    )
    assert spy.responses_calls == []
    assert len(spy.chat_calls) == 1
    assert [message["role"] for message in spy.chat_calls[0]["messages"]] == [
        "system",
        "user",
    ]
    assert "RUN_ERROR" not in [p["type"] for p in payloads]


# -- capability declaration ------------------------------------------------

def test_responses_channel_capability_follows_the_probe(monkeypatch):
    """Drive the Responses probe to BOTH states and assert the declaration and the
    runtime selector callers gate on move together.

    Not a restatement of the field it is built from: a hard-coded value, or a
    declaration sourced from somewhere other than what
    ``responses_channel_available`` reads, fails one leg."""
    import ag_ui_crewai._capabilities as caps

    for probe_state in (True, False):
        monkeypatch.setattr(caps, "_responses_api_available", probe_state)
        monkeypatch.setattr(caps, "CAPABILITIES", caps._detect())
        monkeypatch.setattr(responses_mod, "CAPABILITIES", caps.CAPABILITIES)
        block = caps.get_capabilities()["reasoning"]
        assert block["responsesApiChannel"] is probe_state
        assert responses_mod.responses_channel_available() is probe_state
        assert block["requiresEmitRawEvents"] is False


@pytest.mark.parametrize(
    "litellm_live,thinking_live,responses_live",
    [
        (True, True, True),
        (True, False, False),
        (False, True, False),
        (False, False, True),
        (False, False, False),
    ],
)
def test_reasoning_block_cannot_self_contradict(
    monkeypatch, litellm_live, thinking_live, responses_live
):
    """Whatever resolved, the block agrees with itself.

    Every channel field comes from ONE snapshot and ``supported`` / ``reason`` are
    derived from those three fields, so no single-probe patch can make the block
    advertise a channel it also reports absent, claim support with every channel
    dark, or hand back a ``reason`` that contradicts ``supported``. Sourcing one
    field from a live module global while another comes from the snapshot breaks
    this."""
    import ag_ui_crewai._capabilities as caps

    monkeypatch.setattr(caps, "_litellm_available", litellm_live)
    monkeypatch.setattr(caps, "_thinking_event_available", thinking_live)
    monkeypatch.setattr(caps, "_responses_api_available", responses_live)
    monkeypatch.setattr(caps, "CAPABILITIES", caps._detect())

    # One probe, one value: the snapshot's native-event field is that same probe,
    # not a stale copy taken at import.
    assert caps.CAPABILITIES.native_reasoning_event_available is thinking_live

    block = caps._reasoning_capability()
    assert block["litellmChannel"] is litellm_live
    assert block["thinkingEventAvailable"] is thinking_live
    assert block["responsesApiChannel"] is responses_live

    expected_supported = caps.any_reasoning_channel(
        litellm_available=block["litellmChannel"],
        thinking_event_available=block["thinkingEventAvailable"],
        responses_api_available=block["responsesApiChannel"],
    )
    assert block["supported"] is expected_supported
    assert block["supported"] is caps.CAPABILITIES.reasoning_available
    assert (block["reason"] is None) is expected_supported


def test_reasoning_unavailable_reason_names_the_all_channels_absent_condition(monkeypatch):
    """Reasoning drops out only when ALL THREE channels are absent, so the reason
    must report that condition instead of pinning it on litellm."""
    import ag_ui_crewai._capabilities as caps

    monkeypatch.setattr(caps, "_litellm_available", False)
    monkeypatch.setattr(caps, "_thinking_event_available", False)
    monkeypatch.setattr(caps, "_responses_api_available", False)
    monkeypatch.setattr(caps, "CAPABILITIES", caps._detect())

    block = caps._reasoning_capability()
    assert block["supported"] is False
    assert block["reason"] == "no_reasoning_channel_available"
    assert "litellm" not in block["reason"]


@pytest.mark.parametrize(
    "litellm_live,thinking_live,responses_live,expected",
    [
        (False, False, False, False),
        (True, False, False, True),
        (False, True, False, True),
        (False, False, True, True),
        (True, True, True, True),
    ],
)
def test_any_reasoning_channel_rule(litellm_live, thinking_live, responses_live, expected):
    """Reasoning is available whenever ANY channel is live. A build with ONLY the
    Responses channel must still report supported; narrowing the rule to the
    litellm channel makes the (False, False, True) case fail."""
    from ag_ui_crewai._capabilities import any_reasoning_channel

    assert (
        any_reasoning_channel(
            litellm_available=litellm_live,
            thinking_event_available=thinking_live,
            responses_api_available=responses_live,
        )
        is expected
    )


def test_capability_snapshot_reports_reasoning_from_every_channel(monkeypatch):
    """The snapshot recomputes availability from the LIVE probes, so a build where
    only the Responses channel resolved still reports reasoning available.
    Hard-wiring the snapshot to the litellm channel makes this fail."""
    import ag_ui_crewai._capabilities as caps

    monkeypatch.setattr(caps, "_litellm_available", False)
    monkeypatch.setattr(caps, "_thinking_event_available", False)
    monkeypatch.setattr(caps, "_responses_api_available", True)
    snapshot = caps._detect()
    assert snapshot.reasoning_available is True
    assert snapshot.responses_api_available is True

    monkeypatch.setattr(caps, "_responses_api_available", False)
    assert caps._detect().reasoning_available is False


class _ResponsesToolCallFlow(Flow):
    """A real Flow streaming a Responses tool-call turn (reasoning summary, then
    the function call), driven through ``copilotkit_stream``.

    Both the summary and the call arguments arrive in MULTIPLE deltas so the
    frame-path test below can assert their exact concatenation."""

    @start()
    async def chat(self):
        await copilotkit_stream(_FakeResponsesStream([
            ResponseCreatedEvent(
                type="response.created", response=_responses_api_response("in_progress")
            ),
            _summary_delta("Picking "),
            _summary_delta("a gradient."),
            OutputItemAddedEvent(
                type="response.output_item.added",
                output_index=1,
                item={
                    "id": "fc_1",
                    "call_id": "call_abc",
                    "type": "function_call",
                    "name": "change_background",
                    "arguments": "",
                },
            ),
            FunctionCallArgumentsDeltaEvent(
                type="response.function_call_arguments.delta",
                item_id="fc_1", output_index=1, delta='{"background":',
            ),
            FunctionCallArgumentsDeltaEvent(
                type="response.function_call_arguments.delta",
                item_id="fc_1", output_index=1, delta='"red"}',
            ),
            ResponseCompletedEvent(
                type="response.completed", response=_responses_api_response()
            ),
        ]))
        return "done"


@requires_stream_frames
@requires_responses_types
async def test_responses_reasoning_closes_before_tool_call_e2e():
    """The reasoning message CLOSES before the tool call opens. Deleting the
    ``reasoning.close()`` hook on the function-call branch leaves only the
    ``finally`` to close it, which lands AFTER the tool call, so this fails.

    Also the deterministic home for the ORDER of the streamed fragments: both the
    reasoning summary and the tool-call arguments must reassemble on the wire in
    the order the provider sent them (the bus-path tests can only assert the
    multiset)."""
    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=_ResponsesToolCallFlow(),
        encoder=EventEncoder(),
        input_data=_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    )))
    types = [p["type"] for p in payloads]
    assert "REASONING_END" in types, types
    assert "TOOL_CALL_START" in types, types
    assert types.index("REASONING_END") < types.index("TOOL_CALL_START"), types
    assert types.index("REASONING_MESSAGE_END") < types.index("TOOL_CALL_START"), types

    reasoning_deltas = [
        p["delta"] for p in payloads if p["type"] == "REASONING_MESSAGE_CONTENT"
    ]
    assert len(reasoning_deltas) == 2, payloads
    assert "".join(reasoning_deltas) == "Picking a gradient."
    arg_deltas = [p["delta"] for p in payloads if p["type"] == "TOOL_CALL_ARGS"]
    assert len(arg_deltas) == 2, payloads
    assert "".join(arg_deltas) == '{"background":"red"}'


@requires_stream_frames
@requires_responses_types
async def test_responses_reasoning_only_stream_closes_on_finalize_e2e():
    """A stream carrying reasoning and nothing else still closes its reasoning
    lifecycle, via the driver's ``finally``."""

    class _ReasoningOnlyFlow(Flow):
        @start()
        async def chat(self):
            await copilotkit_stream(_FakeResponsesStream([_summary_delta("only this")]))
            return "done"

    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=_ReasoningOnlyFlow(),
        encoder=EventEncoder(),
        input_data=_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    )))
    types = [p["type"] for p in payloads]
    assert types.index("REASONING_MESSAGE_END") < types.index("REASONING_END")
    assert "RUN_ERROR" not in types, types


# -- one unparseable event: skip the envelope, surface everything else -------
#
# litellm validates each stream event against its own typed model, so a single
# event can fail to parse. Which event it was decides what a skip costs: an
# envelope event carries no payload this bridge maps, but a payload event
# carries answer text / tool-call arguments and a terminal event carries the
# stream's outcome. Parsing is what failed, so the classification cannot read a
# ``type`` off the object; ``ValidationError.title`` (the model litellm
# attempted) and litellm's own "Unknown event type: <type>" ``ValueError`` are
# the signals that remain.

class _ScriptedEventStream(_FakeResponsesStream):
    """Streams a script of events, RAISING any entry that is an exception.

    That is exactly how litellm surfaces a per-event parse failure: it raises
    out of ``__anext__`` for the event it could not build, and the rest of the
    stream is still there to read.
    """

    async def __anext__(self):
        if not self._events:
            raise StopAsyncIteration
        entry = self._events.pop(0)
        if isinstance(entry, BaseException):
            raise entry
        return entry


def _litellm_validation_error(model_name):
    """The ValidationError litellm raises when a provider omits a field the typed
    model for that event requires.

    ``title`` is the model litellm attempted, verified against
    ``OpenAIResponsesAPIConfig.get_event_model_class(...)(**chunk)``: that is the
    only signal identifying the event once parsing has failed.
    """
    return ValidationError.from_exception_data(
        model_name,
        [{"type": "missing", "loc": ("response",), "input": {}}],
    )


def _completed_event():
    return ResponseCompletedEvent(
        type="response.completed", response=_responses_api_response()
    )


def test_litellm_validation_error_title_is_the_attempted_model():
    """The signal the classification rests on, asserted against litellm itself:
    the ValidationError litellm raises for a malformed event is titled after the
    model it tried to build, so the event can be identified without the object."""
    config = _responses_symbol(
        "litellm.llms.openai.responses.transformation", "OpenAIResponsesAPIConfig"
    )

    for event_type, expected_title in (
        ("response.created", "ResponseCreatedEvent"),
        ("response.in_progress", "ResponseInProgressEvent"),
        ("response.output_text.delta", "OutputTextDeltaEvent"),
        ("response.failed", "ResponseFailedEvent"),
    ):
        model = config.get_event_model_class(event_type=event_type)
        with pytest.raises(ValidationError) as caught:
            model(**{"type": event_type})
        assert caught.value.title == expected_title


@requires_responses_types
async def test_responses_stream_survives_unparseable_envelope_events():
    """An envelope event the client cannot parse is skipped, not fatal: the
    reasoning trace and the answer still reach the wire. Letting the error
    propagate loses the whole turn to a RUN_ERROR."""
    events = [
        _litellm_validation_error("ResponseCreatedEvent"),
        _litellm_validation_error("ResponseInProgressEvent"),
        _summary_delta("Weighing the options."),
        _text_delta("Ans"),
        _text_delta("wer"),
        _completed_event(),
    ]
    flow = _FakeFlow()
    ep.FastAPICrewFlowEventListener()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        result = await copilotkit_stream(_ScriptedEventStream(events))
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    trace = "".join(
        e.delta for e in items if e.type == EventType.REASONING_MESSAGE_CONTENT
    )
    assert trace == "Weighing the options."
    assert result.choices[0].message.content == "Answer"

    # With response.created skipped, EVERY chunk of the message still carries the
    # SAME id (resolved once from the output item). A fresh id per chunk would
    # split one answer into a message per token on the client.
    text_events = [e for e in items if e.type == EventType.TEXT_MESSAGE_CHUNK]
    assert len(text_events) == 2
    assert {e.message_id for e in text_events} == {"msg_1"}


@pytest.mark.parametrize(
    "model_name",
    ["OutputTextDeltaEvent", "FunctionCallArgumentsDeltaEvent", "OutputItemAddedEvent"],
)
async def test_responses_stream_surfaces_unparseable_payload_event(model_name):
    """An unparseable PAYLOAD event must not vanish. Skipping one drops answer
    text or leaves a tool call's arguments truncated to invalid JSON, and the
    turn still "succeeds", so nothing downstream can tell content was lost."""
    events = [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        _litellm_validation_error(model_name),
        _text_delta("only half"),
        _completed_event(),
    ]
    with pytest.raises(RuntimeError, match="failed to parse") as caught:
        await copilotkit_stream(_ScriptedEventStream(events))
    assert model_name in str(caught.value)
    assert isinstance(caught.value.__cause__, ValidationError)


async def test_responses_stream_surfaces_unparseable_terminal_failure():
    """An unparseable TERMINAL failure must surface as an error, not as an empty
    assistant message: skipping ``response.failed`` leaves a failed stream with
    no failure recorded, no RUN_ERROR, and zero content."""
    events = [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        _litellm_validation_error("ResponseFailedEvent"),
    ]
    with pytest.raises(RuntimeError, match="failed to parse"):
        await copilotkit_stream(_ScriptedEventStream(events))


async def test_responses_stream_surfaces_unparseable_terminal_completion():
    """``response.completed`` is terminal too: skipping it means the stream ended
    for an unknown reason, which is not a clean completion."""
    events = [
        _text_delta("Answer"),
        _litellm_validation_error("ResponseCompletedEvent"),
    ]
    with pytest.raises(RuntimeError, match="failed to parse"):
        await copilotkit_stream(_ScriptedEventStream(events))


async def test_responses_stream_handles_unknown_event_type_lookup_error():
    """litellm 1.63-1.67 raise ``ValueError("Unknown event type: <type>")`` from
    their event-type lookup (newer builds answer with ``GenericEvent`` instead),
    so the classification must handle a plain ValueError, not only a
    ValidationError.

    A type litellm has no model for is a fact about the BUILD, so what it costs
    still depends on the role that type plays here: a type this bridge never
    reads costs nothing; a reasoning delta costs a gap in a trace; answer text,
    tool-call arguments and the outcome cannot be read at all on such a build,
    which is reported as that build fact (asserted in full by
    ``test_unmodellable_load_bearing_type_reports_the_build_not_a_corrupt_event``).
    """
    unread = [
        ValueError("Unknown event type: response.audio.delta"),
        _text_delta("Answer"),
        _completed_event(),
    ]
    result = await copilotkit_stream(_ScriptedEventStream(unread))
    assert result.choices[0].message.content == "Answer"

    # Case is not part of the signal: the type is captured off the ORIGINAL
    # message, whatever case litellm wrote the prefix in.
    shouty = [
        ValueError("UNKNOWN EVENT TYPE: response.audio.delta"),
        _text_delta("Answer"),
        _completed_event(),
    ]
    result = await copilotkit_stream(_ScriptedEventStream(shouty))
    assert result.choices[0].message.content == "Answer"

    for event_type in (
        "response.output_text.delta",
        "response.function_call_arguments.delta",
        "response.failed",
    ):
        with pytest.raises(RuntimeError, match="no model for"):
            await copilotkit_stream(
                _ScriptedEventStream([ValueError(f"Unknown event type: {event_type}")])
            )

    # A message that names no type at all cannot be judged, so it is reported
    # rather than skipped on the assumption that nothing was lost.
    nameless = ValueError("Unknown event type")
    with pytest.raises(RuntimeError, match="failed to parse"):
        await copilotkit_stream(_ScriptedEventStream([nameless]))

    # A future litellm that wraps the type in quotes must still be recognised as
    # the load-bearing type it is, not silently skipped as an unknown one.
    with pytest.raises(RuntimeError, match="no model for"):
        await copilotkit_stream(
            _ScriptedEventStream(
                [ValueError("Unknown event type: 'response.output_text.delta'")]
            )
        )


async def test_responses_stream_gives_up_when_nothing_parses():
    """A stream where every event fails to parse raises instead of silently
    returning an empty assistant message."""
    events = [_litellm_validation_error("ResponseCreatedEvent")] * (
        responses_mod._MAX_SKIPPED_EVENTS + 2
    )
    with pytest.raises(RuntimeError, match="unreadable"):
        await copilotkit_stream(_ScriptedEventStream(events))


async def test_responses_stream_propagates_transport_errors():
    """A transport failure is NOT swallowed by the skip path."""

    class _Broken(_FakeResponsesStream):
        async def __anext__(self):
            raise ConnectionError("socket closed")

    with pytest.raises(ConnectionError, match="socket closed"):
        await copilotkit_stream(_Broken([]))


async def test_responses_stream_propagates_non_litellm_value_errors():
    """``json.JSONDecodeError`` is a ``ValueError`` too, so a truncated SSE frame
    must propagate untouched rather than be mistaken for an event litellm could
    not model."""
    truncated = _json.JSONDecodeError("Expecting value", '{"type":', 8)
    with pytest.raises(_json.JSONDecodeError):
        await copilotkit_stream(_ScriptedEventStream([truncated]))

    with pytest.raises(ValueError, match="stream died"):
        await copilotkit_stream(_ScriptedEventStream([ValueError("stream died")]))


async def test_responses_stream_propagates_cancellation():
    """Cancellation must not be counted as an unparseable event."""
    import asyncio

    with pytest.raises(asyncio.CancelledError):
        await copilotkit_stream(_ScriptedEventStream([asyncio.CancelledError()]))


@requires_stream_frames
async def test_unparseable_terminal_failure_reaches_the_wire_as_run_error_e2e():
    """The whole point, end to end: a ``response.failed`` whose payload does not
    parse reports a RUN_ERROR instead of finishing the run with an empty
    assistant message and no record of the failure."""

    class _FailedTerminalFlow(Flow):
        @start()
        async def chat(self):
            await copilotkit_stream(_ScriptedEventStream([
                ResponseCreatedEvent(
                    type="response.created",
                    response=_responses_api_response("in_progress"),
                ),
                _litellm_validation_error("ResponseFailedEvent"),
            ]))
            return "done"

    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=_FailedTerminalFlow(),
        encoder=EventEncoder(),
        input_data=_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    )))
    types = [p["type"] for p in payloads]
    assert "RUN_ERROR" in types, types
    assert "RUN_FINISHED" not in types, types


# -- what an unparseable event costs comes from the event's ROLE --------------
#
# Which event failed decides whether skipping it is free or silently drops
# content, so the disposition is derived from the role the event plays for this
# bridge (``_responses_events.EVENT_ROLES``) plus litellm's OWN event-type to
# model registry, never from a list of model names kept next to the decision.
# The tests below pin both halves: the role map cannot drift away from the code
# that reads the events, and the attribution cannot drift away from litellm.

#: Every Responses event type this bridge reads, spelled out here so the table
#: below is driven by literals rather than by the map it is checking. The
#: anti-drift test asserts this IS the role map's key set.
_ALL_READ_EVENT_TYPES = (
    "response.created",
    "response.in_progress",
    "response.reasoning_summary_text.delta",
    "response.reasoning_text.delta",
    "response.output_item.added",
    "response.output_item.done",
    "response.output_text.delta",
    "response.function_call_arguments.delta",
    "response.completed",
    "response.incomplete",
    "response.failed",
    "error",
)


def _responses_event_types_referenced_by(func):
    """The Responses event type strings ``func``'s own source branches on.

    Parses the FUNCTION's source, so the set is what the code does today rather
    than what a list next to it claims. Both a ``RESPONSES_*`` constant (resolved
    through the module, and expanded when it holds a set of types) and an inlined
    literal count, so bypassing the constants does not bypass the check.
    """
    import ast
    import inspect
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(func)))
    module = inspect.getmodule(func)
    event_types = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value.startswith("response.") or node.value == "error":
                event_types.add(node.value)
            continue
        if not isinstance(node, ast.Name) or not node.id.startswith("RESPONSES_"):
            continue
        value = getattr(module, node.id, None)
        if isinstance(value, str):
            event_types.add(value)
        elif isinstance(value, (frozenset, set, tuple, list)):
            event_types.update(v for v in value if isinstance(v, str))
    return event_types


def test_event_roles_cover_every_type_the_responses_code_handles():
    """The role map is checked against the code that consumes the events.

    Both directions: a driver branch on a type with no role would leave that
    event's parse failure unclassified, and a role entry no code reads would be
    describing a channel that no longer exists. Adding a branch without a role
    (or the reverse) fails here instead of surfacing as a mis-severity later."""
    from ag_ui_crewai import _reasoning as reasoning_mod
    from ag_ui_crewai import _responses_events as vocab
    from ag_ui_crewai import sdk as sdk_mod

    handled = _responses_event_types_referenced_by(
        sdk_mod._copilotkit_stream_responses
    ) | _responses_event_types_referenced_by(
        reasoning_mod.reasoning_from_responses_event
    )
    assert handled, "the Responses code no longer names its event types by constant"
    assert set(_ALL_READ_EVENT_TYPES) == set(vocab.EVENT_ROLES)

    without_a_role = sorted(handled - set(vocab.EVENT_ROLES))
    assert not without_a_role, without_a_role

    # ``response.in_progress`` is the one bookkeeping type no code branches on:
    # it is listed so an unparseable one is provably skippable.
    unread = sorted(
        event_type
        for event_type, role in vocab.EVENT_ROLES.items()
        if role != vocab.ENVELOPE and event_type not in handled
    )
    assert not unread, unread


@requires_responses_types
def test_parse_failure_attribution_comes_from_litellms_own_registry():
    """Every read type's role is reachable through the model class LITELLM builds
    it with, which is the only signal a ``ValidationError`` leaves behind.

    A class litellm uses for SEVERAL read types (its catch-all) carries the most
    severe of their roles, so a catch-all failure is never treated as cheaper
    than the worst event it could have been."""
    from litellm.llms.openai.responses.transformation import OpenAIResponsesAPIConfig

    from ag_ui_crewai import _capabilities as caps
    from ag_ui_crewai import _responses_events as vocab

    modelling = caps.responses_event_modelling()
    assert modelling.resolver_available

    served_by = {}
    for event_type, role in vocab.EVENT_ROLES.items():
        model = OpenAIResponsesAPIConfig.get_event_model_class(event_type=event_type)
        served_by.setdefault(model.__name__, []).append(role)

    for model_name, roles in served_by.items():
        attributed = modelling.model_roles[model_name]
        assert attributed == max(roles, key=vocab.role_severity), (
            model_name,
            roles,
            attributed,
        )


@requires_responses_types
@pytest.mark.parametrize("event_type", _ALL_READ_EVENT_TYPES)
async def test_unparseable_event_fatality_follows_its_role(event_type):
    """One table for the whole classification: an unparseable event is reported
    when its role is load-bearing (answer text, a tool call's identity or
    arguments, replay continuity, or the stream's outcome) and skipped when it
    is not (stream bookkeeping or one reasoning-summary delta).

    Driven per type through litellm's own model for that type, so the severity
    comes from the role rather than from which model names someone remembered to
    list."""
    from litellm.llms.openai.responses.transformation import OpenAIResponsesAPIConfig

    from ag_ui_crewai import _responses_events as vocab

    model_name = OpenAIResponsesAPIConfig.get_event_model_class(
        event_type=event_type
    ).__name__
    events = [
        _litellm_validation_error(model_name),
        _text_delta("Answer"),
        _completed_event(),
    ]
    if vocab.is_load_bearing(vocab.EVENT_ROLES[event_type]):
        with pytest.raises(RuntimeError, match="failed to parse"):
            await copilotkit_stream(_ScriptedEventStream(events))
        return
    result = await copilotkit_stream(_ScriptedEventStream(events))
    assert result.choices[0].message.content == "Answer"


@requires_responses_types
async def test_responses_stream_surfaces_an_unparseable_output_item_done():
    """A completed reasoning item carries replay identity and encrypted state.

    Letting the answer succeed after dropping it creates history that renders
    correctly once but cannot continue on the next stateless turn.
    """
    events = [
        _summary_delta("Weighing the options."),
        _litellm_validation_error("OutputItemDoneEvent"),
        _text_delta("Answer"),
        _completed_event(),
    ]
    with pytest.raises(RuntimeError, match="failed to parse"):
        await copilotkit_stream(_ScriptedEventStream(events))


@requires_responses_types
@pytest.mark.parametrize(
    "model_name",
    [
        "ContentPartAddedEvent",
        "ContentPartDoneEvent",
        "OutputTextAnnotationAddedEvent",
        "OutputTextDoneEvent",
        "RefusalDeltaEvent",
        "RefusalDoneEvent",
        "WebSearchCallCompletedEvent",
        "FileSearchCallCompletedEvent",
        "FunctionCallArgumentsDoneEvent",
    ],
)
async def test_responses_stream_skips_events_litellm_knows_and_this_bridge_never_reads(
    model_name,
):
    """litellm models many events this bridge does not read at all. An unparseable
    one costs nothing this bridge maps, so killing the turn over it throws away
    an answer whose content is entirely intact."""
    events = [
        _litellm_validation_error(model_name),
        _text_delta("Answer"),
        _completed_event(),
    ]
    result = await copilotkit_stream(_ScriptedEventStream(events))
    assert result.choices[0].message.content == "Answer"


async def test_unparseable_event_is_reported_when_nothing_can_attribute_it():
    """With no event-type registry to attribute it to, a parse failure cannot be
    shown harmless, so it is reported rather than assumed to be."""
    import ag_ui_crewai._capabilities as caps

    with _litellm_event_registry(None):
        assert caps.responses_event_modelling().resolver_available is False
        with pytest.raises(RuntimeError, match="failed to parse"):
            await copilotkit_stream(
                _ScriptedEventStream([_litellm_validation_error("ResponseCreatedEvent")])
            )


# -- a litellm build that RAISES for a type it has no model for ---------------
#
# litellm 1.63-1.67 (inside this package's declared ``litellm>=1.60.2`` floor)
# raise ``ValueError("Unknown event type: <type>")`` from their event-type lookup
# for the reasoning-summary deltas this channel exists to read -- the answer text
# delta still resolves to ``OutputTextDeltaEvent`` there, so what those builds lose
# is the reasoning trace, not the stream. Reasoning is a REQUIRED role, so the
# channel must report UNAVAILABLE and callers must degrade to chat-completions --
# which still carries the text -- not fail once per turn on a reasoning trace
# declared as working.

#: What litellm 1.63-1.67 have no model for, per the reproduction: the reasoning
#: deltas only (the answer text delta still resolves to ``OutputTextDeltaEvent``).
_RAISING_BUILD_UNKNOWN_TYPES = (
    "response.reasoning_summary_text.delta",
    "response.reasoning_text.delta",
)


def _raising_event_registry(unknown_types):
    """An event-type lookup shaped like litellm 1.63-1.67.

    Those builds have no catch-all: they RAISE whenever there is no dedicated
    model for the type. Simulated by answering from the installed litellm and
    raising both for ``unknown_types`` and for anything the installed build
    serves with its catch-all, since a catch-all answer is exactly the case the
    older builds turned into a ``ValueError``.
    """
    from litellm.llms.openai.responses.transformation import OpenAIResponsesAPIConfig

    unknown = frozenset(unknown_types)

    def get_event_model_class(event_type):
        model = OpenAIResponsesAPIConfig.get_event_model_class(event_type=event_type)
        if event_type in unknown or model is GenericEvent:
            raise ValueError(f"Unknown event type: {event_type}")
        return model

    return get_event_model_class


@contextlib.contextmanager
def _litellm_event_registry(registry):
    """Run the block against ``registry`` as litellm's event-type lookup.

    Availability is re-derived through the package's OWN probe
    (``refresh_responses_channel_probe``) rather than by setting the flags this
    test wants, so a rule that ignores what litellm can model fails here."""
    import ag_ui_crewai._capabilities as caps

    original_registry = caps._RESPONSES_EVENT_MODEL_RESOLVER
    original_snapshot = caps.CAPABILITIES
    original_responses_snapshot = responses_mod.CAPABILITIES
    caps._RESPONSES_EVENT_MODEL_RESOLVER = registry
    caps.refresh_responses_channel_probe()
    caps.CAPABILITIES = caps._detect()
    responses_mod.CAPABILITIES = caps.CAPABILITIES
    try:
        yield caps
    finally:
        caps._RESPONSES_EVENT_MODEL_RESOLVER = original_registry
        caps.refresh_responses_channel_probe()
        caps.CAPABILITIES = original_snapshot
        responses_mod.CAPABILITIES = original_responses_snapshot


@requires_responses_types
def test_responses_channel_unavailable_when_litellm_cannot_model_what_it_reads():
    """The capability declaration matches reality on a raising build.

    Reporting the channel available there advertises a channel whose every
    reasoning turn and every text turn dies with a RUN_ERROR, because those are
    exactly the types such a build has no model for."""
    with _litellm_event_registry(
        _raising_event_registry(_RAISING_BUILD_UNKNOWN_TYPES)
    ) as caps:
        modelling = caps.responses_event_modelling()
        assert set(modelling.unmodellable_event_types) == set(
            _RAISING_BUILD_UNKNOWN_TYPES
        )
        assert responses_mod.responses_channel_available() is False
        assert caps.get_capabilities()["reasoning"]["responsesApiChannel"] is False

    # Restored: the installed litellm answers for unknown types, so the channel
    # is available again and the teardown did not leave a stale probe behind.
    assert responses_mod.responses_channel_available() is True


@requires_responses_types
def test_responses_channel_requires_completed_reasoning_items_for_continuation():
    """A build that cannot model ``output_item.done`` cannot promise replay."""
    event_type = "response.output_item.done"
    with _litellm_event_registry(_raising_event_registry((event_type,))) as caps:
        modelling = caps.responses_event_modelling()
        assert event_type in modelling.unmodellable_event_types
        assert responses_mod.responses_channel_available() is False


@requires_responses_types
async def test_copilotkit_responses_refuses_a_build_that_cannot_model_what_it_reads():
    """A caller that ignores the probe is refused BEFORE the stream opens, naming
    the types, instead of failing mid-turn once the client has already been shown
    part of an answer."""
    with _litellm_event_registry(
        _raising_event_registry(_RAISING_BUILD_UNKNOWN_TYPES)
    ):
        with pytest.raises(RuntimeError, match="no model for") as caught:
            await responses_mod.copilotkit_responses(
                model="openai/gpt-5.4",
                messages=[{"role": "user", "content": "hi"}],
                reasoning={"effort": "medium", "summary": "auto"},
            )
    assert "response.reasoning_summary_text.delta" in str(caught.value)
    assert "acompletion" in str(caught.value)


@requires_responses_types
async def test_unmodellable_load_bearing_type_reports_the_build_not_a_corrupt_event():
    """A caller that opened the stream anyway is told what is actually wrong: this
    litellm has no model for a type the bridge must read. Reporting it as an event
    that "failed to parse" blames the provider for a build limitation and hides
    the one action that fixes it."""
    with pytest.raises(RuntimeError, match="no model for") as caught:
        await copilotkit_stream(
            _ScriptedEventStream(
                [ValueError("Unknown event type: response.output_text.delta")]
            )
        )
    message = str(caught.value)
    assert "responses_channel_available" in message
    assert "chat-completions" in message


@requires_responses_types
async def test_unmodellable_reasoning_delta_costs_the_trace_not_the_run():
    """A reasoning delta this build cannot model leaves a gap in a trace; the
    answer and the outcome are untouched, so the run must survive. (Such a build
    reports the channel unavailable, so this is the belt-and-braces path for a
    caller that streamed anyway.)"""
    events = [
        ValueError("Unknown event type: response.reasoning_summary_text.delta"),
        _text_delta("Answer"),
        _completed_event(),
    ]
    result = await copilotkit_stream(_ScriptedEventStream(events))
    assert result.choices[0].message.content == "Answer"


@requires_stream_frames
@requires_responses_types
async def test_reasoning_demo_degrades_on_a_build_that_raises_for_unknown_types(
    monkeypatch,
):
    """End to end, the point of the probe: on a litellm that raises for the types
    this channel reads, the demo streams over chat-completions and the run
    finishes. Advertising the channel there sends OpenAI down the Responses path
    and every turn ends in a RUN_ERROR."""
    with _litellm_event_registry(
        _raising_event_registry(_RAISING_BUILD_UNKNOWN_TYPES)
    ):
        spy = _ChannelSpy(monkeypatch, channel_available=None)
        payloads = await _drive_reasoning_demo("OpenAI")

    assert spy.responses_calls == []
    assert len(spy.chat_calls) == 1
    types = [p["type"] for p in payloads]
    assert "RUN_ERROR" not in types, types
    assert "RUN_FINISHED" in types, types


@requires_responses_types
async def test_responses_message_id_is_resolved_once_per_turn():
    """Every chunk of one answer carries the SAME message id even when neither
    ``response.created`` nor the event itself supplies one. Resolving the id per
    event splits one answer into a message per token on the client."""
    events = [
        GenericEvent(type="response.output_text.delta", output_index=0, delta="Ans"),
        GenericEvent(type="response.output_text.delta", output_index=0, delta="wer"),
    ]
    flow = _FakeFlow()
    ep.FastAPICrewFlowEventListener()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        await copilotkit_stream(_FakeResponsesStream(events))
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    text_events = [e for e in items if e.type == EventType.TEXT_MESSAGE_CHUNK]
    assert len(text_events) == 2
    ids = {e.message_id for e in text_events}
    assert len(ids) == 1, ids
    assert next(iter(ids))


# --------------------------------------------------------------------------
# Responses-channel parity with the chat-completions driver. Each obligation
# below is one the chat driver honours and the Responses driver was written
# without, so they are asserted against the Responses driver directly.
# --------------------------------------------------------------------------

async def _drive_responses(stream, *, flow=None):
    """Stream a Responses turn on the bus path; return (result, wire events)."""
    if isinstance(stream, (list, tuple)):
        stream = _FakeResponsesStream(stream)
    flow = _FakeFlow() if flow is None else flow
    ep.FastAPICrewFlowEventListener()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        result = await copilotkit_stream(stream)
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)
    return result, items


def _function_call_events(*, seeded_arguments="", deltas=(), terminal=None):
    """A Responses tool-call turn: the added function-call item, then argument
    deltas. ``seeded_arguments`` populates ``item.arguments`` the way a provider
    that already knows the whole call would."""
    events = [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        OutputItemAddedEvent(
            type="response.output_item.added",
            output_index=0,
            item={
                "id": "fc_1",
                "call_id": "call_abc",
                "type": "function_call",
                "name": "change_background",
                "arguments": seeded_arguments,
            },
        ),
    ]
    events.extend(
        FunctionCallArgumentsDeltaEvent(
            type="response.function_call_arguments.delta",
            item_id="fc_1", output_index=0, delta=delta,
        )
        for delta in deltas
    )
    events.append(
        terminal
        if terminal is not None
        else ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        )
    )
    return events


# -- predicted-state suppression -------------------------------------------

async def test_responses_predicted_tool_streamed_suppresses_node_snapshot():
    """A predicted tool that streams over the RESPONSES channel must suppress the
    node-exit STATE_SNAPSHOT, exactly as it does on chat-completions. Without the
    ``_mark_predicted_tool_streamed`` call the flag is never set, the snapshot is
    rebuilt from flow.state at node exit, and it clobbers the predicted state the
    client is already rendering."""
    from ag_ui_crewai.sdk import (
        _record_predicted_tools,
        consume_node_exit_snapshot_suppression,
    )

    flow = _FakeFlow()
    _record_predicted_tools(flow, {"change_background"})
    await _drive_responses(
        _FakeResponsesStream(_function_call_events(deltas=('{"b":"red"}',))),
        flow=flow,
    )
    assert consume_node_exit_snapshot_suppression(flow) is True


async def test_responses_unpredicted_tool_leaves_the_snapshot_alone():
    """Only a tool that was actually PREDICTED suppresses the snapshot: a node
    that declared predict_state for another tool still emits its snapshot."""
    from ag_ui_crewai.sdk import (
        _record_predicted_tools,
        consume_node_exit_snapshot_suppression,
    )

    flow = _FakeFlow()
    _record_predicted_tools(flow, {"some_other_tool"})
    await _drive_responses(
        _FakeResponsesStream(_function_call_events(deltas=('{"b":"red"}',))),
        flow=flow,
    )
    assert consume_node_exit_snapshot_suppression(flow) is False


# -- a truncated turn is not a clean one ------------------------------------

@pytest.mark.parametrize(
    "reason,expected",
    [
        ("max_output_tokens", "length"),
        ("content_filter", "content_filter"),
        (None, "length"),
    ],
)
async def test_responses_incomplete_turn_is_distinguishable(reason, expected, caplog):
    """``response.incomplete`` means the assistant message was CUT OFF. Reporting
    it as ``finish_reason="stop"`` makes a truncated turn indistinguishable from a
    finished one, and the reason is lost entirely; it must map onto the
    chat-completions vocabulary and be logged."""
    events = [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        OutputTextDeltaEvent(
            type="response.output_text.delta",
            item_id="msg_1", output_index=0, content_index=0, delta="Half an ans",
        ),
        ResponseIncompleteEvent(
            type="response.incomplete",
            response=_responses_api_response(
                "incomplete", incomplete_details=IncompleteDetails(reason=reason)
            ),
        ),
    ]
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai.sdk"):
        result, _ = await _drive_responses(_FakeResponsesStream(events))

    assert result.choices[0].finish_reason == expected
    assert result.choices[0].message.content == "Half an ans"
    assert any("incomplete" in r.getMessage() for r in caplog.records), caplog.text


async def test_responses_truncation_outranks_tool_calls_finish_reason():
    """A turn truncated MID tool call reports the truncation, not ``tool_calls``:
    the arguments are partial, so telling the node the model cleanly asked for a
    tool would be a lie."""
    events = _function_call_events(
        deltas=('{"background":',),
        terminal=ResponseIncompleteEvent(
            type="response.incomplete",
            response=_responses_api_response(
                "incomplete",
                incomplete_details=IncompleteDetails(reason="max_output_tokens"),
            ),
        ),
    )
    result, _ = await _drive_responses(_FakeResponsesStream(events))
    assert result.choices[0].finish_reason == "length"
    assert result.choices[0].message.tool_calls[0].function.arguments == '{"background":'


# -- seeded arguments are never double-counted ------------------------------

async def test_responses_seeded_arguments_are_not_double_counted():
    """A provider that populates ``item.arguments`` AND streams the same arguments
    as deltas must not have them counted twice. Seeding the accumulator and then
    appending every delta yields the arguments twice, on the wire and in the
    returned ModelResponse."""
    result, items = await _drive_responses(_FakeResponsesStream(_function_call_events(
        seeded_arguments='{"background":"red"}',
        deltas=('{"background":', '"red"}'),
    )))

    assert result.choices[0].message.tool_calls[0].function.arguments == (
        '{"background":"red"}'
    )
    chunks = [e for e in items if e.type == EventType.TOOL_CALL_CHUNK]
    streamed = "".join(c.delta or "" for c in chunks)
    assert streamed == '{"background":"red"}'


async def test_responses_seeded_arguments_stream_when_no_delta_follows():
    """A provider that delivers the whole call on the output item and streams no
    delta still puts the arguments on the wire, so the streamed TOOL_CALL_ARGS
    match the returned ModelResponse (the chat driver's invariant)."""
    result, items = await _drive_responses(_FakeResponsesStream(_function_call_events(
        seeded_arguments='{"background":"red"}',
    )))

    assert result.choices[0].message.tool_calls[0].function.arguments == (
        '{"background":"red"}'
    )
    chunks = [e for e in items if e.type == EventType.TOOL_CALL_CHUNK]
    assert "".join(c.delta or "" for c in chunks) == '{"background":"red"}'
    assert {c.tool_call_id for c in chunks} == {"call_abc"}


# -- created_at is a float, ModelResponse.created is a strict int ------------

async def test_responses_fractional_created_at_does_not_void_the_turn():
    """``ResponsesAPIResponse.created_at`` is a float and ``ModelResponse.created``
    a strict int, so a FRACTIONAL timestamp raises a ValidationError, and it raises
    only after the whole turn has already streamed to the client."""
    events = [
        ResponseCreatedEvent(
            type="response.created",
            response=_responses_api_response("in_progress", created_at=1700000000.75),
        ),
        OutputTextDeltaEvent(
            type="response.output_text.delta",
            item_id="msg_1", output_index=0, content_index=0, delta="Answer",
        ),
        ResponseCompletedEvent(
            type="response.completed",
            response=_responses_api_response(created_at=1700000000.75),
        ),
    ]
    result, _ = await _drive_responses(_FakeResponsesStream(events))
    assert result.created == 1700000000
    assert result.choices[0].message.content == "Answer"


async def test_responses_non_numeric_created_at_keeps_the_default():
    """A ``created_at`` that is not a number at all is ignored rather than handed
    to pydantic, so an odd provider payload cannot void the turn either."""
    events = [
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        GenericEvent(type="response.completed", response={"created_at": "not a time"}),
    ]
    result, _ = await _drive_responses(_FakeResponsesStream(events))
    assert result.created == 1700000000


# -- the terminal break must not abandon the httpx response ------------------

class _AsyncClosable:
    """Stands in for the httpx response litellm's iterator holds."""

    def __init__(self):
        self.closed = False

    async def aclose(self):
        self.closed = True


class _SyncClosable:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class _ReleasableResponsesStream(_FakeResponsesStream):
    """Shaped like litellm's Responses iterator: NO ``aclose`` / ``close`` /
    ``__aenter__`` / ``__aexit__`` of its own (verified on litellm 1.72), holding
    the live response object on ``.response``."""

    def __init__(self, events, *, response):
        super().__init__(events)
        self.response = response


async def test_responses_terminal_break_releases_the_underlying_response():
    """The driver BREAKS on the terminal event instead of draining the iterator,
    which is the happy path for every run, so nothing ever asks litellm's iterator
    to clean up and its httpx response is left open."""
    holder = _AsyncClosable()
    stream = _ReleasableResponsesStream(_reasoning_then_text_events(), response=holder)
    result, _ = await _drive_responses(stream)
    assert result.choices[0].message.content == "Answer"
    assert holder.closed is True


async def test_responses_release_falls_back_to_a_sync_close_on_failure():
    """The closer is FEATURE-DETECTED, not assumed: a response exposing only a
    synchronous ``close`` is released too, and a stream that ends in a failure
    still releases before the error propagates."""
    holder = _SyncClosable()
    stream = _ReleasableResponsesStream(
        [GenericEvent(type="error", code="server_error", message="upstream exploded")],
        response=holder,
    )
    flow_context.set(_FakeFlow())
    with pytest.raises(RuntimeError, match="upstream exploded"):
        await copilotkit_stream(stream)
    assert holder.closed is True


async def test_responses_release_tolerates_a_stream_with_no_closer():
    """Nothing to close, or a closer that raises, must never void a turn that has
    already streamed."""

    class _NoCloser:
        pass

    class _Raising:
        def close(self):
            raise RuntimeError("already detached")

    for holder in (_NoCloser(), _Raising()):
        stream = _ReleasableResponsesStream(
            _reasoning_then_text_events(), response=holder
        )
        result, _ = await _drive_responses(stream)
        assert result.choices[0].message.content == "Answer"


# -- the demo forwards parallel_tool_calls on the Responses branch -----------

async def _drive_reasoning_demo_with_actions(model, actions):
    return _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=AgenticChatReasoningFlow(),
        encoder=EventEncoder(),
        input_data=_run_input(),
        inputs={
            "id": "t-1",
            "model": model,
            "messages": [],
            "copilotkit": {"actions": actions},
        },
        timeout=30.0,
    )))


_DEMO_ACTIONS = [
    {
        "type": "function",
        "function": {"name": "change_background", "description": "", "parameters": {}},
    }
]


@requires_stream_frames
@requires_responses_types
async def test_reasoning_demo_disables_parallel_tool_calls_on_responses(monkeypatch):
    """The Responses branch must pass ``parallel_tool_calls=False`` like the
    chat-completions branch and every other demo, or the default OpenAI path can
    emit parallel frontend tool calls."""
    spy = _ChannelSpy(monkeypatch)
    await _drive_reasoning_demo_with_actions("OpenAI", _DEMO_ACTIONS)
    assert spy.responses_calls, "OpenAI must stream over the Responses channel"
    assert spy.responses_calls[0]["parallel_tool_calls"] is False


@requires_stream_frames
@requires_responses_types
async def test_reasoning_demo_omits_parallel_tool_calls_without_tools(monkeypatch):
    """With no frontend actions there is nothing to serialise, so the flag is not
    sent at all (mirrors the chat branch's ``False if tools else None``)."""
    spy = _ChannelSpy(monkeypatch)
    await _drive_reasoning_demo_with_actions("OpenAI", [])
    assert spy.responses_calls
    assert "parallel_tool_calls" not in spy.responses_calls[0]


async def test_responses_message_id_falls_back_to_the_output_item_id():
    """With ``response.created`` gone, the id comes from the event that actually
    carries one. ``output_item.added`` has no ``item_id`` attribute at all, so a
    lookup that reads only ``item_id`` mints a uuid and the id the stream gave us
    never reaches the wire."""
    result, items = await _drive_responses([_function_call_added(arguments="{}")])

    chunks = [e for e in items if e.type == EventType.TOOL_CALL_CHUNK]
    assert chunks, [e.type for e in items]
    assert {c.parent_message_id for c in chunks} == {"fc_1"}
    assert result.id == "fc_1"


async def test_responses_answer_chunks_share_the_id_from_the_carrying_event():
    """EVERY chunk of one answer (the tool call and both text chunks) carries ONE
    stable message id, and that id is the one the stream supplied rather than a
    minted uuid. A uuid fallback is stable too, so this pins the SOURCE."""
    result, items = await _drive_responses([
        _function_call_added(),
        FunctionCallArgumentsDeltaEvent(
            type="response.function_call_arguments.delta",
            item_id="fc_1", output_index=0, delta='{"background":"red"}',
        ),
        _text_delta("Do"),
        _text_delta("ne"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    text_events = [e for e in items if e.type == EventType.TEXT_MESSAGE_CHUNK]
    assert len(text_events) == 2
    tool_parents = {
        e.parent_message_id for e in items if e.type == EventType.TOOL_CALL_CHUNK
    }
    text_ids = {e.message_id for e in text_events}
    assert text_ids == {"fc_1"}, text_ids
    assert tool_parents == {"fc_1"}, tool_parents
    assert result.id == "fc_1"


async def test_responses_message_id_prefers_the_response_created_id():
    """``response.created`` supplies the turn's id whenever it arrives: the driver
    records ``response.id`` before any output item, so the per-event lookup only
    ever fills in for a stream that skipped it."""
    result, items = await _drive_responses(_reasoning_then_text_events())

    text_ids = {e.message_id for e in items if e.type == EventType.TEXT_MESSAGE_CHUNK}
    assert text_ids == {"resp_1"}, text_ids
    assert result.id == "resp_1"


async def test_responses_reasoning_text_after_close_opens_a_second_block():
    """The Responses driver keeps the SAME semantics as chat-completions, since the
    channel is shared: a reasoning summary delta arriving after the answer text
    closed the first block opens a second complete one."""
    _, items = await _drive_responses([
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        _summary_delta("first"),
        _text_delta("Answer"),
        # A second reasoning block is a second provider output item. Reusing
        # ``rs_1`` would describe two chunks of the same replayable item.
        _summary_delta("late", item_id="rs_2"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    types = [e.type for e in items]
    assert types.count(EventType.REASONING_START) == 2, types
    assert types.count(EventType.REASONING_MESSAGE_START) == 2, types
    assert types.count(EventType.REASONING_MESSAGE_END) == 2, types
    assert types.count(EventType.REASONING_END) == 2, types
    content_by_id = {}
    for event in items:
        if event.type == EventType.REASONING_MESSAGE_CONTENT:
            content_by_id.setdefault(event.message_id, []).append(event.delta)
    assert sorted(content_by_id.values()) == [["first"], ["late"]], content_by_id


async def test_responses_late_encrypted_reasoning_attaches_without_reopening():
    """An encrypted reasoning blob whose ``output_item.done`` lands AFTER the answer
    text attaches to the closed provider item without minting a second lifecycle."""
    _, items = await _drive_responses([
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        _summary_delta("Weighing the options."),
        _text_delta("Answer"),
        _reasoning_item_done(),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    types = [e.type for e in items]
    assert types.count(EventType.REASONING_START) == 1, types
    assert types.count(EventType.REASONING_MESSAGE_START) == 1, types
    assert types.count(EventType.REASONING_MESSAGE_END) == 1, types
    assert types.count(EventType.REASONING_END) == 1, types
    encrypted = [e for e in items if e.type == EventType.REASONING_ENCRYPTED_VALUE]
    assert len(encrypted) == 1, types
    assert encrypted[0].entity_id == "rs_1"
    assert encrypted[0].encrypted_value == "BLOB"


async def test_responses_new_id_only_reasoning_after_close_opens_a_new_message():
    """A completed provider item with a new ID is a new empty reasoning block."""
    _, items = await _drive_responses([
        _summary_delta("first", item_id="rs_1"),
        _text_delta("Answer"),
        _reasoning_item_done("SECOND_BLOB", item_id="rs_2"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    starts = [e for e in items if e.type == EventType.REASONING_START]
    ends = [e for e in items if e.type == EventType.REASONING_END]
    encrypted = [e for e in items if e.type == EventType.REASONING_ENCRYPTED_VALUE]
    assert [e.message_id for e in starts] == ["rs_1", "rs_2"]
    assert [e.message_id for e in ends] == ["rs_1", "rs_2"]
    assert [(e.entity_id, e.encrypted_value) for e in encrypted] == [
        ("rs_2", "SECOND_BLOB")
    ]


async def test_responses_encrypted_reasoning_before_text_still_surfaces():
    """The legitimate ordering is untouched: a reasoning item finishing BEFORE the
    answer text surfaces its encrypted blob on the one open reasoning message."""
    _, items = await _drive_responses([
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        _summary_delta("Weighing the options."),
        _reasoning_item_done(),
        _text_delta("Answer"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    types = [e.type for e in items]
    assert types.count(EventType.REASONING_START) == 1, types
    assert types.count(EventType.REASONING_END) == 1, types
    encrypted = [e for e in items if e.type == EventType.REASONING_ENCRYPTED_VALUE]
    assert len(encrypted) == 1, types
    assert encrypted[0].encrypted_value == "BLOB"
    start = next(e for e in items if e.type == EventType.REASONING_START)
    assert encrypted[0].entity_id == start.message_id


async def test_responses_reasoning_lifecycle_uses_the_provider_item_id():
    """The AG-UI reasoning message is the replayable OpenAI ``rs_*`` item.

    A generated UUID renders correctly for one turn but cannot identify the
    reasoning item when the client sends history back on the next turn.
    """
    _, items = await _drive_responses([
        _summary_delta("Weighing the options.", item_id="rs_replayable"),
        _reasoning_item_done("BLOB", item_id="rs_replayable"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    starts = [e for e in items if e.type == EventType.REASONING_START]
    message_starts = [
        e for e in items if e.type == EventType.REASONING_MESSAGE_START
    ]
    content = [e for e in items if e.type == EventType.REASONING_MESSAGE_CONTENT]
    encrypted = [e for e in items if e.type == EventType.REASONING_ENCRYPTED_VALUE]
    message_ends = [e for e in items if e.type == EventType.REASONING_MESSAGE_END]
    ends = [e for e in items if e.type == EventType.REASONING_END]

    assert [e.message_id for e in starts] == ["rs_replayable"]
    assert [e.message_id for e in message_starts] == ["rs_replayable"]
    assert [e.message_id for e in content] == ["rs_replayable"]
    assert [e.entity_id for e in encrypted] == ["rs_replayable"]
    assert [e.message_id for e in message_ends] == ["rs_replayable"]
    assert [e.message_id for e in ends] == ["rs_replayable"]


async def test_responses_reasoning_item_without_summary_still_preserves_identity():
    """An id-only completed reasoning item must survive as an empty message.

    OpenAI requires reasoning items to be replayed with later tool outputs even
    when no visible summary or encrypted content was requested.
    """
    _, items = await _drive_responses([
        _reasoning_item_done(None, item_id="rs_empty"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    starts = [e for e in items if e.type == EventType.REASONING_START]
    ends = [e for e in items if e.type == EventType.REASONING_END]
    assert [e.message_id for e in starts] == ["rs_empty"]
    assert [e.message_id for e in ends] == ["rs_empty"]


async def test_responses_conflicting_reasoning_item_ids_fail_loudly():
    """One open AG-UI reasoning message cannot represent two provider items."""
    with pytest.raises(RuntimeError, match="reasoning item id"):
        await _drive_responses([
            _summary_delta("first", item_id="rs_first"),
            _summary_delta("second", item_id="rs_second"),
        ])

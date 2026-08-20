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
# OpenAI Responses channel
# --------------------------------------------------------------------------
# Reasoning summaries never appear on the chat-completions delta, so this is the
# ONLY channel that can surface an OpenAI thinking trace. The helpers below build
# the same event objects litellm produces (typed events where litellm knows the
# type, ``GenericEvent`` for the reasoning-summary deltas it does not) so the
# projection is exercised against real shapes, not hand-rolled stand-ins.
#
# These models are all present across this package's declared litellm range, so
# they are imported plainly: a litellm that re-homes or drops one collapses this
# module at collection time, on the import above, which is loud enough.
# ``test_litellm_exposes_the_responses_surface_we_use`` covers the other half of
# the boundary, the half no import can state: whether litellm can still PARSE the
# reasoning payloads this channel exists to carry.
# --------------------------------------------------------------------------

from pydantic import ValidationError  # noqa: E402

from litellm.types.llms.openai import (  # noqa: E402
    FunctionCallArgumentsDeltaEvent,
    GenericEvent,
    IncompleteDetails,
    OutputItemAddedEvent,
    OutputItemDoneEvent,
    OutputTextDeltaEvent,
    ResponseCompletedEvent,
    ResponseCreatedEvent,
    ResponseIncompleteEvent,
    ResponsesAPIResponse,
)
from openai.types.responses import (  # noqa: E402
    ResponseFunctionToolCall,
    ResponseReasoningItem,
)

from ag_ui_crewai import _responses as responses_mod  # noqa: E402
from ag_ui_crewai import sdk as sdk_mod  # noqa: E402
from ag_ui_crewai._reasoning import (  # noqa: E402
    reasoning_from_responses_event,
    responses_event_type,
)
from ag_ui_crewai._responses_events import (  # noqa: E402
    RESPONSES_OUTPUT_ITEM_DONE,
    RESPONSES_REASONING_SUMMARY_TEXT_DELTA,
    RESPONSES_REASONING_TEXT_DELTAS,
    responses_attr,
    responses_item_id,
)
from agents.agentic_chat_reasoning import (  # noqa: E402
    AgenticChatReasoningFlow,
)


def _parse_responses_chunk(payload):
    """Parse one raw Responses SSE payload the way litellm's own stream does.

    ``BaseResponsesAPIStreamingIterator._process_chunk`` json-decodes each SSE
    line and hands the resulting dict to
    ``OpenAIResponsesAPIConfig.transform_streaming_response``, which looks the
    event ``type`` up and either gives it a dedicated model or drops it onto the
    extras-allowing ``GenericEvent``. Driving that hop directly is what lets the
    canary exercise litellm's REAL parsing without a network call; the OpenAI
    config only debug-logs ``logging_obj``, so ``None`` is what we pass.

    Every failure mode here is a FAILURE, never a skip: losing the ability to
    check this boundary is exactly the regression the canary exists to catch.
    """
    from importlib.metadata import version

    try:
        from litellm.llms.openai.responses.transformation import (
            OpenAIResponsesAPIConfig,
        )
    except Exception as exc:  # pragma: no cover - only on an unsupported litellm
        raise AssertionError(
            "litellm no longer exposes OpenAIResponsesAPIConfig at "
            "litellm.llms.openai.responses.transformation, so this canary can no "
            f"longer drive litellm's own Responses event parsing: {exc!r}"
        ) from exc

    transform = getattr(
        OpenAIResponsesAPIConfig(), "transform_streaming_response", None
    )
    if not callable(transform):  # pragma: no cover - only on an unsupported litellm
        raise AssertionError(
            "OpenAIResponsesAPIConfig no longer exposes a callable "
            "transform_streaming_response, so this canary can no longer drive "
            "litellm's own Responses event parsing"
        )

    try:
        return transform(model="gpt-5.4", parsed_chunk=payload, logging_obj=None)
    except Exception as exc:
        raise AssertionError(
            f"litellm {version('litellm')} cannot parse a real "
            f"{payload['type']!r} Responses chunk, so the reasoning trace this "
            f"channel exists to surface never reaches the bridge: {exc!r}"
        ) from exc


def test_litellm_exposes_the_responses_surface_we_use():
    """Dependency-boundary canary for the declared litellm range.

    Drives raw Responses SSE payloads through litellm's OWN event parsing and
    reads the results back through the bridge's accessors, so the range is held
    to what litellm can still DO rather than to which symbols it still exports.
    A litellm that cannot parse the reasoning-summary deltas fails here naming
    the type it choked on, which is precisely why the declared floor exists:
    1.60.2-1.67 raise ``ValueError("Unknown event type: ...")`` on those deltas
    instead of carrying them on ``GenericEvent``. No other test would notice,
    because every other test in this section builds its event objects directly.

    What it does NOT guarantee: the event models imported at module scope above
    are not covered here. A litellm that re-homes or drops one of those fails at
    COLLECTION time, on the import, and this test never runs.
    """
    import litellm

    assert callable(getattr(litellm, "aresponses", None))
    assert responses_mod.responses_channel_available() is True

    for delta_type in sorted(RESPONSES_REASONING_TEXT_DELTAS):
        # A summary delta indexes into the summary array, the raw variant into
        # content; everything else about the two payloads is identical.
        is_summary = delta_type == RESPONSES_REASONING_SUMMARY_TEXT_DELTA
        event = _parse_responses_chunk({
            "type": delta_type,
            "sequence_number": 3,
            "item_id": "rs_canary",
            "output_index": 0,
            "summary_index" if is_summary else "content_index": 0,
            "delta": "weighing the options",
        })
        assert responses_event_type(event) == delta_type
        assert responses_item_id(event) == "rs_canary"
        assert reasoning_from_responses_event(event) == DeltaReasoning(
            text="weighing the options", item_id="rs_canary"
        )

    done = _parse_responses_chunk({
        "type": RESPONSES_OUTPUT_ITEM_DONE,
        "sequence_number": 9,
        "output_index": 0,
        "item": {
            "id": "rs_canary",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "weighing the options"}],
            "encrypted_content": "CANARY_BLOB",
        },
    })
    assert responses_event_type(done) == RESPONSES_OUTPUT_ITEM_DONE
    item = responses_attr(done, "item")
    assert responses_attr(item, "type") == "reasoning"
    assert responses_attr(item, "encrypted_content") == "CANARY_BLOB"
    assert reasoning_from_responses_event(done) == DeltaReasoning(
        encrypted=("CANARY_BLOB",), item_id="rs_canary"
    )


def _responses_api_response(status="completed", *, created_at=1700000000,
                            incomplete_details=None):
    """A real ``ResponsesAPIResponse``, as litellm hands back on created/completed.

    Built with ``model_construct`` so ``created_at`` carries what the WIRE
    carries rather than what one litellm build happens to accept. The annotation
    moved across the supported range: ``float`` on the locked 1.72.0, ``int`` on
    1.96.2, where a fractional payload is what pydantic rejects. The driver has to
    absorb a fractional value either way, which is what
    ``_responses_created_timestamp`` exists for, so the helper must be able to
    carry one on every build in the range.
    """
    return ResponsesAPIResponse.model_construct(
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
    """Stands in for the async iterable ``aresponses`` returns.

    Async-iterability is the whole contract the driver relies on.
    """

    def __init__(self, events):
        self._events = list(events)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


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
    """A completed item with the OBJECT shape recent litellm builds deliver.

    ``OutputItemDoneEvent.item`` is annotated ``dict`` through the locked 1.72.0
    and ``BaseLiteLLMOpenAIResponseObject`` on 1.96.2, both inside the supported
    range, so both shapes have to be exercised. ``model_construct`` carries the
    object shape through the locked build's event model without weakening the
    test into a hand-written event double.
    """
    return OutputItemDoneEvent.model_construct(
        type="response.output_item.done",
        output_index=0,
        item=ResponseReasoningItem(
            id=item_id,
            summary=[],
            type="reasoning",
            encrypted_content=encrypted,
        ),
    )


def _reasoning_item_done_mapping(encrypted="BLOB", *, item_id="rs_1"):
    """The completed reasoning item as a whole-event MAPPING.

    ``responses_event_type`` / ``responses_item_id`` read the EVENT itself
    through ``responses_attr``, so a mapping-shaped event is inside the shape
    contract the driver and the reasoning projection share.
    """
    return {
        "type": "response.output_item.done",
        "output_index": 0,
        "item": {"id": item_id, "type": "reasoning", "encrypted_content": encrypted},
    }


def _text_delta(text, *, item_id="msg_1"):
    return OutputTextDeltaEvent(
        type="response.output_text.delta",
        item_id=item_id, output_index=1, content_index=0, delta=text,
    )


# -- projection ------------------------------------------------------------

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


def test_reasoning_from_responses_summary_delta():
    """A reasoning-summary delta keeps the provider reasoning-item identity."""
    r = reasoning_from_responses_event(_summary_delta("because X"))
    assert r == DeltaReasoning(text="because X", encrypted=(), item_id="rs_1")
    assert r.item_id == "rs_1"
    assert bool(r) is True


def test_reasoning_from_responses_mapping_shaped_summary_delta():
    """A mapping-shaped delta event projects exactly like the object shape.

    The type gate and the item-id read already tolerate a mapping, so reading the
    delta text any other way would admit an event the projection then sees as
    empty.
    """
    event = {
        "type": "response.reasoning_summary_text.delta",
        "item_id": "rs_1",
        "output_index": 0,
        "summary_index": 0,
        "delta": "because X",
    }
    assert reasoning_from_responses_event(event) == DeltaReasoning(
        text="because X", item_id="rs_1"
    )


def test_reasoning_from_responses_raw_reasoning_text_delta():
    """The raw ``reasoning_text`` variant is projected too."""
    event = GenericEvent(
        type="response.reasoning_text.delta", item_id="rs_1", output_index=0, delta="hm"
    )
    assert reasoning_from_responses_event(event).text == "hm"


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
    with pytest.raises(RuntimeError, match="missing its reasoning item id"):
        reasoning_from_responses_event(event)


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


@pytest.mark.parametrize(
    "response",
    [object(), "a string", 42],
    ids=["object", "str", "int"],
)
async def test_copilotkit_stream_rejects_a_response_it_cannot_consume(response):
    """Anything that is neither a ``ModelResponse``, a ``CustomStreamWrapper`` nor
    an async iterable is one clear caller error naming the entrypoint to use, not
    an ``AttributeError`` from inside a driver."""
    with pytest.raises(ValueError) as excinfo:
        await copilotkit_stream(response)
    message = str(excinfo.value)
    assert "Invalid response type" in message, message
    assert "copilotkit_responses" in message, message


async def test_copilotkit_stream_routes_an_async_iterable_to_the_responses_driver():
    """``aresponses`` returns an async iterable, and that is the whole contract
    the dispatch relies on: no isinstance branch, no duck-typed shim."""
    result = await copilotkit_stream(
        _FakeResponsesStream(_reasoning_then_text_events())
    )
    assert result.choices[0].message.content == "Answer"


async def test_copilotkit_stream_routes_chat_wrapper_to_chat_driver(monkeypatch):
    """A chat-completions ``CustomStreamWrapper`` keeps going to the chat driver:
    the Responses dispatch must not steal or reroute it."""

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


def test_chat_messages_to_responses_input_drops_reasoning_without_provider_id():
    """A missing id cannot refer back to OpenAI's reasoning item, so it is dropped.

    Dropping, not raising: the whole request would otherwise hard-fail over one
    unreplayable item, the same reason an unpaired tool call is dropped.
    """
    items = responses_mod.chat_messages_to_responses_input([
        {"role": "user", "content": "hi"},
        {"role": "reasoning", "content": "orphaned"},
    ])

    assert items == [{"role": "user", "content": "hi"}]
    _assert_valid_responses_input(items)


def test_chat_messages_to_responses_input_drops_chat_channel_reasoning(caplog):
    """Reasoning minted on the chat-completions channel never reaches OpenAI.

    The reasoning cell lets the user switch provider mid-thread, so an Anthropic
    turn's reasoning (a uuid4 id this process minted, plus an Anthropic thinking
    signature) is in the history the next OpenAI turn converts. OpenAI cannot
    resolve that id and rejects the request, so the item is dropped while the
    genuine Responses item alongside it still replays in full.
    """
    minted_id = str(uuid.uuid4())

    # DEBUG: which message was dropped is per-message detail, deliberately below
    # WARNING because the whole history is reconverted every turn. The aggregate
    # count asserted below is what an operator sees at WARNING.
    with caplog.at_level(logging.DEBUG, logger="ag_ui_crewai._responses"):
        items = responses_mod.chat_messages_to_responses_input([
            {"role": "user", "content": "Which option?"},
            {
                "role": "reasoning",
                "id": minted_id,
                "content": "Thinking as Anthropic.",
                "encrypted_value": "ANTHROPIC_SIGNATURE",
            },
            {"role": "assistant", "content": "Choose A."},
            {"role": "user", "content": "Why?"},
            {
                "role": "reasoning",
                "id": "rs_openai",
                "content": "Thinking as OpenAI.",
                "encrypted_value": "OPENAI_STATE",
            },
        ])

    assert items == [
        {"role": "user", "content": "Which option?"},
        {"role": "assistant", "content": "Choose A."},
        {"role": "user", "content": "Why?"},
        {
            "id": "rs_openai",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "Thinking as OpenAI."}],
            "encrypted_content": "OPENAI_STATE",
        },
    ]
    _assert_valid_responses_input(items)
    assert any(
        minted_id in r.getMessage() and "Responses channel" in r.getMessage()
        for r in caplog.records
    ), caplog.text
    assert any(
        r.levelno == logging.WARNING and "Dropped 1 reasoning message" in r.getMessage()
        for r in caplog.records
    ), caplog.text


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

    from litellm.types.llms.openai import ResponseInputParam

    TypeAdapter(ResponseInputParam).validate_python(items)


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
    # Last, because it is the strongest assertion: the shape is validated against
    # the openai types litellm re-exports, not against a hand-rolled idea of them.
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


def test_chat_messages_to_responses_input_drops_reasoning_left_trailing_by_a_drop(
    caplog,
):
    """A reasoning item that became TRAILING because of a drop is still dangling.

    Trailing reasoning is normally legal: the output it produced is what this
    request generates. That allowance must not extend to a reasoning item whose own
    function_call was just dropped as unpaired, because then nothing is coming for
    it and the request is the exact hard-fail the drop exists to prevent. The
    abandoned call here is the last thing in the history, so the reasoning ends up
    last after the drop.
    """
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._responses"):
        items = responses_mod.chat_messages_to_responses_input([
            {"role": "user", "content": "change it"},
            {"id": "rs_1", "role": "reasoning", "content": "I should call the tool."},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_abandoned",
                        "type": "function",
                        "function": {"name": "change_background", "arguments": "{}"},
                    }
                ],
            },
        ])

    assert items == [{"role": "user", "content": "change it"}]
    _assert_valid_responses_input(items)
    assert any(
        "dangling reasoning item" in r.getMessage() and "rs_1" in r.getMessage()
        for r in caplog.records
    ), caplog.text


def test_chat_messages_to_responses_input_keeps_reasoning_pending_this_request():
    """Trailing reasoning with nothing dropped after it is PENDING, not dangling.

    This is the ordinary "reasoning was the last thing the model produced" history,
    and dropping it would lose the replay state the round trip exists to carry.
    """
    items = responses_mod.chat_messages_to_responses_input([
        {"role": "user", "content": "hi"},
        {"id": "rs_1", "role": "reasoning", "content": "Thinking.", "encrypted_value": "B"},
    ])

    assert items == [
        {"role": "user", "content": "hi"},
        {
            "id": "rs_1",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "Thinking."}],
            "encrypted_content": "B",
        },
    ]
    _assert_valid_responses_input(items)


def test_chat_messages_to_responses_input_drops_reasoning_of_a_dropped_call(caplog):
    """Dropping an unpaired call must take the reasoning that produced it.

    The Responses API requires a reasoning item to be followed by the output it
    produced, so reasoning left in front of the next user message rejects the
    whole request: the drop that protects the request would otherwise create the
    shape it protects against.
    """
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._responses"):
        items = responses_mod.chat_messages_to_responses_input([
            {"role": "user", "content": "make it red"},
            {"id": "rs_orphaned", "role": "reasoning", "content": "Picking a tool."},
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
            {"role": "user", "content": "never mind, why?"},
        ])
    assert items == [
        {"role": "user", "content": "make it red"},
        {"role": "user", "content": "never mind, why?"},
    ]
    assert any("rs_orphaned" in r.getMessage() for r in caplog.records), caplog.text
    _assert_valid_responses_input(items)


def test_chat_messages_to_responses_input_drops_a_repeated_reasoning_id(caplog):
    """A reasoning id that repeats in history is emitted once: a second item for
    the same id hard-fails the request the way a duplicated call does."""
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._responses"):
        items = responses_mod.chat_messages_to_responses_input([
            {"role": "user", "content": "Which option?"},
            {"id": "rs_dup", "role": "reasoning", "content": "Weighing the options."},
            {"id": "rs_dup", "role": "reasoning", "content": "Weighing the options."},
            {"role": "assistant", "content": "Choose A."},
        ])
    assert items == [
        {"role": "user", "content": "Which option?"},
        {
            "id": "rs_dup",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "Weighing the options."}],
        },
        {"role": "assistant", "content": "Choose A."},
    ]
    assert any("rs_dup" in r.getMessage() for r in caplog.records), caplog.text
    _assert_valid_responses_input(items)


def test_chat_messages_to_responses_input_keeps_reasoning_whose_output_survives():
    """The dangling-reasoning drop must not reach reasoning that replays legally:
    here the call it produced is paired, so it survives and the reasoning with it."""
    items = responses_mod.chat_messages_to_responses_input([
        {"role": "user", "content": "make it red"},
        {"id": "rs_kept", "role": "reasoning", "content": "Calling the tool."},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_ok",
                    "type": "function",
                    "function": {
                        "name": "change_background",
                        "arguments": '{"b":"red"}',
                    },
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_ok", "content": "done"},
        {"role": "user", "content": "thanks"},
    ])
    assert items == [
        {"role": "user", "content": "make it red"},
        {
            "id": "rs_kept",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "Calling the tool."}],
        },
        {
            "type": "function_call",
            "call_id": "call_ok",
            "name": "change_background",
            "arguments": '{"b":"red"}',
        },
        {"type": "function_call_output", "call_id": "call_ok", "output": "done"},
        {"role": "user", "content": "thanks"},
    ]
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
        import agents.agentic_chat_reasoning as demo

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
    import agents.agentic_chat_reasoning as demo

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


# -- a malformed event surfaces, bar the two envelope frames nothing reads -----

class _ScriptedEventStream(_FakeResponsesStream):
    """Streams a script of events, RAISING any entry that is an exception.

    That is how litellm surfaces a per-event failure: it raises out of
    ``__anext__`` for the event it could not build.
    """

    async def __anext__(self):
        if not self._events:
            raise StopAsyncIteration
        entry = self._events.pop(0)
        if isinstance(entry, BaseException):
            raise entry
        return entry


def _completed_event():
    return ResponseCompletedEvent(
        type="response.completed", response=_responses_api_response()
    )


def _parse_failure(model_name):
    """A ``ValidationError`` naming the litellm event model that failed to build.

    ``ValidationError.title`` is the model class litellm tried to validate the
    chunk into, and it is the only thing a failed parse leaves to identify the
    event by: no event object exists to read a ``type`` off.
    """
    return ValidationError.from_exception_data(
        model_name, [{"type": "missing", "loc": ("response",), "input": {}}]
    )


@pytest.mark.parametrize(
    "failure",
    [
        _parse_failure("ResponseFailedEvent"),
        _json.JSONDecodeError("Expecting value", '{"type":', 8),
        ValueError("Unknown event type: response.output_text.delta"),
        ConnectionError("socket closed"),
    ],
    ids=["validation-error", "truncated-frame", "unknown-event-type", "transport"],
)
async def test_responses_stream_surfaces_a_malformed_event_unchanged(failure):
    """The driver reads the stream and nothing else.

    A failure litellm raises for one event propagates as itself, so the drivers'
    exception taxonomy reports it. Classifying failures in order to skip some of
    them silently drops answer text, tool-call arguments or the stream's outcome,
    and reports success anyway.
    """
    with pytest.raises(type(failure)) as excinfo:
        await copilotkit_stream(
            _ScriptedEventStream([_text_delta("partial"), failure, _completed_event()])
        )
    # Identity, not just the type: ValidationError and JSONDecodeError are both
    # ValueErrors, so a type match alone cannot tell "propagated untouched" from
    # "caught and re-raised as something of the same class".
    assert excinfo.value is failure


@pytest.mark.parametrize(
    "model_name",
    ["GenericEvent", "OutputTextDeltaEvent", "FunctionCallArgumentsDeltaEvent"],
    ids=["reasoning-delta", "text-delta", "tool-call-args-delta"],
)
async def test_responses_stream_surfaces_a_payload_parse_failure(model_name):
    """A parse failure on an event that CARRIES the turn propagates as itself.

    Reasoning text, answer text and tool-call arguments are the turn. Skipping one
    of these would hand back a ModelResponse missing content the model actually
    produced and report it as a clean turn, so the envelope skip must not widen to
    cover them.
    """
    failure = _parse_failure(model_name)
    with pytest.raises(ValidationError) as excinfo:
        await copilotkit_stream(
            _ScriptedEventStream([_text_delta("partial"), failure, _completed_event()])
        )
    # Identity, not just the type: ValidationError is itself a ValueError, so a
    # type match alone cannot tell "propagated untouched" from "caught and
    # re-raised as something of the same class".
    assert excinfo.value is failure


@pytest.mark.parametrize(
    "model_name",
    ["ResponseCompletedEvent", "ResponseIncompleteEvent", "ResponseFailedEvent"],
    ids=["completed", "incomplete", "failed"],
)
async def test_responses_stream_surfaces_a_terminal_parse_failure(model_name):
    """A parse failure on the TERMINAL event propagates as itself.

    The terminal event is the turn's outcome: skipping it would report a stream
    that failed, or was cut off, as a finished one.
    """
    failure = _parse_failure(model_name)
    with pytest.raises(ValidationError) as excinfo:
        await copilotkit_stream(
            _ScriptedEventStream([_text_delta("partial"), failure])
        )
    assert excinfo.value is failure


async def test_responses_stream_propagates_cancellation():
    """Cancellation is not an event failure and must not be reinterpreted."""
    import asyncio

    with pytest.raises(asyncio.CancelledError):
        await copilotkit_stream(_ScriptedEventStream([asyncio.CancelledError()]))


@requires_stream_frames
async def test_malformed_terminal_event_reaches_the_wire_as_run_error_e2e():
    """End to end: a terminal event that does not parse reports a RUN_ERROR rather
    than finishing the run with an empty assistant message and no record of the
    failure."""

    class _FailedTerminalFlow(Flow):
        @start()
        async def chat(self):
            await copilotkit_stream(_ScriptedEventStream([
                ResponseCreatedEvent(
                    type="response.created",
                    response=_responses_api_response("in_progress"),
                ),
                _parse_failure("ResponseFailedEvent"),
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


#: What ``@copilotkit/aimock``'s Responses emulation puts on the wire for
#: ``response.created`` and ``response.in_progress`` (``dist/responses.js``,
#: ``buildResponsePreamble``): six fields, where litellm's models for those two
#: events require far more. The dojo's reasoning e2e runs against that mock, so
#: this payload is what CI streams on the FIRST event of every turn.
_AIMOCK_ENVELOPE = {
    "id": "resp_1",
    "object": "response",
    "created_at": 1730000000,
    "model": "gpt-5.4",
    "status": "in_progress",
    "output": [],
}


def _aimock_envelope_entry(event_type):
    """What litellm's own parsing yields for an aimock envelope frame.

    The exception on a build whose models reject the payload, the parsed event on
    one that accepts it, so the scripted stream carries whatever the installed
    litellm really produces rather than a hand-picked outcome.
    ``_ScriptedEventStream`` raises the former and yields the latter.
    """
    from litellm.llms.openai.responses.transformation import (
        OpenAIResponsesAPIConfig,
    )

    payload = {"type": event_type, "response": dict(_AIMOCK_ENVELOPE)}
    try:
        return OpenAIResponsesAPIConfig().transform_streaming_response(
            model="gpt-5.4", parsed_chunk=payload, logging_obj=None
        )
    except Exception as exc:  # noqa: BLE001 - the failure IS the fixture
        return exc


def _aimock_envelope_frames():
    """The envelope frames as the installed litellm handles aimock's payload."""
    return [
        _aimock_envelope_entry("response.created"),
        _aimock_envelope_entry("response.in_progress"),
    ]


def _unparsable_envelope_frames():
    """The same two frames as parse failures, whatever the installed litellm does.

    litellm 1.96.2 accepts the aimock payload where 1.70.4 and the locked 1.72.0
    reject it, so this is what keeps the SKIP itself exercised across the whole
    declared range rather than only on the builds that happen to fail.
    """
    return [
        _parse_failure("ResponseCreatedEvent"),
        _parse_failure("ResponseInProgressEvent"),
    ]


@pytest.mark.parametrize(
    "envelope",
    [_aimock_envelope_frames, _unparsable_envelope_frames],
    ids=["aimock-payload", "parse-failure"],
)
async def test_responses_stream_survives_unparsable_envelope_frames(envelope, caplog):
    """A turn whose envelope frames do not parse still reports the whole turn.

    With the aimock payload above this is the CI failure itself: on the locked
    litellm it ended every Responses turn in the dojo on its FIRST event, with no
    reasoning trace, no answer text and a RUN_ERROR instead. The driver reads
    ``response.created`` only for the returned model name and created-at, and never
    reads ``response.in_progress`` at all, so both frames can be dropped with the
    turn intact.
    """
    events = [
        *envelope(),
        _summary_delta("Weighing the "),
        _summary_delta("options."),
        _text_delta("Answer"),
        _completed_event(),
    ]
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai.sdk"):
        result, items = await _drive_responses(_ScriptedEventStream(events))

    types = [e.type for e in items]
    assert EventType.REASONING_START in types, types
    assert EventType.REASONING_MESSAGE_END in types, types
    assert EventType.REASONING_END in types, types
    assert Counter(
        e.delta for e in items if e.type == EventType.REASONING_MESSAGE_CONTENT
    ) == Counter(["Weighing the ", "options."])
    assert "".join(
        e.delta for e in items if e.type == EventType.TEXT_MESSAGE_CHUNK
    ) == "Answer"

    assert result.choices[0].message.content == "Answer"
    # The terminal event was handled: it is what sets a clean finish reason, and
    # the model name that ``response.created`` could not supply.
    assert result.choices[0].finish_reason == "stop"
    assert result.model == "gpt-5.4"

    # A skip is never silent, and it names the model litellm could not build.
    if isinstance(events[0], BaseException):
        skips = [
            r.getMessage() for r in caplog.records if "skipped" in r.getMessage()
        ]
        assert len(skips) == 2, caplog.text
        assert "ResponseCreatedEvent" in skips[0], skips
        assert "ResponseInProgressEvent" in skips[1], skips


async def test_responses_stream_of_skipped_envelope_frames_alone_still_raises():
    """Skipped frames recognise nothing, so a stream of only those still raises.

    The no-recognised-event guard separates a turn that produced nothing from an
    object that was never a Responses stream at all. A skip that counted as
    recognition would turn the second case into a finished, empty assistant turn.
    """
    with pytest.raises(ValueError, match="carried no OpenAI"):
        await copilotkit_stream(
            _ScriptedEventStream([
                _parse_failure("ResponseCreatedEvent"),
                _parse_failure("ResponseInProgressEvent"),
            ])
        )


async def test_litellm_iterator_resumes_after_an_envelope_parse_failure():
    """Dependency-boundary canary: an unread envelope frame costs the turn nothing.

    Skipping a frame is only worth anything if litellm's OWN iterator can be read
    again afterwards, and whether it can is litellm's internal business, so this
    drives the real ``ResponsesAPIStreamingIterator`` over a real httpx streaming
    response instead of assuming it.

    Both ways a build in the declared range can satisfy this pass: 1.70.4 and the
    locked 1.72.0 reject the envelope payload and keep going (``_process_chunk``
    raises without marking the iterator finished, and the decoder underneath has
    already moved past that chunk), while 1.96.2 simply parses it. A build that
    rejected the payload AND ended the stream on it would leave the driver's skip
    unable to save the turn, and that is what fails here.
    """
    import httpx

    from litellm.llms.openai.responses.transformation import (
        OpenAIResponsesAPIConfig,
    )
    from litellm.responses.streaming_iterator import ResponsesAPIStreamingIterator

    payloads = [
        {"type": "response.created", "response": dict(_AIMOCK_ENVELOPE)},
        {"type": "response.in_progress", "response": dict(_AIMOCK_ENVELOPE)},
        {
            "type": "response.reasoning_summary_text.delta",
            "sequence_number": 3,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 0,
            "delta": "Weighing the options.",
        },
        {
            "type": "response.output_text.delta",
            "sequence_number": 4,
            "item_id": "msg_1",
            "output_index": 1,
            "content_index": 0,
            "delta": "Answer",
        },
    ]

    async def _sse():
        for payload in payloads:
            yield f"data: {_json.dumps(payload)}\n\n".encode()
        yield b"data: [DONE]\n\n"

    class _Logging:
        """The little of litellm's logging object its iterator actually reads.

        1.96.2 reads ``model_call_details`` while constructing the iterator and
        stamps a completion start time per chunk; the locked 1.72.0 reads neither.
        None of it is what this canary asserts.
        """

        completion_start_time = None
        model_call_details: dict = {}

        def _update_completion_start_time(self, **kwargs):
            pass

        async def async_failure_handler(self, **kwargs):
            pass

        def failure_handler(self, *args, **kwargs):
            pass

    iterator = ResponsesAPIStreamingIterator(
        response=httpx.Response(200, content=_sse()),
        model="gpt-5.4",
        responses_api_provider_config=OpenAIResponsesAPIConfig(),
        logging_obj=_Logging(),
    )

    delivered = []
    while True:
        try:
            delivered.append(await iterator.__anext__())
        except StopAsyncIteration:
            break
        except ValidationError:
            continue

    # Whether or not the envelope frames parsed on this build, everything after
    # them arrived, which is what the skip depends on.
    assert [responses_event_type(e) for e in delivered][-2:] == [
        "response.reasoning_summary_text.delta",
        "response.output_text.delta",
    ]


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


def _function_call_events(*, seeded_arguments="", deltas=(), done=None, terminal=None):
    """A Responses tool-call turn: the added function-call item, then argument
    deltas, then an optional completed item. ``seeded_arguments`` populates
    ``item.arguments`` the way a provider that already knows the whole call
    would."""
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
    if done is not None:
        events.append(done)
    events.append(
        terminal
        if terminal is not None
        else ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        )
    )
    return events


def _function_call_item_done(arguments, *, item_id="fc_1", call_id="call_abc"):
    """The completed ``function_call`` output item, carrying the call's FINAL
    arguments, with the plain-dict ``item`` of the floor litellm build."""
    return GenericEvent(
        type="response.output_item.done",
        output_index=0,
        item={
            "id": item_id,
            "call_id": call_id,
            "type": "function_call",
            "name": "change_background",
            "arguments": arguments,
        },
    )


def _function_call_item_done_object(arguments, *, item_id="fc_1", call_id="call_abc"):
    """The same completed item in the OBJECT shape recent litellm builds deliver
    (see ``_reasoning_item_done_object`` for why it is ``model_construct``)."""
    return OutputItemDoneEvent.model_construct(
        type="response.output_item.done",
        output_index=0,
        item=ResponseFunctionToolCall(
            id=item_id,
            call_id=call_id,
            type="function_call",
            name="change_background",
            arguments=arguments,
        ),
    )


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


# -- the completed item's arguments are the authoritative ones ---------------

@pytest.mark.parametrize(
    "done_item",
    [_function_call_item_done, _function_call_item_done_object],
    ids=["dict", "object"],
)
async def test_responses_done_item_arguments_reach_the_call(done_item):
    """A provider that delivers the whole call ONLY on ``output_item.done`` -- the
    added item carries ``""`` and no argument delta ever streams -- must still
    produce those arguments. The completed item is the call's authoritative final
    value; reconstructing from the added item and the deltas alone yields a tool
    call with EMPTY arguments, on the wire and in the returned ModelResponse, and
    reports the turn as a clean success with no error and no log."""
    result, items = await _drive_responses(_FakeResponsesStream(_function_call_events(
        done=done_item('{"background":"red"}'),
    )))

    assert result.choices[0].message.tool_calls[0].function.arguments == (
        '{"background":"red"}'
    )
    chunks = [e for e in items if e.type == EventType.TOOL_CALL_CHUNK]
    assert "".join(c.delta or "" for c in chunks) == '{"background":"red"}'
    assert {c.tool_call_id for c in chunks} == {"call_abc"}


async def test_responses_done_item_does_not_duplicate_streamed_arguments():
    """Real OpenAI streams the arguments as deltas and THEN sends the completed
    item repeating the same complete value. Taking it a second time appends the
    whole arguments twice, on the wire and in the returned ModelResponse, so a
    delta-driven call keeps exactly what it accumulated."""
    result, items = await _drive_responses(_FakeResponsesStream(_function_call_events(
        deltas=('{"background":', '"red"}'),
        done=_function_call_item_done('{"background":"red"}'),
    )))

    assert result.choices[0].message.tool_calls[0].function.arguments == (
        '{"background":"red"}'
    )
    chunks = [e for e in items if e.type == EventType.TOOL_CALL_CHUNK]
    assert "".join(c.delta or "" for c in chunks) == '{"background":"red"}'


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
async def test_reasoning_demo_disables_parallel_tool_calls_on_responses(monkeypatch):
    """The Responses branch must pass ``parallel_tool_calls=False`` like the
    chat-completions branch and every other demo, or the default OpenAI path can
    emit parallel frontend tool calls."""
    spy = _ChannelSpy(monkeypatch)
    await _drive_reasoning_demo_with_actions("OpenAI", _DEMO_ACTIONS)
    assert spy.responses_calls, "OpenAI must stream over the Responses channel"
    assert spy.responses_calls[0]["parallel_tool_calls"] is False


@requires_stream_frames
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
    """One open AG-UI reasoning message cannot represent two provider items.

    Two ids inside ONE item's lifecycle, with no completion boundary between
    them, is a corrupt stream and still fails loudly. A completed item that is
    FOLLOWED by another is the ordinary multi-item turn, covered below.

    Matched on "changed", not on the shared "reasoning item id" phrase: the
    missing-id error carries that phrase too, so the looser pattern would pass on
    the wrong failure.
    """
    with pytest.raises(RuntimeError, match="changed reasoning item id"):
        await _drive_responses([
            _summary_delta("first", item_id="rs_first"),
            _summary_delta("second", item_id="rs_second"),
        ])


@pytest.mark.parametrize(
    "done_event",
    [_reasoning_item_done, _reasoning_item_done_object],
    ids=["dict-item", "object-item"],
)
async def test_responses_every_reasoning_item_of_a_turn_round_trips(done_event):
    """A turn with two reasoning items surfaces BOTH, completely.

    ``response.output_item.done`` is what ends an item. Without it the second
    item's id collides with the first still-open message and the whole run dies;
    even surviving that, only the first item would reach the client, so the rest
    of the turn's reasoning could never be replayed into the next turn's Responses
    input. OpenAI requires every reasoning item to come back with its encrypted
    content.

    Both item shapes litellm delivers across the supported range are exercised:
    ``OutputItemDoneEvent.item`` is a plain dict through the locked 1.72.0 and a
    response object on 1.96.2, so a driver reading only one of them closes on only
    one.
    """
    _, items = await _drive_responses([
        _summary_delta("first thought", item_id="rs_1"),
        done_event("BLOB_1", item_id="rs_1"),
        _summary_delta("second thought", item_id="rs_2"),
        done_event("BLOB_2", item_id="rs_2"),
        _text_delta("Answer"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    starts = [e for e in items if e.type == EventType.REASONING_START]
    ends = [e for e in items if e.type == EventType.REASONING_END]
    content = [e for e in items if e.type == EventType.REASONING_MESSAGE_CONTENT]
    encrypted = [e for e in items if e.type == EventType.REASONING_ENCRYPTED_VALUE]
    assert [e.message_id for e in starts] == ["rs_1", "rs_2"]
    assert [e.message_id for e in ends] == ["rs_1", "rs_2"]
    assert [(e.message_id, e.delta) for e in content] == [
        ("rs_1", "first thought"),
        ("rs_2", "second thought"),
    ]
    assert [(e.entity_id, e.encrypted_value) for e in encrypted] == [
        ("rs_1", "BLOB_1"),
        ("rs_2", "BLOB_2"),
    ]


async def test_responses_mapping_shaped_item_done_closes_its_reasoning_item():
    """A MAPPING-shaped ``output_item.done`` ends that item like any other shape.

    The type gate and the reasoning projection both read the event through
    ``responses_attr``, so the projection surfaces this item's encrypted blob and
    id; a driver that read the same event with a bare ``getattr`` would see no
    item, skip the close, and leave the message open for the NEXT item's id to
    collide with.
    """
    _, items = await _drive_responses([
        _summary_delta("first thought", item_id="rs_1"),
        _reasoning_item_done_mapping("BLOB_1", item_id="rs_1"),
        _summary_delta("second thought", item_id="rs_2"),
        _reasoning_item_done_mapping("BLOB_2", item_id="rs_2"),
        _text_delta("Answer"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    starts = [e for e in items if e.type == EventType.REASONING_START]
    ends = [e for e in items if e.type == EventType.REASONING_END]
    content = [e for e in items if e.type == EventType.REASONING_MESSAGE_CONTENT]
    encrypted = [e for e in items if e.type == EventType.REASONING_ENCRYPTED_VALUE]
    assert [e.message_id for e in starts] == ["rs_1", "rs_2"]
    assert [e.message_id for e in ends] == ["rs_1", "rs_2"]
    assert [(e.message_id, e.delta) for e in content] == [
        ("rs_1", "first thought"),
        ("rs_2", "second thought"),
    ]
    assert [(e.entity_id, e.encrypted_value) for e in encrypted] == [
        ("rs_1", "BLOB_1"),
        ("rs_2", "BLOB_2"),
    ]


def test_every_reasoning_item_of_a_turn_replays_as_its_own_responses_item():
    """The other half of the round trip: both messages convert back to items.

    What the driver surfaced above is what the client hands back on the next turn,
    so a turn that produced two reasoning items sends two back, each keyed by its
    provider id and carrying its own encrypted content.
    """
    items = responses_mod.chat_messages_to_responses_input([
        {"role": "user", "content": "hi"},
        {
            "role": "reasoning",
            "id": "rs_1",
            "content": "first thought",
            "encrypted_value": "BLOB_1",
        },
        {
            "role": "reasoning",
            "id": "rs_2",
            "content": "second thought",
            "encrypted_value": "BLOB_2",
        },
        {"role": "assistant", "content": "Answer"},
    ])

    reasoning_items = [i for i in items if i.get("type") == "reasoning"]
    assert reasoning_items == [
        {
            "id": "rs_1",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "first thought"}],
            "encrypted_content": "BLOB_1",
        },
        {
            "id": "rs_2",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "second thought"}],
            "encrypted_content": "BLOB_2",
        },
    ]


async def test_responses_completed_message_item_leaves_reasoning_alone():
    """Only a completed REASONING item ends a reasoning message.

    ``output_item.done`` also fires for the assistant message and for every
    function call, and closing on those would end a reasoning message that the
    model has not finished.
    """
    _, items = await _drive_responses([
        _summary_delta("still thinking", item_id="rs_1"),
        OutputItemDoneEvent(
            type="response.output_item.done",
            output_index=1,
            item={"id": "msg_1", "type": "message", "role": "assistant"},
        ),
        _summary_delta(" and thinking", item_id="rs_1"),
        _reasoning_item_done("BLOB", item_id="rs_1"),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    starts = [e for e in items if e.type == EventType.REASONING_START]
    content = [e for e in items if e.type == EventType.REASONING_MESSAGE_CONTENT]
    assert [e.message_id for e in starts] == ["rs_1"]
    assert [e.delta for e in content] == ["still thinking", " and thinking"]


# -- an async iterable that is not a Responses stream ------------------------
#
# Dispatch is async-iterability alone, so ANY async iterable reaches this driver.
# One carrying no Responses event drains to nothing, and reporting that as a
# finished assistant turn hides the mistake completely.


class _PlainAsyncIterable:
    """An async iterable carrying anything but Responses stream events."""

    def __init__(self, items):
        self._items = list(items)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._items:
            raise StopAsyncIteration
        return self._items.pop(0)


@pytest.mark.parametrize(
    "items",
    [
        [{"content": "hello"}, {"content": " world"}],
        ["hello", "world"],
        [SimpleNamespace(text="hello")],
        [],
    ],
    ids=["dicts", "strings", "objects", "empty"],
)
async def test_responses_driver_rejects_a_stream_it_recognises_nothing_in(items):
    """A non-Responses async iterable is a caller error, not an empty answer.

    Draining it and returning ``content=""`` with ``finish_reason="stop"`` hands
    the flow a finished assistant turn that never happened, with nothing raised
    and nothing logged. A real Responses turn always carries at least one event
    this driver acts on, so recognising none identifies the object as the wrong
    one and names the entrypoint that returns the right one.
    """
    with pytest.raises(ValueError) as excinfo:
        await copilotkit_stream(_PlainAsyncIterable(items))
    assert "copilotkit_responses" in str(excinfo.value), str(excinfo.value)


async def test_responses_driver_keeps_a_genuinely_empty_turn_a_clean_stop():
    """A turn that produced no content is NOT a failure.

    A model can legitimately answer with nothing, and that turn still carries its
    terminal event. Raising here would report a RUN_ERROR for a run that
    completed, so the guard keys on what the STREAM carried, not on what the turn
    produced.
    """
    result, _ = await _drive_responses([
        ResponseCreatedEvent(
            type="response.created", response=_responses_api_response("in_progress")
        ),
        ResponseCompletedEvent(
            type="response.completed", response=_responses_api_response()
        ),
    ])

    assert result.choices[0].message.content == ""
    assert result.choices[0].message.tool_calls is None
    assert result.choices[0].finish_reason == "stop"


async def test_responses_driver_still_streams_a_normal_turn():
    """The guard is invisible to a real turn: reasoning, answer text and the
    terminal event produce the same ModelResponse and the same wire events."""
    result, items = await _drive_responses(_reasoning_then_text_events())

    assert result.choices[0].message.content == "Answer"
    assert result.choices[0].finish_reason == "stop"
    types = [e.type for e in items]
    assert EventType.REASONING_MESSAGE_CONTENT in types, types
    assert EventType.TEXT_MESSAGE_CHUNK in types, types


async def test_responses_orphan_argument_delta_is_reported(caplog):
    """Argument deltas for a call the driver never saw opened are the whole turn
    here, and dropping them silently returns that same empty-but-successful
    assistant message. This IS a Responses stream, so the loss is a dropped
    payload rather than a dispatch error, and it is logged instead of raised."""
    with caplog.at_level(logging.ERROR, logger="ag_ui_crewai.sdk"):
        result, _ = await _drive_responses([
            FunctionCallArgumentsDeltaEvent(
                type="response.function_call_arguments.delta",
                item_id="fc_never_opened", output_index=0, delta='{"a":1}',
            ),
            ResponseCompletedEvent(
                type="response.completed", response=_responses_api_response()
            ),
        ])

    assert result.choices[0].message.tool_calls is None
    assert any(
        "fc_never_opened" in r.getMessage() for r in caplog.records
    ), caplog.text

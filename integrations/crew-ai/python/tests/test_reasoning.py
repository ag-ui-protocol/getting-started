"""Reasoning surfacing: provider-agnostic REASONING_* emission across both
channels (the litellm streaming delta via ``copilotkit_stream`` and crewai's
native ``LLMThinkingChunkEvent``) and both transports (the legacy event-bus
listener and the StreamFrame translator). No network.

Ordering note: the crewai 1.x event bus dispatches sync handlers on a
ThreadPoolExecutor, so bus-path tests assert the MULTISET of emitted events
(counts + content by message id), not cross-event capture order. Exact
lifecycle ordering is asserted against the synchronous ``StreamFrameTranslator``
and, end-to-end, by driving a real Flow through ``_run_flow_frame_stream`` and
decoding the SSE (the ordering there is deterministic).
"""

import json as _json

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
    # Never RAW-mirrored (recognized channel), even though RAW defaults off here.
    assert "RAW" not in types, types


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

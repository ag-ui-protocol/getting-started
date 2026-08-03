"""Streaming and event emission: ``copilotkit_stream`` reassembly, the
per-delta chunk events, ``copilotkit_predict_state``/``copilotkit_emit_state``,
and the endpoint listener's translation of bridged events to wire events.
No network."""

import asyncio
import json as _json
from types import SimpleNamespace

import pytest

from crewai.flow.flow import Flow, start

from ag_ui.core import EventType
from ag_ui_crewai import endpoint as ep
from ag_ui_crewai import _frames as frames_mod
from ag_ui_crewai._capabilities import CAPABILITIES, flow_supports_stream_frames
from ag_ui_crewai.context import flow_context
from ag_ui_crewai.events import (
    BridgedCustomEvent,
    BridgedTextMessageChunkEvent,
    BridgedToolCallChunkEvent,
)
from litellm import CustomStreamWrapper

from ag_ui_crewai.sdk import (
    CopilotKitState,
    copilotkit_emit_state,
    copilotkit_predict_state,
    copilotkit_stream,
)


async def _settle_bus(emit_result=None):
    """Let off-thread crewai 1.x event-bus handlers land on the queue.

    crewai 1.x dispatches our sync listener callbacks on a
    ThreadPoolExecutor worker thread, and ``_enqueue`` hops the result back
    onto the loop via ``call_soon_threadsafe``. A test that emits then drains
    synchronously must wait for the handler to finish AND give the loop one
    tick so the scheduled ``put_nowait`` runs.

    When the test holds the ``emit`` result (a ``concurrent.futures.Future``,
    or ``None`` when there are no handlers) we await it directly. When the emit
    happens INSIDE an SDK call (predict_state / emit_state / copilotkit_stream)
    we can't reach the future, so we ``flush`` the bus — which blocks until
    in-flight handlers complete — off the loop, then tick.
    """
    if emit_result is not None:
        try:
            await asyncio.wrap_future(emit_result)
        except Exception:  # noqa: BLE001 - handler errors surface elsewhere
            pass
    else:
        from ag_ui_crewai._capabilities import crewai_event_bus
        flush = getattr(crewai_event_bus, "flush", None)
        if callable(flush):
            try:
                await asyncio.get_running_loop().run_in_executor(
                    None, lambda: flush(5.0)
                )
            except Exception:  # noqa: BLE001 - flush is best-effort
                pass
    # One extra tick for the call_soon_threadsafe-scheduled put_nowait.
    await asyncio.sleep(0)


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


def _tool_call_delta(*, call_id, name, arguments, index=None):
    ns = SimpleNamespace(id=call_id, function={"name": name, "arguments": arguments})
    if index is not None:
        ns.index = index
    return ns


def _empty_choices_chunk(chunk_id):
    """A trailing usage-only chunk: valid envelope, empty ``choices`` list."""
    return {
        "id": chunk_id,
        "created": 1700000000,
        "model": "gpt-4o",
        "system_fingerprint": "fp_test",
        "choices": [],
    }


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
    from ag_ui_crewai._capabilities import crewai_event_bus

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
        # crewai 1.x runs these handlers off-thread; settle before asserting.
        await _settle_bus()

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
# Streaming-handler robustness (index routing + empty-list/choices guards)
# --------------------------------------------------------------------------

async def test_copilotkit_stream_routes_parallel_tool_calls_by_index():
    """Two tool calls interleaved across chunks (each carrying its OpenAI
    ``.index``) reassemble into TWO distinct calls with correctly-partitioned
    arguments — not one call with the args concatenated together."""
    flow_context.set(None)

    async def _gen():
        # First deltas for both calls (id-bearing), out of order.
        yield _stream_chunk("msg-p", tool_calls=[
            _tool_call_delta(call_id="call-A", name="alpha", arguments='{"a":', index=0),
        ])
        yield _stream_chunk("msg-p", tool_calls=[
            _tool_call_delta(call_id="call-B", name="beta", arguments='{"b":', index=1),
        ])
        # Continuation deltas (id/name absent), interleaved.
        yield _stream_chunk("msg-p", tool_calls=[
            _tool_call_delta(call_id=None, name=None, arguments="2}", index=1),
        ])
        yield _stream_chunk("msg-p", tool_calls=[
            _tool_call_delta(call_id=None, name=None, arguments="1}", index=0),
        ])
        yield _stream_chunk("msg-p", finish_reason="stop")

    resp = await copilotkit_stream(_FakeStreamWrapper(_gen()))
    calls = resp.choices[0].message.tool_calls
    assert calls is not None and len(calls) == 2
    by_id = {c.id: c for c in calls}
    assert by_id["call-A"].function.name == "alpha"
    assert by_id["call-A"].function.arguments == '{"a":1}'
    assert by_id["call-B"].function.name == "beta"
    assert by_id["call-B"].function.arguments == '{"b":2}'


async def test_copilotkit_stream_tolerates_args_before_id_chunk():
    """An argument delta arriving before any id-bearing chunk must not
    IndexError on an empty accumulator; it seeds a call whose id fills in
    when the id-bearing delta arrives."""
    flow_context.set(None)

    async def _gen():
        # Pathological: args first, no id, no index.
        yield _stream_chunk("msg-e", tool_calls=[
            _tool_call_delta(call_id=None, name=None, arguments='{"x":'),
        ])
        # id/name arrive on a later delta.
        yield _stream_chunk("msg-e", tool_calls=[
            _tool_call_delta(call_id="call-late", name="fn", arguments="1}"),
        ])
        yield _stream_chunk("msg-e", finish_reason="stop")

    resp = await copilotkit_stream(_FakeStreamWrapper(_gen()))
    calls = resp.choices[0].message.tool_calls
    assert calls is not None and len(calls) == 1
    assert calls[0].id == "call-late"
    assert calls[0].function.name == "fn"
    assert calls[0].function.arguments == '{"x":1}'


async def test_copilotkit_stream_index_less_echoed_id_is_one_call():
    """A provider that omits ``.index`` but re-echoes the same ``id`` on each
    continuation delta must reassemble into ONE call, not fragment per delta."""
    flow_context.set(None)

    async def _gen():
        yield _stream_chunk("msg-r", tool_calls=[
            _tool_call_delta(call_id="call-1", name="fn", arguments='{"a":'),
        ])
        # Same id echoed, no index -> continuation, not a new call.
        yield _stream_chunk("msg-r", tool_calls=[
            _tool_call_delta(call_id="call-1", name=None, arguments="1}"),
        ])
        yield _stream_chunk("msg-r", finish_reason="stop")

    resp = await copilotkit_stream(_FakeStreamWrapper(_gen()))
    calls = resp.choices[0].message.tool_calls
    assert calls is not None and len(calls) == 1
    assert calls[0].id == "call-1"
    assert calls[0].function.arguments == '{"a":1}'


async def test_copilotkit_stream_index_less_distinct_ids_are_separate_calls():
    """Two sequential calls with no ``.index`` but DIFFERENT ids stay separate
    (the echoed-id continuation rule must not merge genuinely distinct calls)."""
    flow_context.set(None)

    async def _gen():
        yield _stream_chunk("msg-d", tool_calls=[
            _tool_call_delta(call_id="call-1", name="fn1", arguments="{}"),
        ])
        yield _stream_chunk("msg-d", tool_calls=[
            _tool_call_delta(call_id="call-2", name="fn2", arguments="{}"),
        ])
        yield _stream_chunk("msg-d", finish_reason="stop")

    resp = await copilotkit_stream(_FakeStreamWrapper(_gen()))
    calls = resp.choices[0].message.tool_calls
    assert calls is not None and len(calls) == 2
    assert [c.id for c in calls] == ["call-1", "call-2"]


async def test_copilotkit_stream_skips_empty_choices_chunk():
    """A trailing usage-only chunk with an empty ``choices`` list is skipped,
    not an IndexError; surrounding content still reassembles."""
    flow_context.set(None)

    async def _gen():
        yield _stream_chunk("msg-c", content="Hi")
        yield _empty_choices_chunk("msg-c")  # would IndexError on choices[0]
        yield _stream_chunk("msg-c", finish_reason="stop")

    resp = await copilotkit_stream(_FakeStreamWrapper(_gen()))
    assert resp.choices[0].message.content == "Hi"
    assert resp.choices[0].finish_reason == "stop"


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
        await _settle_bus()
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


async def test_copilotkit_predict_state_tool_argument_is_optional():
    """``tool_argument`` is documented optional: omitting it must not KeyError,
    and the wire value carries ``tool_argument=None`` (whole-object streaming)."""
    ep.FastAPICrewFlowEventListener()  # registers bus handlers
    flow = _FakeFlow()
    queue = await ep.create_queue(flow)
    flow_context.set(flow)
    try:
        result = await copilotkit_predict_state({"steps": {"tool_name": "SearchTool"}})
        assert result is True
        await _settle_bus()
        items = _drain(queue)
    finally:
        await ep.delete_queue(flow)

    assert len(items) == 1
    event = items[0]
    assert event.type == EventType.CUSTOM
    assert event.name == "PredictState"
    assert event.value == [
        {"state_key": "steps", "tool": "SearchTool", "tool_argument": None}
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
        await _settle_bus()
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
    from ag_ui_crewai._capabilities import crewai_event_bus

    ep.FastAPICrewFlowEventListener()
    flow = _FakeFlow()
    queue = await ep.create_queue(flow)
    try:
        await _settle_bus(crewai_event_bus.emit(flow, BridgedTextMessageChunkEvent(
            type=EventType.TEXT_MESSAGE_CHUNK,
            message_id="m1", role="assistant", delta="hi",
        )))
        await _settle_bus(crewai_event_bus.emit(flow, BridgedToolCallChunkEvent(
            type=EventType.TOOL_CALL_CHUNK,
            tool_call_id="tc1", tool_call_name="searchTool", delta='{"q":1}',
        )))
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
    from ag_ui_crewai._capabilities import (
        crewai_event_bus,
        MethodExecutionFinishedEvent,
    )

    state = {
        "messages": [{"role": "assistant", "content": "done", "id": "m9"}],
        "outputs": "result-text",
    }
    ep.FastAPICrewFlowEventListener()
    flow = _FakeFlow(state=state)
    queue = await ep.create_queue(flow)
    try:
        await _settle_bus(crewai_event_bus.emit(flow, MethodExecutionFinishedEvent(
            type="method_execution_finished",
            method_name="chat",
            flow_name="ChatWithCrewFlow",
            result=None,
            state=state,
        )))
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


# --------------------------------------------------------------------------
# StreamFrame path: flow.astream() -> frame translator -> wire
# --------------------------------------------------------------------------

# Tests that drive a REAL crewai ``Flow.astream`` require the StreamFrame
# contract (crewai >= 1.6). On the 1.0-1.5 fallback the bridge uses the legacy
# bus-listener path (covered by the tests above), so these are skipped there.
requires_stream_frames = pytest.mark.skipif(
    not CAPABILITIES.stream_frame_available,
    reason="crewai>=1.6 StreamFrame contract required; 1.0-1.5 uses the "
    "legacy bus-listener fallback path",
)


def _decode_sse(encoded_items):
    """Decode a list of EventEncoder SSE strings into JSON payload dicts."""
    payloads = []
    for chunk in encoded_items:
        for line in chunk.splitlines():
            if line.startswith("data:"):
                payloads.append(_json.loads(line[len("data:"):].strip()))
    return payloads


async def _collect(agen):
    out = []
    async for item in agen:
        out.append(item)
    return out


def _ev(type, event_id=None, **attrs):  # noqa: A002 - mirror event.type
    """A RAW crewai/bridge event stand-in the translator reads by attribute.

    The translator now consumes raw event objects, so a
    lifecycle event is any object exposing ``.type`` (+ ``.method_name`` etc.)
    and a bridge event exposes its typed payload attributes directly — no
    ``to_serializable`` ``frame.data`` in the loop."""
    return SimpleNamespace(
        type=type,
        event_id=event_id or f"ev-{id(attrs)}",
        **attrs,
    )


class _FakeStreamSession:
    """Minimal AsyncStreamSession stand-in. Publishes each supplied RAW event to
    the scoped sink (as crewai's ``event_bus._prepare_event`` does) and then
    yields a StreamFrame-shaped stand-in whose ``id`` matches, so the driver's
    source-gated raw-event lookup finds it. Records whether ``aclose`` was
    called. Lets us unit-test the driver's teardown / ceiling handling without a
    live crewai run."""

    def __init__(self, events, *, source, hang=False):
        self._events = events
        self._source = source
        self._hang = hang
        self.aclosed = False
        # Instrumentation: how many frames the driver actually
        # consumed, and whether the iterator was drained to natural exhaustion
        # (vs stopped early via break + aclose).
        self.frames_yielded = 0
        self.exhausted = False

    async def _agen(self):
        from crewai.events.stream_context import publish_stream_event

        for ev in self._events:
            # The sink (registered by the driver in this same context) parks the
            # raw event; the frame supplies ordering + the id to look it up.
            publish_stream_event(self._source, ev)
            self.frames_yielded += 1
            yield _Frame(ev.type, id=ev.event_id)
        if self._hang:
            # Never terminate on its own — the ceiling / aclose must stop us.
            await asyncio.Event().wait()
        self.exhausted = True

    def __aiter__(self):
        return self._agen()

    async def aclose(self):
        self.aclosed = True


class _Frame:
    """StreamFrame-shaped stand-in (the driver reads only ``type`` / ``id``)."""

    def __init__(self, type, id):  # noqa: A002 - mirror StreamFrame.type / .id
        self.type = type
        self.id = id


# -- capability probe -------------------------------------------------------

def test_stream_frame_probe_is_per_flow_and_version_consistent():
    """The per-flow probe agrees with the resolved capability: a real Flow is
    routed to the StreamFrame path iff crewai exposes StreamFrame; a
    kickoff-only stub (the cancellation-test shape) ALWAYS takes the legacy
    path so its coverage is unaffected on either crewai line."""
    class _Real(Flow):
        @start()
        async def go(self):
            return None

    assert flow_supports_stream_frames(_Real()) is CAPABILITIES.stream_frame_available

    class _KickoffOnly:
        async def kickoff_async(self, inputs=None):
            return None

    assert flow_supports_stream_frames(_KickoffOnly()) is False


# -- translator wire shape (default = chunks) -------------------------------

def test_translator_produces_current_chunk_wire_shape():
    """The default translator maps bridge/lifecycle events onto exactly the
    events the legacy listener produced — chunks, not triples."""
    state = {"messages": [{"role": "assistant", "content": "hi", "id": "m1"}]}
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t-1", run_id="r-1", state_provider=lambda: state,
    )

    assert [e.type for e in tr.translate(_ev("flow_started"))] == [
        EventType.RUN_STARTED
    ]
    assert tr.run_started is True
    start_ev = tr.translate(_ev("method_execution_started", method_name="chat"))
    assert start_ev[0].type == EventType.STEP_STARTED
    assert start_ev[0].step_name == "chat"

    text = tr.translate(_ev(
        "TEXT_MESSAGE_CHUNK", message_id="m1", role="assistant", delta="hi",
    ))
    assert len(text) == 1
    assert text[0].type == EventType.TEXT_MESSAGE_CHUNK
    assert (text[0].message_id, text[0].role, text[0].delta) == ("m1", "assistant", "hi")

    tool = tr.translate(_ev(
        "TOOL_CALL_CHUNK", tool_call_id="tc1", tool_call_name="searchTool",
        delta='{"q":1}',
    ))
    assert tool[0].type == EventType.TOOL_CALL_CHUNK
    assert (tool[0].tool_call_id, tool[0].tool_call_name, tool[0].delta) == (
        "tc1", "searchTool", '{"q":1}'
    )

    custom = tr.translate(_ev("CUSTOM", name="PredictState", value=[1]))
    assert custom[0].type == EventType.CUSTOM
    assert (custom[0].name, custom[0].value) == ("PredictState", [1])

    snap = tr.translate(_ev("STATE_SNAPSHOT", snapshot={"p": 5}))
    assert snap[0].type == EventType.STATE_SNAPSHOT
    assert snap[0].snapshot == {"p": 5}

    finished = tr.translate(_ev("method_execution_finished", method_name="chat"))
    assert [e.type for e in finished] == [
        EventType.MESSAGES_SNAPSHOT, EventType.STATE_SNAPSHOT, EventType.STEP_FINISHED,
    ]
    assert finished[0].messages[0].id == "m1"
    assert finished[2].step_name == "chat"

    fin = tr.translate(_ev("flow_finished"))
    assert fin[0].type == EventType.RUN_FINISHED
    assert tr.run_finished is True
    # Idempotent: a second flow_finished never re-emits RUN_FINISHED.
    assert tr.translate(_ev("flow_finished")) == []

    # Native crewai channels / unknown events are dropped (behavior-preserving).
    assert tr.translate(_ev("llm_stream_chunk", chunk="x")) == []
    assert tr.translate(_ev("cc_env")) == []


def test_translator_maps_tool_call_result():
    """A bridged TOOL_CALL_RESULT (emitted by copilotkit_emit_tool_result for a
    backend-run tool) maps to a ToolCallResultEvent so middlewares that commit
    from the result (e.g. the A2UI fixed-schema paint) receive it."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict,
    )
    out = tr.translate(_ev(
        "TOOL_CALL_RESULT", message_id="m1", tool_call_id="c1",
        content='{"a2ui_operations":[]}',
    ))
    assert len(out) == 1
    assert out[0].type == EventType.TOOL_CALL_RESULT
    assert (
        out[0].message_id, out[0].tool_call_id, out[0].content, out[0].role
    ) == ("m1", "c1", '{"a2ui_operations":[]}', "tool")


def test_translator_preserves_tool_chunk_parent_message_id():
    """The tool-call chunk carries parent_message_id so the client keeps the
    tool call on its assistant message when the terminal MESSAGES_SNAPSHOT
    re-sends it (no re-anchor below streamed activities)."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict,
    )
    out = tr.translate(_ev(
        "TOOL_CALL_CHUNK", tool_call_id="c1", tool_call_name="generate_a2ui",
        parent_message_id="m1", delta="{}",
    ))
    assert out[0].type == EventType.TOOL_CALL_CHUNK
    assert out[0].parent_message_id == "m1"


def test_translator_emission_shape_is_swappable_and_defaults_to_chunks():
    """The emission shape is a single seam defaulting to chunks; the parity
    'triples' shape is a documented NotImplementedError placeholder."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict,
    )
    assert tr.emission_shape == "chunks"

    with pytest.raises(ValueError):
        frames_mod.StreamFrameTranslator(
            thread_id="t", run_id="r", state_provider=dict, emission_shape="bogus",
        )

    triples = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict, emission_shape="triples",
    )
    with pytest.raises(NotImplementedError):
        triples.translate(_ev("TEXT_MESSAGE_CHUNK", message_id="m", delta="x"))


# -- backend tool execution ------------------------------------------------

def test_translator_backend_tool_finished_emits_triples_then_result():
    """A crewai ``tool_usage_finished`` event surfaces the backend tool call as
    discrete START/ARGS/END (like the MCP path) followed by a TOOL_CALL_RESULT
    that carries the output and shares the tool_call_id. START carries a
    ``parent_message_id``.

    ``output`` is a STRING because that is what real crewai delivers
    (``ToolUsage._format_result`` returns ``str(result)``); the demo tool
    returns ``json.dumps(...)`` so the string is valid JSON the card can
    parse. The translator forwards it verbatim (no double-encode)."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict,
    )
    weather_json = '{"temperature": 20, "conditions": "sunny"}'
    out = tr.translate(_ev(
        "tool_usage_finished",
        tool_name="get_weather",
        tool_args={"location": "SF"},
        output=weather_json,
    ))
    assert [e.type for e in out] == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
    ]
    start, args, end, result = out
    assert start.tool_call_name == "get_weather"
    assert start.parent_message_id  # tied to the assistant message
    assert _json.loads(args.delta) == {"location": "SF"}
    ids = {e.tool_call_id for e in out}
    assert len(ids) == 1  # one call, one id across all four events
    assert result.content == weather_json
    assert _json.loads(result.content) == {"temperature": 20, "conditions": "sunny"}
    assert result.role == "tool"
    assert result.message_id and result.message_id != result.tool_call_id


def test_translator_backend_tool_output_dict_is_json_encoded_defensively():
    """When a caller delivers a structured (non-str) ``output``, it is
    JSON-encoded (defensive path; real crewai always sends a str)."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict,
    )
    out = tr.translate(_ev(
        "tool_usage_finished", tool_name="t", tool_args={},
        output={"temperature": 20, "conditions": "sunny"},
    ))
    assert _json.loads(out[-1].content) == {"temperature": 20, "conditions": "sunny"}


def test_translator_backend_tool_survives_messages_snapshot():
    """The client drops any message absent from a MESSAGES_SNAPSHOT, and the
    method-finish snapshot comes from ``state.messages`` (no tool call/result).
    The translator must merge the surfaced call + result in, or the streamed
    card is wiped at method-finish. The snapshot AssistantMessage id equals the
    streamed START ``parent_message_id`` so the client does not remount."""
    state = {"messages": [
        {"role": "user", "content": "weather in SF", "id": "u1"},
        {"role": "assistant", "content": "It is sunny in SF.", "id": "a1"},
    ]}
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=lambda: state,
    )
    out = tr.translate(_ev(
        "tool_usage_finished", tool_name="get_weather",
        tool_args={"location": "SF"},
        output='{"temperature": 20}',
    ))
    start = out[0]
    tool_call_id = out[-1].tool_call_id
    parent_message_id = start.parent_message_id

    finished = tr.translate(_ev("method_execution_finished", method_name="chat"))
    snapshot = finished[0]
    assert snapshot.type == EventType.MESSAGES_SNAPSHOT
    roles = [m.role for m in snapshot.messages]
    # user, then the injected tool call + result, then the assistant answer.
    assert roles == ["user", "assistant", "tool", "assistant"]
    asst_toolcall = snapshot.messages[1]
    tool_msg = snapshot.messages[2]
    # id continuity: streamed parent_message_id == snapshot assistant id.
    assert asst_toolcall.id == parent_message_id
    assert asst_toolcall.tool_calls[0].id == tool_call_id
    assert asst_toolcall.tool_calls[0].function.name == "get_weather"
    assert tool_msg.tool_call_id == tool_call_id
    assert tool_msg.content == '{"temperature": 20}'
    # A second snapshot does not duplicate the tool messages.
    again = tr.translate(_ev("method_execution_finished", method_name="chat"))
    assert [m.role for m in again[0].messages] == ["user", "assistant", "tool", "assistant"]


def test_translator_two_backend_tools_survive_snapshot_in_order():
    """Two backend tools in one method: both call/result pairs are surfaced and
    both survive the method-finish MESSAGES_SNAPSHOT, in call order, right after
    the user message and before the assistant answer."""
    state = {"messages": [
        {"role": "user", "content": "weather in SF and NYC", "id": "u1"},
        {"role": "assistant", "content": "Here you go.", "id": "a1"},
    ]}
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=lambda: state,
    )
    r1 = tr.translate(_ev(
        "tool_usage_finished", tool_name="get_weather",
        tool_args={"location": "SF"}, output='{"temperature": 20}',
    ))
    r2 = tr.translate(_ev(
        "tool_usage_finished", tool_name="get_weather",
        tool_args={"location": "NYC"}, output='{"temperature": 5}',
    ))
    tc1, tc2 = r1[1].tool_call_id, r2[1].tool_call_id
    assert tc1 != tc2

    snapshot = tr.translate(_ev("method_execution_finished", method_name="chat"))[0]
    roles = [m.role for m in snapshot.messages]
    assert roles == ["user", "assistant", "tool", "assistant", "tool", "assistant"]
    tool_call_ids = [
        m.tool_calls[0].id for m in snapshot.messages
        if m.role == "assistant" and getattr(m, "tool_calls", None)
    ]
    assert tool_call_ids == [tc1, tc2]  # call order preserved


def test_translator_backend_tool_snapshot_insert_after_system_when_no_user():
    """When the snapshot has a system message but no user message, the backend
    tool call/result are inserted AFTER the system preamble, not ahead of it."""
    state = {"messages": [{"role": "system", "content": "sys", "id": "s1"}]}
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=lambda: state,
    )
    tr.translate(_ev(
        "tool_usage_finished", tool_name="t", tool_args={}, output="ok",
    ))
    snapshot = tr.translate(_ev("method_execution_finished", method_name="chat"))[0]
    assert [m.role for m in snapshot.messages] == ["system", "assistant", "tool"]


def test_stringify_tool_output_branches():
    """Defensive ``_stringify_tool_output`` coverage: None -> ""; pydantic-like
    (model_dump) -> JSON; a plain object -> JSON of its str() (json.dumps
    default=str); and a genuinely unencodable value (circular) -> str() fallback
    on the logged except path."""
    f = frames_mod.StreamFrameTranslator._stringify_tool_output
    assert f(None) == ""

    class _Model:
        def model_dump(self):
            return {"a": 1}

    assert _json.loads(f(_Model())) == {"a": 1}

    class _Obj:
        def __repr__(self):
            return "<obj>"

    # default=str lets json.dumps encode a plain object as its str().
    assert f(_Obj()) == '"<obj>"'

    # A circular structure cannot be JSON-encoded even with default=str, so the
    # except path fires and falls back to str().
    circular: dict = {}
    circular["self"] = circular
    assert f(circular) == str(circular)


def test_tool_args_to_json_branches():
    """``_tool_args_to_json``: str passthrough, None -> '{}', dict -> JSON."""
    f = frames_mod.StreamFrameTranslator._tool_args_to_json
    assert f('{"raw": 1}') == '{"raw": 1}'
    assert f(None) == "{}"
    assert _json.loads(f({"a": 1})) == {"a": 1}


def test_translator_backend_tool_started_is_dropped():
    """``tool_usage_started`` emits nothing; the whole call+result is emitted
    atomically on ``tool_usage_finished`` (no dangling call)."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict,
    )
    assert tr.translate(_ev(
        "tool_usage_started", tool_name="get_weather", tool_args={"location": "SF"},
    )) == []


def test_translator_backend_tool_error_events_are_dropped():
    """crewai retries backend tools up to 3x, emitting an error event per failed
    attempt before any tool runs. Surfacing them would render phantom cards and,
    once recorded to MESSAGES_SNAPSHOT, poison history. Like LangGraph's
    OnToolError, we emit nothing; a terminal failure still surfaces via
    ``tool_usage_finished`` (its error text in ``output``)."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=lambda: {"messages": []},
    )
    for etype in (
        "tool_usage_error",
        "tool_execution_error",
        "tool_validate_input_error",
        "tool_selection_error",
    ):
        assert tr.translate(_ev(
            etype, tool_name="get_weather", tool_args={"location": "SF"},
            error="upstream 500",
        )) == [], etype
    # And nothing was recorded into the snapshot (no phantom history).
    snap = tr.translate(_ev("method_execution_finished", method_name="chat"))[0]
    assert snap.messages == []


def test_translator_backend_mcp_tool_is_not_double_surfaced():
    """An MCP tool is a crewai BaseTool that ALSO emits ToolUsage. It has its own
    MCP translation seam, so the backend path must skip it (probe by tool_class)
    or the client renders two cards for one execution."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict,
    )
    for cls in ("MCPToolWrapper", "MCPNativeTool"):
        assert tr.translate(_ev(
            "tool_usage_finished", tool_name="search", tool_args={},
            output="ok", tool_class=cls,
        )) == [], cls
    # A normal backend tool (any other tool_class) still surfaces.
    out = tr.translate(_ev(
        "tool_usage_finished", tool_name="search", tool_args={},
        output="ok", tool_class="MyTool",
    ))
    assert out[0].type == EventType.TOOL_CALL_START


def test_translator_backend_tool_string_args_passthrough():
    """crewai ``tool_args`` may be a raw string; it is forwarded verbatim on the
    ARGS event rather than re-encoded."""
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=dict,
    )
    out = tr.translate(_ev(
        "tool_usage_finished", tool_name="t", tool_args='{"raw": true}', output="ok",
    ))
    args = next(e for e in out if e.type == EventType.TOOL_CALL_ARGS)
    assert args.delta == '{"raw": true}'


def test_is_backend_tool_event_predicate():
    """The sink gate recognises only started/finished; error events are NOT
    parked (they are dropped, so they never need to reach the translator)."""
    for t in ("tool_usage_started", "tool_usage_finished"):
        assert frames_mod.is_backend_tool_event(_ev(t)) is True
    for t in (
        "tool_usage_error", "tool_execution_error",
        "tool_validate_input_error", "tool_selection_error",
        "flow_started",
    ):
        assert frames_mod.is_backend_tool_event(_ev(t)) is False
    assert frames_mod.is_backend_tool_event(_ev(EventType.TEXT_MESSAGE_CHUNK)) is False


def test_is_recognized_event_covers_mapped_channels():
    """RAW passthrough must not duplicate a mapped event. is_recognized_event
    covers backend ToolUsage (incl. the suppressed ``started``), crew/agent
    lifecycle, and MCP, alongside the base types."""
    for t in (
        "tool_usage_started", "tool_usage_finished",
        "crew_kickoff_started", "agent_execution_started",
        "mcp_tool_execution_started", "flow_started",
        EventType.TEXT_MESSAGE_CHUNK,
    ):
        assert frames_mod.is_recognized_event(_ev(t)) is True, t
    # A genuinely foreign event is NOT recognized (eligible for RAW).
    assert frames_mod.is_recognized_event(_ev("cc_env")) is False


# -- end-to-end through a REAL crewai Flow via astream ----------------------

class _BridgeEmittingFlow(Flow):
    """A real crewai Flow whose method emits the bridge's own events (exactly
    as ``sdk.copilotkit_stream`` does) so they round-trip through astream."""

    @start()
    async def chat(self):
        f = flow_context.get(None)
        from ag_ui_crewai._capabilities import crewai_event_bus
        crewai_event_bus.emit(f, BridgedTextMessageChunkEvent(
            type=EventType.TEXT_MESSAGE_CHUNK, message_id="m1", role="assistant", delta="Hello ",
        ))
        crewai_event_bus.emit(f, BridgedTextMessageChunkEvent(
            type=EventType.TEXT_MESSAGE_CHUNK, message_id="m1", role="assistant", delta="world",
        ))
        crewai_event_bus.emit(f, BridgedCustomEvent(
            type=EventType.CUSTOM, name="Exit", value="",
        ))
        return "done"


@requires_stream_frames
async def test_frame_path_end_to_end_matches_legacy_wire_shape():
    """Driving a real Flow through the StreamFrame path yields RUN_STARTED,
    STEP_STARTED, per-delta TEXT_MESSAGE_CHUNK, a CUSTOM, then
    MESSAGES/STATE snapshot + STEP_FINISHED + RUN_FINISHED — the same wire
    shape the legacy listener produced."""
    from ag_ui.encoder import EventEncoder

    flow = _BridgeEmittingFlow()
    input_data = _make_run_input()
    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=input_data,
        inputs={"id": "t-1"},
        timeout=30.0,
    ))
    payloads = _decode_sse(encoded)
    types = [p["type"] for p in payloads]

    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert types.count("TEXT_MESSAGE_CHUNK") == 2
    assert "STEP_STARTED" in types
    assert "STEP_FINISHED" in types
    assert "CUSTOM" in types
    assert "MESSAGES_SNAPSHOT" in types
    # No START/CONTENT/END triples — behavior-preserving chunk shape.
    assert not any(t.endswith("_START") or t.endswith("_END") for t in types
                   if t not in ("RUN_STARTED",))
    # Correlation ids are stamped, not the listener's "?" placeholders.
    run_started = next(p for p in payloads if p["type"] == "RUN_STARTED")
    assert run_started["threadId"] == "t-1"
    assert run_started["runId"] == "r-1"
    text_deltas = [p["delta"] for p in payloads if p["type"] == "TEXT_MESSAGE_CHUNK"]
    assert text_deltas == ["Hello ", "world"]


class _BackendToolFlow(Flow):
    """A real Flow that emits a crewai ``tool_usage_finished`` event from a
    worker thread (via ``asyncio.to_thread``, as the demo runs ``crew.kickoff``)
    with a non-flow source. Exercises end-to-end: the sink parking a
    non-``flow_copy`` event, the contextvar copy across the thread hop,
    translation, and snapshot survival. ``output`` is a JSON string because
    crewai stringifies tool output before emitting."""

    @start()
    async def chat(self):
        from datetime import datetime, timezone
        from crewai.events.types.tool_usage_events import ToolUsageFinishedEvent
        from ag_ui_crewai._capabilities import crewai_event_bus

        now = datetime.now(timezone.utc)

        def _emit_from_worker():
            crewai_event_bus.emit(object(), ToolUsageFinishedEvent(
                tool_name="get_weather",
                tool_args={"location": "SF"},
                output='{"temperature": 20, "conditions": "sunny"}',
                started_at=now,
                finished_at=now,
            ))

        # Off the loop, contextvars copied (same hop the demo's crew.kickoff
        # takes). The scoped StreamFrame sink must still receive the event.
        await asyncio.to_thread(_emit_from_worker)
        return "done"


@requires_stream_frames
async def test_frame_path_surfaces_backend_tool_call_and_result():
    """A backend tool executed inside the run (from a worker thread) surfaces as
    TOOL_CALL_START/ARGS/END + TOOL_CALL_RESULT, bracketed by exactly one
    RUN_STARTED / RUN_FINISHED, the result carrying the output and sharing the
    call's tool_call_id, and both survive the method-finish MESSAGES_SNAPSHOT so
    the card is not wiped."""
    from ag_ui.encoder import EventEncoder

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=_BackendToolFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    ))
    payloads = _decode_sse(encoded)
    types = [p["type"] for p in payloads]

    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert types.count("RUN_STARTED") == 1
    assert types.count("RUN_FINISHED") == 1
    assert types.count("TOOL_CALL_RESULT") == 1
    assert types.count("TOOL_CALL_START") == 1

    start = next(p for p in payloads if p["type"] == "TOOL_CALL_START")
    args = next(p for p in payloads if p["type"] == "TOOL_CALL_ARGS")
    result = next(p for p in payloads if p["type"] == "TOOL_CALL_RESULT")
    assert start["toolCallName"] == "get_weather"
    assert start.get("parentMessageId")
    assert _json.loads(args["delta"]) == {"location": "SF"}
    assert start["toolCallId"] == result["toolCallId"]
    assert _json.loads(result["content"]) == {"temperature": 20, "conditions": "sunny"}
    assert result["role"] == "tool"

    # The surfaced tool call + result must appear in the terminal
    # MESSAGES_SNAPSHOT (same tool_call_id) or the client wipes the card.
    snapshot = next(p for p in payloads if p["type"] == "MESSAGES_SNAPSHOT")
    snap_msgs = snapshot["messages"]
    asst = next(
        m for m in snap_msgs
        if m.get("role") == "assistant" and m.get("toolCalls")
    )
    tool_msg = next(m for m in snap_msgs if m.get("role") == "tool")
    # id continuity: streamed START parentMessageId == snapshot assistant id.
    assert asst["id"] == start["parentMessageId"]
    assert asst["toolCalls"][0]["id"] == result["toolCallId"]
    assert asst["toolCalls"][0]["function"]["name"] == "get_weather"
    assert tool_msg["toolCallId"] == result["toolCallId"]
    assert _json.loads(tool_msg["content"]) == {"temperature": 20, "conditions": "sunny"}


def _make_run_input(thread_id="t-1", run_id="r-1"):
    from ag_ui.core import RunAgentInput
    return RunAgentInput(
        thread_id=thread_id, run_id=run_id, state={}, messages=[], tools=[],
        context=[], forwarded_props={},
    )


# -- ONE RUN_STARTED / ONE RUN_FINISHED per HTTP run --------------

class _InnerKickoffFlow(Flow):
    """Stands in for the ``crew.kickoff`` a ``ChatWithCrewFlow.chat`` runs
    mid-method. A real crew kickoff drives crewai's experimental agent
    executor THROUGH the flow runtime, so it emits its own ``flow_started`` /
    ``flow_finished`` frames — reproduced here with a real nested Flow so the
    test needs no LLM/network."""

    @start()
    async def go(self):
        return "inner-done"


class _TwoCompletionCrewFlow(Flow):
    """A real Flow that performs TWO internal operations in ONE run — exactly
    the crew-tool path shape (``crew.kickoff`` off the event loop, then a
    follow-up completion). The nested kickoff runs via
    ``asyncio.to_thread`` (as the bridge offloads ``crew.kickoff``), which
    copies the scoped stream-sink contextvar, so the inner flow's
    ``flow_started`` / ``flow_finished`` frames land on THIS run's sink."""

    @start()
    async def chat(self):
        # Completion #1 surrogate: the nested (crew) kickoff. Off the loop, as
        # ``crews.py`` runs ``crew_function`` via ``asyncio.to_thread``.
        await asyncio.to_thread(lambda: _InnerKickoffFlow().kickoff())
        # Completion #2: the follow-up completion that
        # makes the assistant speak about the crew result. ``copilotkit_stream``
        # emits this as a bridged TEXT_MESSAGE_CHUNK on the same sink.
        f = flow_context.get(None)
        from ag_ui_crewai._capabilities import crewai_event_bus
        crewai_event_bus.emit(f, BridgedTextMessageChunkEvent(
            type=EventType.TEXT_MESSAGE_CHUNK,
            message_id="m-followup", role="assistant", delta="Crew is done.",
        ))
        return "done"


@requires_stream_frames
async def test_frame_path_two_completions_emit_single_run_lifecycle():
    """A run whose flow method performs two internal completions —
    a nested (crew) kickoff plus a follow-up — must emit EXACTLY ONE
    RUN_STARTED (first) and ONE RUN_FINISHED (last), with the follow-up text
    streaming in between.

    Pre-fix, the nested kickoff's ``flow_started`` produced a SECOND
    RUN_STARTED (the client rejects it: "Cannot send 'RUN_STARTED' while a run
    is still active"), and its ``flow_finished`` tripped ``is_run_end`` so the
    driver broke BEFORE the follow-up text streamed."""
    from ag_ui.encoder import EventEncoder

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=_TwoCompletionCrewFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    ))
    payloads = _decode_sse(encoded)
    types = [p["type"] for p in payloads]

    # Exactly one RUN_STARTED and one RUN_FINISHED, bracketing the run.
    assert types.count("RUN_STARTED") == 1, types
    assert types.count("RUN_FINISHED") == 1, types
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"

    # The follow-up text reaches the client, inside the run.
    assert "TEXT_MESSAGE_CHUNK" in types, types
    follow = next(p for p in payloads if p["type"] == "TEXT_MESSAGE_CHUNK")
    assert follow["delta"] == "Crew is done."
    assert types.index("TEXT_MESSAGE_CHUNK") < types.index("RUN_FINISHED")


# -- Review invariants: raw-payload fidelity, nested non-leak, terminal


class _ProgressiveStateFlow(Flow):
    """Emits an intermediate ``copilotkit_emit_state`` (as agentic_generative_ui
    does mid-method) carrying string, deeply-nested, and reserved-name values."""

    @start()
    async def chat(self):
        await copilotkit_emit_state({
            "steps": [{"description": "Digging hole", "status": "completed"}],
            # user-state keys that collide with crewai's _FRAME_DATA_EXCLUDE set
            "type": "user-type",
            "timestamp": "user-ts",
            # a value at depth >= 5, where to_serializable() falls back to repr()
            "deep": {"a": {"b": {"c": {"d": {"e": "deep-string"}}}}},
        })
        return "done"


@requires_stream_frames
async def test_frame_path_progressive_state_snapshot_is_verbatim():
    """The intermediate STATE_SNAPSHOT must equal the LIVE
    state ``copilotkit_emit_state`` was given — no ``repr()`` quoting of strings
    at depth >= 5, no dropping of user keys named ``type`` / ``timestamp``.

    Pre-fix the translator built the snapshot from ``frame.data`` (crewai's
    ``to_serializable(max_depth=5)`` output), so ``description`` arrived as
    ``\"'Digging hole'\"`` and the depth-5 string was stringified — exactly the
    corruption those progressive demos exist to surface. Verified against the
    crewai 1.15.7 wheel."""
    from ag_ui.encoder import EventEncoder

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=_ProgressiveStateFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    ))
    payloads = _decode_sse(encoded)
    # The intermediate emit (the one carrying "steps"), NOT the method-finished
    # snapshot built from the flow's own state.
    snap = next(
        p["snapshot"] for p in payloads
        if p["type"] == "STATE_SNAPSHOT" and "steps" in (p.get("snapshot") or {})
    )
    # No repr quoting of shallow strings.
    assert snap["steps"][0]["description"] == "Digging hole", snap
    assert snap["steps"][0]["status"] == "completed", snap
    # Depth-5 string survives intact (pre-fix: a repr'd dict string).
    assert snap["deep"]["a"]["b"]["c"]["d"]["e"] == "deep-string", snap
    # User keys colliding with _FRAME_DATA_EXCLUDE are preserved verbatim.
    assert snap["type"] == "user-type", snap
    assert snap["timestamp"] == "user-ts", snap


class _NestedNoLeakFlow(Flow):
    """One outer method that performs a nested (crew-shaped) kickoff off the
    loop. The nested flow emits its OWN method_execution_* / flow_* frames onto
    this run's sink (contextvars copied by ``to_thread``)."""

    @start()
    async def chat(self):
        await asyncio.to_thread(lambda: _InnerKickoffFlow().kickoff())
        return "done"


@requires_stream_frames
async def test_frame_path_nested_flow_frames_do_not_leak():
    """A nested kickoff must NOT inject a second
    STEP_STARTED / MESSAGES_SNAPSHOT / STATE_SNAPSHOT / STEP_FINISHED built from
    the OUTER flow's state. The outer run has exactly ONE method, so each of
    those appears exactly once — matching the legacy (``source is flow_copy``)
    wire shape.

    Pre-fix the nested ``method_execution_*`` frames passed the depth gate
    (which only guarded flow_started/finished), so a mid-run authoritative
    MESSAGES_SNAPSHOT from stale outer state could wipe streamed text."""
    from ag_ui.encoder import EventEncoder

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=_NestedNoLeakFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    ))
    types = [p["type"] for p in _decode_sse(encoded)]

    assert types.count("RUN_STARTED") == 1, types
    assert types.count("RUN_FINISHED") == 1, types
    # Exactly one outer method => one of each step/snapshot event; no nested leak.
    assert types.count("STEP_STARTED") == 1, types
    assert types.count("STEP_FINISHED") == 1, types
    assert types.count("MESSAGES_SNAPSHOT") == 1, types
    assert types.count("STATE_SNAPSHOT") == 1, types
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"


class _NestedRaisingInnerFlow(Flow):
    @start()
    async def boom(self):
        raise RuntimeError("nested boom")


class _OuterCatchesNestedErrorFlow(Flow):
    """The outer method runs a nested kickoff that RAISES, catches it, and
    continues to completion — the exact shape where crewai emits NO nested
    ``flow_finished`` (it fires only on the nested success path)."""

    @start()
    async def chat(self):
        try:
            await asyncio.to_thread(lambda: _NestedRaisingInnerFlow().kickoff())
        except Exception:  # noqa: BLE001 - outer intentionally swallows + continues
            pass
        return "outer-survived"


@requires_stream_frames
async def test_frame_path_nested_error_still_terminates_run():
    """A nested flow that raises (so its ``flow_finished``
    is never emitted) while the outer method catches and continues must STILL
    terminate the run — exactly one RUN_STARTED and a final RUN_FINISHED (or
    RUN_ERROR), never a run that ends with neither.

    Pre-fix the depth counter stuck at a non-zero value (the nested
    ``flow_started`` bumped it, the missing nested ``flow_finished`` never
    unwound it), so the outer ``flow_finished`` saw depth > 0 and emitted no
    RUN_FINISHED — the client saw a run that never ended. Verified against the
    crewai 1.15.7 wheel."""
    from ag_ui.encoder import EventEncoder

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=_OuterCatchesNestedErrorFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    ))
    types = [p["type"] for p in _decode_sse(encoded)]

    assert types.count("RUN_STARTED") == 1, types
    assert types[0] == "RUN_STARTED"
    # The run ALWAYS terminates — never ends with neither terminator.
    assert types[-1] in ("RUN_FINISHED", "RUN_ERROR"), types
    assert "RUN_FINISHED" in types or "RUN_ERROR" in types, types


# -- sink source-gating: crew/agent parked, nested-flow method dropped ------

class _MixedSourceSession:
    """AsyncStreamSession stand-in that publishes each RAW event to the scoped
    sink under a PER-EVENT source (not one shared source), so we can drive the
    sink's crew/agent-vs-nested-flow source gate directly."""

    def __init__(self, pairs):
        self._pairs = pairs
        self.aclosed = False

    async def _agen(self):
        from crewai.events.stream_context import publish_stream_event

        for source, ev in self._pairs:
            publish_stream_event(source, ev)
            yield _Frame(ev.type, id=ev.event_id)

    def __aiter__(self):
        return self._agen()

    async def aclose(self):
        self.aclosed = True


class _MixedSourceFlow:
    state = {}

    def __init__(self, session):
        self._session = session

    def astream(self, inputs=None):
        return self._session


@requires_stream_frames
async def test_frame_path_sink_parks_crew_agent_but_drops_nested_flow_method():
    """The driver's scoped ``_sink`` parks crew/agent lifecycle events even when
    their source is NOT the outer flow (they are run-scoped), while a nested
    FLOW method event (non-crew/agent, non-outer source) is dropped."""
    from ag_ui.encoder import EventEncoder

    outer = _MixedSourceFlow(None)  # session attached once the pairs reference it
    other = object()  # a non-outer source (nested-flow / crew emitter)

    pairs = [
        (outer, _ev("flow_started", event_id="fs")),
        (outer, _ev("method_execution_started", event_id="ms", method_name="m")),
        # Crew event from a NON-outer source -> parked (surfaces as a STEP).
        (other, _ev("crew_kickoff_started", event_id="cs", crew_name="research_crew")),
        # Nested-FLOW method from a NON-outer source -> dropped (no STEP).
        (other, _ev("method_execution_started", event_id="nested",
                    method_name="nested_method")),
        (other, _ev("crew_kickoff_completed", event_id="cc", crew_name="research_crew")),
        (outer, _ev("method_execution_finished", event_id="mf", method_name="m")),
        (outer, _ev("flow_finished", event_id="ff")),
    ]
    outer._session = _MixedSourceSession(pairs)

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=outer,
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={},
        timeout=30.0,
    ))
    payloads = _decode_sse(encoded)
    started_names = [p["stepName"] for p in payloads if p["type"] == "STEP_STARTED"]

    assert "research_crew" in started_names   # crew parked despite non-outer source
    assert "nested_method" not in started_names  # nested-flow method dropped
    assert "m" in started_names               # outer method still surfaces


# -- per-request flow COPY seeds state before @start runs ------

class _StateReadingFlow(Flow[CopilotKitState]):
    """A real crewai Flow shaped like the served example flows
    (``Flow[CopilotKitState]`` with attribute state access,
    ``self.state.messages`` / ``self.state.copilotkit.actions`` — exactly like
    ``examples/agentic_chat.py``). The class-level ``_seen`` sink records what
    the running @start observed."""

    _seen: dict = {}

    @start()
    async def chat(self):
        _StateReadingFlow._seen = {
            "self_id": id(self),
            "messages": [m for m in self.state.messages],
            "actions": [a for a in self.state.copilotkit.actions],
        }


@requires_stream_frames
async def test_copied_example_flow_astream_seeds_state_before_start_runs():
    """Flow-demo path: a per-request COPY of an example-shaped
    ``Flow[CopilotKitState]``, driven through the REAL
    ``crewai_prepare_inputs`` -> ``flow.astream(inputs=...)`` seam
    ``add_crewai_flow_fastapi_endpoint`` uses on crewai 1.6+, must seed
    ``messages`` / ``copilotkit`` into the COPY's state BEFORE ``@start`` runs.

    Same root cause as the crew path: pre-fix, ``_copy_flow``'s pin-and-share
    fallback shared the original's ``_methods`` (bound to the ORIGINAL), so
    ``astream`` seeded the COPY's state while ``chat`` executed against the
    un-seeded ORIGINAL -> ``AttributeError`` / empty reads. With the
    ``_copy_flow`` rebind the running method sees the seeded copy."""
    from ag_ui.core import Tool, UserMessage

    _StateReadingFlow._seen = {}
    flow = _StateReadingFlow()
    flow_copy = ep._copy_flow(flow)

    inputs = ep.crewai_prepare_inputs(
        state={},
        messages=[UserMessage(id="u1", role="user", content="hi flow")],
        tools=[Tool(name="do_thing", description="", parameters={"type": "object"})],
    )
    inputs["id"] = "thread-flow"

    session = flow_copy.astream(inputs=inputs)
    async for _frame in session:
        pass

    seen = _StateReadingFlow._seen
    assert [m["content"] for m in seen["messages"]] == ["hi flow"]
    assert [a["function"]["name"] for a in seen["actions"]] == ["do_thing"]
    # Executed against the COPY, and per-request isolation is preserved.
    assert seen["self_id"] == id(flow_copy)
    assert flow_copy._methods["chat"].__self__ is flow_copy
    assert flow._methods["chat"].__self__ is flow


# -- RUN_ERROR taxonomy + env knobs on the StreamFrame path -----------------

class _RaisingFlow(Flow):
    class _BoomError(Exception):
        pass

    @start()
    async def go(self):
        raise _RaisingFlow._BoomError("kaboom")


@requires_stream_frames
async def test_frame_path_flow_error_taxonomy_preserved():
    """A flow exception surfaces as AGUI_CREWAI_FLOW_ERROR_<Class> with a
    sanitized class name and camelCase correlation extras."""
    from ag_ui.encoder import EventEncoder

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=_RaisingFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={},
        timeout=30.0,
    ))
    payloads = _decode_sse(encoded)
    err = next(p for p in payloads if p["type"] == "RUN_ERROR")
    assert err["code"] == "AGUI_CREWAI_FLOW_ERROR_BOOMERROR"
    assert err["threadId"] == "t-1"
    assert err["runId"] == "r-1"
    # Coarse client message; no internal repr leak.
    assert "kaboom" not in err["message"]


class _HangingFlow(Flow):
    started = False

    @start()
    async def go(self):
        type(self).started = True
        await asyncio.sleep(60)
        return None


@requires_stream_frames
async def test_frame_path_ceiling_emits_flow_timeout_and_tears_down():
    """The wall-clock ceiling fires on the StreamFrame path, emits
    AGUI_CREWAI_FLOW_TIMEOUT, and aclose() tears the hung run down promptly."""
    from ag_ui.encoder import EventEncoder

    flow = _HangingFlow()
    start_t = asyncio.get_event_loop().time()
    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={},
        timeout=0.3,
    ))
    elapsed = asyncio.get_event_loop().time() - start_t
    payloads = _decode_sse(encoded)
    err = next(p for p in payloads if p["type"] == "RUN_ERROR")
    assert err["code"] == "AGUI_CREWAI_FLOW_TIMEOUT"
    # Ceiling ~0.3s; teardown must not hang for the flow's 60s sleep.
    assert elapsed < 10.0


async def test_frame_path_aclose_called_on_early_generator_close():
    """Closing the driver generator early (client disconnect) invokes
    aclose() on the session so the background kickoff task is torn down."""
    from ag_ui.encoder import EventEncoder

    class _AstreamFlow:
        state = {}

        def astream(self, inputs=None):
            return session

    flow_copy = _AstreamFlow()
    session = _FakeStreamSession(
        [
            _ev("flow_started", event_id="fs"),
            _ev("TEXT_MESSAGE_CHUNK", event_id="tx",
                message_id="m", role="assistant", delta="x"),
        ],
        source=flow_copy,
        hang=True,
    )

    gen = ep._run_flow_frame_stream(
        flow_copy=flow_copy,
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={},
        timeout=30.0,
    )
    # Consume the first couple of events, then close early.
    first = await gen.__anext__()
    assert "RUN_STARTED" in first
    await gen.aclose()
    assert session.aclosed is True


# -- raising astream is mapped to RUN_ERROR + no contextvar leak --

async def test_frame_path_raising_astream_emits_run_error_and_resets_context():
    """If ``astream`` (or ``__aiter__``) raises, the driver must
    (a) map it through the RUN_ERROR taxonomy — not let it escape the generator
    with no terminal event — and (b) never leak the ``flow_context`` token into
    the caller's context. Pre-fix, ``astream()``/``__aiter__()`` sat before the
    ``try``, so a raise skipped both the except-handlers and the finally reset."""
    from ag_ui.encoder import EventEncoder

    flow_context.set(None)

    class _AstreamBoom(Exception):
        pass

    class _RaisingAstreamFlow:
        state = {}

        def astream(self, inputs=None):
            raise _AstreamBoom("astream failed before any frame")

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=_RaisingAstreamFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={},
        timeout=30.0,
    ))
    payloads = _decode_sse(encoded)
    # (a) A single, taxonomy-coded RUN_ERROR — not a silent escape.
    assert [p["type"] for p in payloads] == ["RUN_ERROR"]
    assert payloads[0]["code"] == "AGUI_CREWAI_FLOW_ERROR_ASTREAMBOOM"
    assert payloads[0]["threadId"] == "t-1"
    assert payloads[0]["runId"] == "r-1"
    # (b) The contextvar set at driver entry was reset in the finally.
    assert flow_context.get(None) is None


# -- drain the terminal tail; don't cancel kickoff mid-finalize ---

async def test_frame_path_drains_tail_after_run_finished():
    """After RUN_FINISHED the driver drains the frame stream to
    natural exhaustion (so crewai's kickoff task finishes finalization) instead
    of breaking immediately and letting aclose() cancel it. A frame arriving
    AFTER flow_finished is consumed (drained) but produces no wire event."""
    from ag_ui.encoder import EventEncoder

    class _AstreamFlow:
        state = {}

        def astream(self, inputs=None):
            return session

    flow_copy = _AstreamFlow()
    session = _FakeStreamSession(
        [
            _ev("flow_started", event_id="fs"),
            _ev("flow_finished", event_id="ff"),
            # A trailing frame after flow_finished — the tail crewai keeps
            # producing while the kickoff task finalizes.
            _ev(EventType.CUSTOM, event_id="tail", name="late", value="x"),
        ],
        source=flow_copy,
    )

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=flow_copy,
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={},
        timeout=30.0,
    ))
    types = [p["type"] for p in _decode_sse(encoded)]
    # RUN_FINISHED is terminal; the trailing CUSTOM is drained, never emitted.
    assert types == ["RUN_STARTED", "RUN_FINISHED"]
    # All three frames were consumed and the iterator hit StopAsyncIteration —
    # i.e. the driver drained rather than stopping at flow_finished.
    assert session.frames_yielded == 3
    assert session.exhausted is True


@requires_stream_frames
async def test_frame_path_does_not_cancel_kickoff_after_finish():
    """Real Flow: on the happy path the kickoff task must finish
    finalization — result recorded, not cancelled. Pre-fix the driver broke on
    RUN_FINISHED and the finally's aclose() cancelled the still-finalizing task
    on EVERY run (session ended is_cancelled=True with no result); verified
    against the crewai 1.15.7 wheel. Draining the tail to exhaustion fixes it."""
    from ag_ui.encoder import EventEncoder

    class _ResultFlow(Flow):
        @start()
        async def go(self):
            return "RESULT"

    flow = _ResultFlow()
    captured = {}
    real_astream = flow.astream

    def _capture(*args, **kwargs):
        stream_session = real_astream(*args, **kwargs)
        captured["session"] = stream_session
        return stream_session

    flow.astream = _capture

    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={},
        timeout=30.0,
    ))
    assert [p["type"] for p in _decode_sse(encoded)][-1] == "RUN_FINISHED"
    session = captured["session"]
    # The kickoff task completed normally rather than being cancelled by aclose.
    assert session.is_cancelled is False
    assert session.result == "RESULT"


# -- MCP events surface through the SHIPPED frame-path sink ----------

class _MCPEmittingFlow(Flow):
    """Emits crewai MCP events (connection lifecycle + a tool execution) with a
    NON-flow source, exactly as crewai core does. The frame-path ``_sink`` must
    therefore park them by TYPE (``is_mcp_event``), not by ``source is flow``."""

    @start()
    def go(self):
        from ag_ui_crewai._capabilities import crewai_event_bus
        from crewai.events import (
            MCPConnectionStartedEvent,
            MCPToolExecutionCompletedEvent,
        )

        agent = SimpleNamespace()  # non-flow source, like a crew/agent
        crewai_event_bus.emit(
            agent,
            MCPConnectionStartedEvent(server_name="files", transport_type="stdio"),
        )
        crewai_event_bus.emit(
            agent,
            MCPToolExecutionCompletedEvent(
                server_name="files",
                tool_name="read_file",
                tool_args={"path": "/x"},
                result="hello",
            ),
        )
        return "done"


@requires_stream_frames
async def test_frame_path_surfaces_mcp_tool_calls():
    """Agent-sourced MCP events surface through the real
    ``_run_flow_frame_stream`` sink as TOOL_CALL_* (tool executions) and CUSTOM
    (connection lifecycle), inside a single RUN_STARTED/RUN_FINISHED envelope."""
    from ag_ui.encoder import EventEncoder

    pytest.importorskip("crewai.mcp")

    flow = _MCPEmittingFlow()
    encoded = await _collect(ep._run_flow_frame_stream(
        flow_copy=flow,
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    ))
    payloads = _decode_sse(encoded)
    types = [p["type"] for p in payloads]

    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    assert types.count("RUN_STARTED") == 1
    assert types.count("RUN_FINISHED") == 1
    for expected in (
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
    ):
        assert expected in types, (expected, types)
    customs = [p for p in payloads if p["type"] == "CUSTOM"]
    assert any(c.get("name") == "mcp_connection_started" for c in customs)


# --------------------------------------------------------------------------
# RAW passthrough: opt-in, default OFF, never before RUN_STARTED
# --------------------------------------------------------------------------

class _ForeignSourceEmittingFlow(Flow):
    """Emits a crewai llm event the way crewai itself does: with the EMITTER as
    source, not the flow.

    Every llm / agent / task / tool event on the 1.15.7 wheel is emitted this way
    (``crewai_event_bus.emit(self, event=...)`` in ``llms/base_llm.py``), so the
    driver's outer-flow source gate never parks them - which is why RAW passthrough
    needs a second buffer to see them at all."""

    @start()
    async def chat(self):
        from ag_ui_crewai._capabilities import crewai_event_bus
        # A genuinely FOREIGN llm event: emitted with the LLM as source (not the
        # flow) and NOT recognized/translated by the bridge, so it is eligible for
        # RAW passthrough. ``llm_thinking_chunk`` is deliberately NOT used here: it
        # is now a translated channel (-> REASONING_*), covered separately.
        from crewai.events.types.llm_events import LLMStreamChunkEvent
        crewai_event_bus.emit(
            object(),  # stands in for the LLM instance crewai emits with
            event=LLMStreamChunkEvent(chunk="pondering", call_id="c-1"),
        )
        return "done"


@requires_stream_frames
async def test_raw_passthrough_mirrors_foreign_source_events_end_to_end():
    """RAW passthrough has to reach the llm / agent / task / tool channels, which
    crewai emits with the EMITTER as source. Gating those out (as the TRANSLATION
    path must, so they cannot synthesize a run lifecycle) left the flag emitting
    nothing at all, including for ``llm_thinking_chunk`` - the channel the reasoning
    capability points at."""
    from ag_ui.encoder import EventEncoder
    from ag_ui_crewai._capabilities import LLMThinkingChunkEvent

    if LLMThinkingChunkEvent is None:  # pragma: no cover
        pytest.skip("installed crewai does not expose LLMThinkingChunkEvent")

    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=_ForeignSourceEmittingFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
        emit_raw_events=True,
    )))
    types = [p["type"] for p in payloads]

    # The invariant RAW can break: crewai raises some events BEFORE flow_started, and
    # @ag-ui/client's verifyEvents throws "First event must be 'RUN_STARTED'".
    assert types[0] == "RUN_STARTED", types
    raws = [p for p in payloads if p["type"] == "RAW"]
    assert raws, types
    assert all(p["source"] == "crewai" for p in raws)
    assert types.index("RUN_STARTED") < types.index("RAW"), types

    foreign = next(p for p in raws if p["event"]["type"] == "llm_stream_chunk")
    assert foreign["event"]["chunk"] == "pondering"

    # Still exactly one run lifecycle: a foreign event can never synthesize one.
    assert types.count("RUN_STARTED") == 1
    assert types.count("RUN_FINISHED") == 1


@requires_stream_frames
async def test_foreign_source_events_are_dropped_when_raw_is_off():
    """Default OFF means default OFF: the payload-bloat guard."""
    from ag_ui.encoder import EventEncoder
    from ag_ui_crewai._capabilities import LLMThinkingChunkEvent

    if LLMThinkingChunkEvent is None:  # pragma: no cover
        pytest.skip("installed crewai does not expose LLMThinkingChunkEvent")

    payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
        flow_copy=_ForeignSourceEmittingFlow(),
        encoder=EventEncoder(),
        input_data=_make_run_input(),
        inputs={"id": "t-1"},
        timeout=30.0,
    )))

    assert "RAW" not in [p["type"] for p in payloads]


@requires_stream_frames
async def test_saturated_raw_buffer_degrades_without_breaking_the_run(
    caplog, monkeypatch
):
    """Both RAW buffers are bounded. A saturated buffer must degrade RAW mirroring,
    never the run - and it must say so, because silence is indistinguishable from
    "crewai emitted nothing", the very thing RAW exists to rule out."""
    import logging

    from ag_ui.encoder import EventEncoder
    from ag_ui_crewai._capabilities import LLMThinkingChunkEvent

    if LLMThinkingChunkEvent is None:  # pragma: no cover
        pytest.skip("installed crewai does not expose LLMThinkingChunkEvent")

    # Cap of 0 so EVERY event is refused: deterministic, unlike a cap of 1 that a
    # short run may simply never reach.
    monkeypatch.setattr(ep, "_FOREIGN_EVENT_BUFFER_MAX", 0)
    monkeypatch.setattr(frames_mod, "_RAW_LOSS_WARNED", False)

    with caplog.at_level(logging.DEBUG, logger="ag_ui_crewai._frames"):
        payloads = _decode_sse(await _collect(ep._run_flow_frame_stream(
            flow_copy=_ForeignSourceEmittingFlow(),
            encoder=EventEncoder(),
            input_data=_make_run_input(),
            inputs={"id": "t-1"},
            timeout=30.0,
            emit_raw_events=True,
        )))

    types = [p["type"] for p in payloads]
    assert types[0] == "RUN_STARTED", types
    assert types[-1] == "RUN_FINISHED", types
    assert "RAW" not in types, types
    assert any("RAW passthrough" in r.getMessage() for r in caplog.records), caplog.text


async def test_legacy_transport_says_it_cannot_serve_raw(caplog, monkeypatch):
    """The legacy bus listener only receives the event types it registers, so there
    is nothing to mirror. Say so once per process rather than ignoring the flag."""
    import logging

    from ag_ui.core import RunFinishedEvent
    from ag_ui.encoder import EventEncoder

    monkeypatch.setattr(ep, "_LEGACY_RAW_WARNING_EMITTED", False)

    class _ImmediateFlow:
        state = {}

        def __deepcopy__(self, memo):
            return self

        async def kickoff_async(self, inputs=None):
            queue = ep.get_queue(self)
            queue.put_nowait(RunFinishedEvent(
                type=EventType.RUN_FINISHED, thread_id="?", run_id="?",
            ))
            queue.put_nowait(None)
            return None

    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai.endpoint"):
        payloads = _decode_sse(await _collect(ep._run_flow_event_stream(
            flow_copy=_ImmediateFlow(),
            encoder=EventEncoder(),
            input_data=_make_run_input(),
            inputs={"id": "t-1"},
            timeout=30.0,
            emit_raw_events=True,
        )))

    assert [p["type"] for p in payloads] == ["RUN_FINISHED"], payloads
    assert any(
        "requires the crewai StreamFrame transport" in r.getMessage()
        for r in caplog.records
    ), caplog.text


def test_raw_event_builder_never_raises_and_tags_its_source():
    """A RAW mirror must never be able to break the run, so an unusable payload
    yields None (the driver drops the mirror) rather than raising into the loop."""
    class _Unserializable:
        type = "llm_call_started"

        def model_dump(self, mode=None):
            raise RuntimeError("nope")

    mirror = frames_mod.raw_event_for(_Unserializable())
    # Falls back to instance attributes; the class has none, so the payload is the
    # type alone rather than an exception.
    assert mirror is not None
    assert mirror.source == "crewai"
    assert mirror.event["type"] == "llm_call_started"

    # No ``type`` at all is not mirrorable.
    assert frames_mod.raw_event_for(SimpleNamespace()) is None


def test_mapped_events_are_never_duplicated_as_raw():
    """The flag adds the events that would otherwise be dropped. An event the bridge
    DOES map must not also appear as RAW."""
    assert frames_mod.is_recognized_event(_ev("flow_started")) is True
    assert frames_mod.is_recognized_event(_ev("TEXT_MESSAGE_CHUNK")) is True
    # ``llm_thinking_chunk`` is now mapped (-> REASONING_*), so it is recognized
    # and must never be RAW-duplicated. A genuinely unmapped llm event still is.
    assert frames_mod.is_recognized_event(_ev("llm_thinking_chunk")) is True
    assert frames_mod.is_recognized_event(_ev("llm_stream_chunk")) is False

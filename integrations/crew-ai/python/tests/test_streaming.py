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
    copilotkit_emit_state,
    copilotkit_predict_state,
    copilotkit_stream,
)


async def _settle_bus(emit_result=None):
    """Let off-thread crewai 1.x event-bus handlers land on the queue.

    CPK-7718 #2: crewai 1.x dispatches our sync listener callbacks on a
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
# StreamFrame path (CPK-7719): flow.astream() -> frame translator -> wire
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


class _FakeStreamSession:
    """Minimal AsyncStreamSession stand-in: yields supplied frames, records
    whether ``aclose`` was called. Lets us unit-test the driver's teardown /
    ceiling handling without a live crewai run."""

    def __init__(self, frames, *, hang=False):
        self._frames = frames
        self._hang = hang
        self.aclosed = False

    async def _agen(self):
        for fr in self._frames:
            yield fr
        if self._hang:
            # Never terminate on its own — the ceiling / aclose must stop us.
            await asyncio.Event().wait()

    def __aiter__(self):
        return self._agen()

    async def aclose(self):
        self.aclosed = True


class _Frame:
    """StreamFrame-shaped stand-in (only ``type`` / ``data`` are read)."""

    def __init__(self, type, data=None):  # noqa: A002 - mirror StreamFrame.type
        self.type = type
        self.data = data or {}


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
    """The default translator maps bridge/lifecycle frames onto exactly the
    events the legacy listener produced — chunks, not triples."""
    state = {"messages": [{"role": "assistant", "content": "hi", "id": "m1"}]}
    tr = frames_mod.StreamFrameTranslator(
        thread_id="t-1", run_id="r-1", state_provider=lambda: state,
    )

    assert [e.type for e in tr.translate(_Frame("flow_started"))] == [
        EventType.RUN_STARTED
    ]
    start_ev = tr.translate(_Frame("method_execution_started", {"method_name": "chat"}))
    assert start_ev[0].type == EventType.STEP_STARTED
    assert start_ev[0].step_name == "chat"

    text = tr.translate(_Frame("TEXT_MESSAGE_CHUNK", {
        "message_id": "m1", "role": "assistant", "delta": "hi",
    }))
    assert len(text) == 1
    assert text[0].type == EventType.TEXT_MESSAGE_CHUNK
    assert (text[0].message_id, text[0].role, text[0].delta) == ("m1", "assistant", "hi")

    tool = tr.translate(_Frame("TOOL_CALL_CHUNK", {
        "tool_call_id": "tc1", "tool_call_name": "searchTool", "delta": '{"q":1}',
    }))
    assert tool[0].type == EventType.TOOL_CALL_CHUNK
    assert (tool[0].tool_call_id, tool[0].tool_call_name, tool[0].delta) == (
        "tc1", "searchTool", '{"q":1}'
    )

    custom = tr.translate(_Frame("CUSTOM", {"name": "PredictState", "value": [1]}))
    assert custom[0].type == EventType.CUSTOM
    assert (custom[0].name, custom[0].value) == ("PredictState", [1])

    snap = tr.translate(_Frame("STATE_SNAPSHOT", {"snapshot": {"p": 5}}))
    assert snap[0].type == EventType.STATE_SNAPSHOT
    assert snap[0].snapshot == {"p": 5}

    finished = tr.translate(_Frame("method_execution_finished", {"method_name": "chat"}))
    assert [e.type for e in finished] == [
        EventType.MESSAGES_SNAPSHOT, EventType.STATE_SNAPSHOT, EventType.STEP_FINISHED,
    ]
    assert finished[0].messages[0].id == "m1"
    assert finished[2].step_name == "chat"

    fin = tr.translate(_Frame("flow_finished"))
    assert fin[0].type == EventType.RUN_FINISHED
    assert tr.is_run_end(_Frame("flow_finished")) is True

    # Native crewai channels / unknown frames are dropped (behavior-preserving).
    assert tr.translate(_Frame("llm_stream_chunk", {"chunk": "x"})) == []
    assert tr.translate(_Frame("cc_env")) == []


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
        triples.translate(_Frame("TEXT_MESSAGE_CHUNK", {"message_id": "m", "delta": "x"}))


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


def _make_run_input(thread_id="t-1", run_id="r-1"):
    from ag_ui.core import RunAgentInput
    return RunAgentInput(
        thread_id=thread_id, run_id=run_id, state={}, messages=[], tools=[],
        context=[], forwarded_props={},
    )


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

    session = _FakeStreamSession(
        [_Frame("flow_started"), _Frame("TEXT_MESSAGE_CHUNK", {
            "message_id": "m", "role": "assistant", "delta": "x"})],
        hang=True,
    )

    class _AstreamFlow:
        state = {}

        def astream(self, inputs=None):
            return session

    gen = ep._run_flow_frame_stream(
        flow_copy=_AstreamFlow(),
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

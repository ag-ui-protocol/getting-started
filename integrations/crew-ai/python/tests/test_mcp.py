"""Tests for the MCP -> AG-UI event bridge.

``translate_mcp_event`` is stateless (mints fresh ids per call, so not pure) and
dispatches on the crewai event's ``type`` string, so these tests drive it with
lightweight ``SimpleNamespace`` fakes -- no crewai>=1.4 MCP surface required. The
registration path is exercised with a fake event bus and an injected raw-event
callback. The StreamFrame seam is exercised through the real
``_frames.StreamFrameTranslator``.
"""

import json
import sys
import types
from types import SimpleNamespace

import pytest

from ag_ui.core import EventType

from ag_ui_crewai import mcp
from ag_ui_crewai._frames import StreamFrameTranslator


# ---------------------------------------------------------------------------
# helpers / fixtures
# ---------------------------------------------------------------------------


class _FakeBus:
    """Fake crewai event bus. ``on(EventType)`` returns a decorator that records
    (event_type, handler) pairs, matching crewai's decorator API."""

    def __init__(self):
        self.registered = []

    def on(self, event_type):
        def _decorator(handler):
            self.registered.append((event_type, handler))
            return handler

        return _decorator


@pytest.fixture(autouse=True)
def _reset_warn_dedup():
    """Isolate the process-wide warn-once dedup set between tests."""
    mcp._WARNED.clear()
    yield
    mcp._WARNED.clear()


def _completed(**kw):
    base = dict(
        type="mcp_tool_execution_completed",
        server_name="files",
        tool_name="read_file",
        tool_args={"path": "/tmp/x"},
        result={"content": "hello"},
    )
    base.update(kw)
    return SimpleNamespace(**base)


# ---------------------------------------------------------------------------
# translate_mcp_event -- tool executions -> TOOL_CALL_*
# ---------------------------------------------------------------------------


def test_tool_execution_completed_maps_to_tool_call_sequence():
    events = mcp.translate_mcp_event(_completed())

    assert [e.type for e in events] == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
    ]
    start, args, end, result = events
    assert start.tool_call_id == args.tool_call_id == end.tool_call_id == result.tool_call_id
    assert start.tool_call_name == "read_file"
    assert json.loads(args.delta) == {"path": "/tmp/x"}
    assert json.loads(result.content) == {"content": "hello"}
    assert result.role == "tool"
    assert result.message_id


def test_tool_execution_completed_none_result_is_empty_string():
    events = mcp.translate_mcp_event(_completed(result=None))
    # None result -> "" (not the literal "null").
    assert events[3].content == ""


def test_tool_result_non_str_is_json_encoded():
    events = mcp.translate_mcp_event(_completed(result=[1, 2, 3]))
    assert json.loads(events[3].content) == [1, 2, 3]


def test_tool_execution_failed_is_distinguishable_from_success():
    event = SimpleNamespace(
        type="mcp_tool_execution_failed",
        server_name="files",
        tool_name="read_file",
        tool_args=None,
        error="boom: connection reset",
        error_type="server_error",
    )

    events = mcp.translate_mcp_event(event)

    # START/ARGS/END/RESULT (result carries the error text) + a CUSTOM failure
    # marker so a client can tell failure from success.
    assert [e.type for e in events] == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.CUSTOM,
    ]
    assert events[1].delta == "{}"  # None args -> empty JSON object
    assert events[3].content == "boom: connection reset"
    failed = events[4]
    assert failed.name == "mcp_tool_execution_failed"
    assert failed.value["error"] == "boom: connection reset"
    assert failed.value["error_type"] == "server_error"
    assert failed.value["tool_name"] == "read_file"


def test_args_empty_dict_and_populated_are_preserved():
    assert mcp.translate_mcp_event(_completed(tool_args={})) [1].delta == "{}"
    assert json.loads(
        mcp.translate_mcp_event(_completed(tool_args={"a": 1}))[1].delta
    ) == {"a": 1}


def test_tool_execution_started_maps_to_custom_activity():
    event = SimpleNamespace(
        type="mcp_tool_execution_started",
        server_name="files",
        tool_name="read_file",
        tool_args={"path": "/tmp/x"},
    )
    (custom,) = mcp.translate_mcp_event(event)
    assert custom.type == EventType.CUSTOM
    assert custom.name == "mcp_tool_execution_started"
    assert custom.value == {
        "server_name": "files",
        "tool_name": "read_file",
        "tool_args": {"path": "/tmp/x"},
    }


# ---------------------------------------------------------------------------
# translate_mcp_event -- lifecycle -> CUSTOM
# ---------------------------------------------------------------------------


def test_connection_started_maps_to_custom():
    event = SimpleNamespace(
        type="mcp_connection_started",
        server_name="files",
        server_url=None,
        transport_type="stdio",
        is_reconnect=False,
    )
    (custom,) = mcp.translate_mcp_event(event)
    assert custom.name == "mcp_connection_started"
    assert custom.value == {
        "server_name": "files",
        "server_url": None,
        "transport_type": "stdio",
        "is_reconnect": False,
    }


def test_connection_completed_carries_duration():
    event = SimpleNamespace(
        type="mcp_connection_completed",
        server_name="files",
        server_url="http://x",
        transport_type="http",
        connection_duration_ms=12.5,
        is_reconnect=True,
    )
    (custom,) = mcp.translate_mcp_event(event)
    assert custom.name == "mcp_connection_completed"
    assert custom.value["connection_duration_ms"] == 12.5
    assert custom.value["is_reconnect"] is True


def test_connection_failed_maps_to_custom():
    event = SimpleNamespace(
        type="mcp_connection_failed",
        server_name="files",
        server_url=None,
        error="timeout",
        error_type="timeout",
    )
    (custom,) = mcp.translate_mcp_event(event)
    assert custom.name == "mcp_connection_failed"
    assert custom.value["error"] == "timeout"
    assert custom.value["error_type"] == "timeout"


def test_config_fetch_failed_maps_to_custom():
    event = SimpleNamespace(
        type="mcp_config_fetch_failed",
        slug="acme/files",
        error="not connected",
        error_type="not_connected",
    )
    (custom,) = mcp.translate_mcp_event(event)
    assert custom.name == "mcp_config_fetch_failed"
    assert custom.value == {
        "slug": "acme/files",
        "error": "not connected",
        "error_type": "not_connected",
    }


def test_unknown_event_type_is_noop():
    assert mcp.translate_mcp_event(SimpleNamespace(type="something_else")) == []
    assert mcp.translate_mcp_event(SimpleNamespace()) == []


# ---------------------------------------------------------------------------
# is_mcp_event
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "etype",
    [
        "mcp_connection_started",
        "mcp_connection_completed",
        "mcp_connection_failed",
        "mcp_tool_execution_started",
        "mcp_tool_execution_completed",
        "mcp_tool_execution_failed",
        "mcp_config_fetch_failed",
    ],
)
def test_is_mcp_event_true_for_mcp_types(etype):
    assert mcp.is_mcp_event(SimpleNamespace(type=etype)) is True


@pytest.mark.parametrize("etype", ["flow_started", "text_message_chunk", None, "cc_env"])
def test_is_mcp_event_false_for_others(etype):
    assert mcp.is_mcp_event(SimpleNamespace(type=etype)) is False


# ---------------------------------------------------------------------------
# probe + registration
# ---------------------------------------------------------------------------


def test_crewai_mcp_available_returns_bool():
    assert isinstance(mcp.crewai_mcp_available(), bool)


def test_register_noop_and_warns_when_mcp_unavailable(monkeypatch, caplog):
    monkeypatch.setattr(mcp, "crewai_mcp_available", lambda: False)
    bus = _FakeBus()

    with caplog.at_level("WARNING"):
        result = mcp.register_mcp_listeners(bus, lambda event: None)

    assert result is False
    assert bus.registered == []
    assert any("requires crewai>=1.4" in r.message for r in caplog.records)


def test_register_warning_is_emitted_once(monkeypatch, caplog):
    monkeypatch.setattr(mcp, "crewai_mcp_available", lambda: False)
    bus = _FakeBus()
    with caplog.at_level("WARNING"):
        mcp.register_mcp_listeners(bus, lambda event: None)
        mcp.register_mcp_listeners(bus, lambda event: None)
    warnings = [r for r in caplog.records if "requires crewai>=1.4" in r.message]
    assert len(warnings) == 1


def _install_fake_crewai_events(monkeypatch, *, with_classes=True):
    module = types.ModuleType("crewai.events")
    if with_classes:
        for name in mcp._MCP_EVENT_CLASS_NAMES:
            setattr(module, name, type(name, (), {}))
    monkeypatch.setitem(sys.modules, "crewai.events", module)
    return module


def test_register_wires_all_mcp_event_types_when_available(monkeypatch):
    monkeypatch.setattr(mcp, "crewai_mcp_available", lambda: True)
    _install_fake_crewai_events(monkeypatch)
    bus = _FakeBus()

    result = mcp.register_mcp_listeners(bus, lambda event: None)

    assert result is True
    assert len(bus.registered) == 7
    # The 7 registrations cover the 7 distinct MCP event classes, not dups.
    registered_types = {t for t, _ in bus.registered}
    import sys as _sys

    expected = {
        getattr(_sys.modules["crewai.events"], name)
        for name in mcp._MCP_EVENT_CLASS_NAMES
    }
    assert registered_types == expected


def test_register_warns_once_when_event_classes_missing(monkeypatch, caplog):
    monkeypatch.setattr(mcp, "crewai_mcp_available", lambda: True)
    _install_fake_crewai_events(monkeypatch, with_classes=False)
    bus = _FakeBus()

    with caplog.at_level("WARNING"):
        r1 = mcp.register_mcp_listeners(bus, lambda event: None)
        r2 = mcp.register_mcp_listeners(bus, lambda event: None)

    assert r1 is False and r2 is False
    assert bus.registered == []
    warnings = [r for r in caplog.records if "could not be resolved" in r.message]
    assert len(warnings) == 1


def test_registered_handler_forwards_raw_event(monkeypatch):
    # The bus handler forwards the RAW crewai event to the injected callback;
    # translation happens in the endpoint (only when a run queue exists).
    monkeypatch.setattr(mcp, "crewai_mcp_available", lambda: True)
    _install_fake_crewai_events(monkeypatch)
    bus = _FakeBus()
    received = []

    mcp.register_mcp_listeners(bus, received.append)
    handler = bus.registered[0][1]

    raw = _completed(result="ok")
    handler(object(), raw)

    assert received == [raw]


# ---------------------------------------------------------------------------
# StreamFrame seam (_frames.StreamFrameTranslator routes MCP via the shared
# translator)
# ---------------------------------------------------------------------------


def test_stream_frame_translator_surfaces_mcp_tool_call():
    translator = StreamFrameTranslator(
        thread_id="t1", run_id="r1", state_provider=lambda: {}
    )
    events = translator.translate(_completed(result="ok"))
    assert [e.type for e in events] == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
    ]


def test_stream_frame_translator_surfaces_mcp_lifecycle():
    translator = StreamFrameTranslator(
        thread_id="t1", run_id="r1", state_provider=lambda: {}
    )
    events = translator.translate(
        SimpleNamespace(
            type="mcp_connection_started",
            server_name="files",
            server_url=None,
            transport_type="stdio",
            is_reconnect=False,
        )
    )
    assert len(events) == 1
    assert events[0].type == EventType.CUSTOM
    assert events[0].name == "mcp_connection_started"


# ---------------------------------------------------------------------------
# failure-path + serialization hardening
# ---------------------------------------------------------------------------


def test_failed_shares_one_tool_call_id_and_none_error_is_empty():
    event = SimpleNamespace(
        type="mcp_tool_execution_failed",
        server_name="files",
        tool_name="t",
        tool_args=None,
        error=None,  # a failure with no error string
        error_type=None,
    )
    events = mcp.translate_mcp_event(event)
    start, args, end, result, custom = events
    assert start.tool_call_id == args.tool_call_id == end.tool_call_id == result.tool_call_id
    # None error -> "" result content; the CUSTOM marker is what signals failure.
    assert result.content == ""
    assert custom.type == EventType.CUSTOM
    assert custom.name == "mcp_tool_execution_failed"


def test_failed_non_string_error_is_coerced():
    event = SimpleNamespace(
        type="mcp_tool_execution_failed",
        server_name="files",
        tool_name="t",
        tool_args={},
        error=ValueError("bad"),  # non-string, non-JSON-native
        error_type="server_error",
    )
    events = mcp.translate_mcp_event(event)
    result, custom = events[3], events[4]
    # RESULT content is a string (json-encoded / str-coerced), never raises.
    assert isinstance(result.content, str) and "bad" in result.content
    # CUSTOM value is fully JSON-serialisable (the Exception was coerced).
    json.dumps(custom.value)


def test_args_circular_reference_does_not_raise():
    circular: dict = {}
    circular["self"] = circular
    events = mcp.translate_mcp_event(_completed(tool_args=circular))
    # Degrades to a string rather than faulting translation.
    assert isinstance(events[1].delta, str)


def test_started_circular_tool_args_does_not_raise():
    # The STARTED CUSTOM payload routes raw tool_args through _json_safe; a
    # circular reference must degrade to "<circular>", not raise RecursionError.
    circular: dict = {}
    circular["self"] = circular
    event = SimpleNamespace(
        type="mcp_tool_execution_started",
        server_name="files",
        tool_name="t",
        tool_args=circular,
    )
    (custom,) = mcp.translate_mcp_event(event)
    json.dumps(custom.value)  # must not raise
    assert custom.value["tool_args"]["self"] == "<circular>"


def test_json_safe_preserves_shared_non_circular_refs():
    shared = {"k": "v"}
    out = mcp._json_safe({"a": shared, "b": shared})
    # A shared (non-cyclic) reference must NOT be flagged as circular.
    assert out == {"a": {"k": "v"}, "b": {"k": "v"}}


def test_json_safe_bounds_deeply_nested_acyclic_input():
    # Deep (acyclic) nest FAR past CPython's ~1000 recursion limit; the depth
    # cap must flatten it to a constant placeholder rather than RecursionError,
    # and the result must be JSON-serialisable without deep recursion either.
    deep: dict = {}
    node = deep
    for _ in range(5000):
        child: dict = {}
        node["n"] = child
        node = child
    out = mcp._json_safe(deep)
    assert json.dumps(out)  # must not raise (bounded structure)
    # The tail past the cap collapses to the "<max-depth>" placeholder.
    assert "<max-depth>" in json.dumps(out)


def test_args_delta_deeply_nested_does_not_raise():
    deep: dict = {}
    node = deep
    for _ in range(5000):
        child: dict = {}
        node["n"] = child
        node = child
    delta = mcp.translate_mcp_event(_completed(tool_args=deep))[1].delta
    assert isinstance(delta, str) and json.loads(delta) is not None


def test_tool_name_none_does_not_break_validation():
    # An explicit tool_name=None must not trip the required str field.
    event = SimpleNamespace(
        type="mcp_tool_execution_completed",
        server_name="files",
        tool_name=None,
        tool_args={},
        result="ok",
    )
    events = mcp.translate_mcp_event(event)
    assert events[0].type == EventType.TOOL_CALL_START
    assert events[0].tool_call_name == ""


def test_custom_value_is_json_serialisable_even_with_exotic_fields():
    event = SimpleNamespace(
        type="mcp_connection_failed",
        server_name="files",
        server_url=None,
        error=RuntimeError("boom"),  # exotic leaf
        error_type=None,
    )
    (custom,) = mcp.translate_mcp_event(event)
    json.dumps(custom.value)  # must not raise
    assert "boom" in custom.value["error"]


# ---------------------------------------------------------------------------
# integration: real crewai (skipped when crewai.mcp / astream absent)
# ---------------------------------------------------------------------------


def _real_flow_emitting_mcp(events_module):
    """Build a real crewai Flow whose @start method emits an MCP connection +
    an MCP tool-execution-completed event with a NON-flow source (as crewai
    core does)."""
    from crewai import Flow
    from crewai.flow.flow import start

    bus = events_module.crewai_event_bus
    completed_cls = events_module.MCPToolExecutionCompletedEvent
    connected_cls = events_module.MCPConnectionStartedEvent

    class _Agent:  # non-flow source, like crewai's agent/crew
        pass

    agent = _Agent()

    class _F(Flow):
        @start()
        def go(self):
            bus.emit(agent, connected_cls(server_name="files", transport_type="stdio"))
            bus.emit(
                agent,
                completed_cls(
                    server_name="files",
                    tool_name="read_file",
                    tool_args={"path": "/x"},
                    result="hello",
                ),
            )
            return "done"

    return _F()


def test_integration_legacy_bus_seam_resolves_via_flow_context():
    """crewai dispatches sync bus handlers on a worker thread but copies the
    emitting contextvars, so the legacy-path handler resolves the run via
    ``flow_context`` (refutes the 'contextvars do not propagate' hypothesis)."""
    pytest.importorskip("crewai.mcp")
    import asyncio

    events_module = pytest.importorskip("crewai.events")
    from ag_ui_crewai.context import flow_context

    flow = _real_flow_emitting_mcp(events_module)
    resolved = []

    @events_module.crewai_event_bus.on(events_module.MCPToolExecutionCompletedEvent)
    def _(source, event):  # noqa: ANN001
        resolved.append(flow_context.get(None))

    async def _run():
        token = flow_context.set(flow)
        try:
            await asyncio.create_task(flow.kickoff_async())
            flush = getattr(events_module.crewai_event_bus, "flush", None)
            if callable(flush):
                await asyncio.get_running_loop().run_in_executor(None, lambda: flush(5.0))
        finally:
            flow_context.reset(token)

    asyncio.run(_run())
    assert resolved and resolved[0] is flow


def test_integration_stream_frame_seam_surfaces_mcp_as_tool_call():
    """Drive a real ``flow.astream`` and run its frames through the widened sink
    + StreamFrameTranslator exactly as ``endpoint._run_flow_frame_stream`` does;
    the agent-sourced MCP events must surface as TOOL_CALL_* / CUSTOM."""
    caps = pytest.importorskip("ag_ui_crewai._capabilities")
    pytest.importorskip("crewai.mcp")
    if not getattr(caps, "_stream_frame_available", False):
        pytest.skip("crewai StreamFrame contract unavailable (<1.6)")
    import asyncio

    events_module = pytest.importorskip("crewai.events")
    from crewai.events.stream_context import add_stream_sink, reset_stream_sinks

    flow = _real_flow_emitting_mcp(events_module)
    raw: dict = {}

    def _sink(source, event):  # mirror endpoint._sink widened gate
        if source is flow or mcp.is_mcp_event(event):
            eid = getattr(event, "event_id", None)
            if eid is not None:
                raw[eid] = event

    translator = StreamFrameTranslator(
        thread_id="t", run_id="r", state_provider=lambda: getattr(flow, "state", {})
    )
    out = []

    async def _run():
        token = add_stream_sink(_sink)
        try:
            async for frame in flow.astream(inputs={}):
                ev = raw.pop(frame.id, None)
                if ev is None:
                    continue
                for e in translator.translate(ev):
                    out.append(e.type)
        finally:
            reset_stream_sinks(token)

    asyncio.run(_run())
    assert EventType.TOOL_CALL_START in out
    assert EventType.TOOL_CALL_RESULT in out
    assert out.count(EventType.RUN_STARTED) == 1
    assert out.count(EventType.RUN_FINISHED) == 1

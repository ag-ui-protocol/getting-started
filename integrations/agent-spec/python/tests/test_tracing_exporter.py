# Copyright © 2025 Oracle and/or its affiliates.
#
# This software is under the Apache License 2.0
# (LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0) or Universal Permissive License
# (UPL) 1.0 (LICENSE-UPL or https://oss.oracle.com/licenses/upl), at your option.
"""Behaviour tests for the AG-UI span processor and its pure helpers.

The span processor is the load-bearing translation layer: it turns pyagentspec
tracing events into AG-UI protocol events. These tests feed it genuine
pyagentspec events and assert on the AG-UI events it produces.
"""

import json
import logging

import pytest

from ag_ui.core.events import (
    EventType,
    TextMessageChunkEvent,
    ToolCallChunkEvent,
    ToolCallResultEvent,
)

from ag_ui_agentspec.agentspec_tracing_exporter import (
    AgUiSpanProcessor,
    _escape_html,
    _normalize_tool_output,
    jsonable,
    repair_a2ui_json,
)

from tests.conftest import (
    FakeToolCall,
    exception_raised,
    llm_chunk,
    llm_response,
    make_span,
    tool_request,
    tool_response,
)


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

class TestEscapeHtml:
    def test_escapes_angle_brackets_and_amp(self):
        assert _escape_html("<a> & </a>") == "&lt;a&gt; &amp; &lt;/a&gt;"

    def test_amp_escaped_before_brackets(self):
        # & must be escaped first so bracket entities aren't double-escaped.
        assert _escape_html("<") == "&lt;"
        assert _escape_html("&lt;") == "&amp;lt;"

    def test_none_becomes_empty_string(self):
        assert _escape_html(None) == ""

    def test_plain_text_unchanged(self):
        assert _escape_html("hello") == "hello"


class TestJsonable:
    def test_valid_json_string(self):
        assert jsonable('{"a": 1}') is True

    def test_invalid_json_string(self):
        assert jsonable("not json") is False


class TestNormalizeToolOutput:
    def test_unwraps_single_key_dict_with_dict_inner(self):
        out = _normalize_tool_output({"weather_result": {"temp": 72}})
        assert json.loads(out) == {"temp": 72}

    def test_unwraps_single_key_dict_with_scalar_inner(self):
        # scalar inner is unwrapped then stringified
        assert _normalize_tool_output({"result": 42}) == "42"

    def test_multi_key_dict_serialized_once(self):
        out = _normalize_tool_output({"a": 1, "b": 2})
        assert json.loads(out) == {"a": 1, "b": 2}

    def test_list_serialized_once(self):
        out = _normalize_tool_output([1, 2, 3])
        assert json.loads(out) == [1, 2, 3]

    def test_json_string_passthrough_not_double_encoded(self):
        # A string that is already valid JSON must pass through unchanged.
        assert _normalize_tool_output('{"temp": 72}') == '{"temp": 72}'

    def test_python_repr_string_parsed_to_json(self):
        # ast.literal_eval path: a python-dict repr becomes JSON.
        out = _normalize_tool_output("{'temp': 72}")
        assert json.loads(out) == {"temp": 72}

    def test_plain_primitive_string(self):
        assert _normalize_tool_output("sunny") == "sunny"


class TestRepairA2uiJson:
    def test_dict_passthrough(self):
        assert json.loads(repair_a2ui_json({"a": 1})) == {"a": 1}

    def test_valid_json_string(self):
        assert json.loads(repair_a2ui_json('{"a": 1}')) == {"a": 1}

    def test_repairs_broken_json_string(self):
        # Missing closing brace -> json_repair fixes it.
        out = repair_a2ui_json('{"a": 1')
        assert json.loads(out) == {"a": 1}

    def test_unexpected_type_raises(self):
        with pytest.raises(NotImplementedError):
            repair_a2ui_json(42)


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------

class TestRunLifecycle:
    def test_startup_emits_run_started(self, event_queue):
        _, drain = event_queue
        proc = AgUiSpanProcessor(runtime="langgraph")
        proc.startup()
        events = drain()
        assert len(events) == 1
        assert events[0].type == EventType.RUN_STARTED

    def test_shutdown_emits_run_finished(self, event_queue):
        _, drain = event_queue
        proc = AgUiSpanProcessor(runtime="langgraph")
        proc.shutdown()
        events = drain()
        assert len(events) == 1
        assert events[0].type == EventType.RUN_FINISHED

    def test_run_started_and_finished_share_ids(self, event_queue):
        _, drain = event_queue
        proc = AgUiSpanProcessor(runtime="langgraph")
        proc.startup()
        proc.shutdown()
        started, finished = drain()
        assert started.thread_id == finished.thread_id
        assert started.run_id == finished.run_id

    def test_emit_without_queue_raises(self):
        # No EVENT_QUEUE set in this (non-fixtured) context.
        proc = AgUiSpanProcessor(runtime="langgraph")
        with pytest.raises(RuntimeError, match="event queue is not set"):
            proc.startup()


# ---------------------------------------------------------------------------
# LLM text streaming
# ---------------------------------------------------------------------------

class TestLlmTextStreaming:
    def test_chunk_emits_text_message_chunk(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        events = proc._gather_events_for_event(
            llm_chunk(content="hello", completion_id="msg-1"), span
        )
        assert len(events) == 1
        assert isinstance(events[0], TextMessageChunkEvent)
        assert events[0].delta == "hello"
        assert events[0].message_id == "msg-1"

    def test_chunk_content_is_html_escaped(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        events = proc._gather_events_for_event(
            llm_chunk(content="<b>", completion_id="msg-1"), span
        )
        assert events[0].delta == "&lt;b&gt;"

    def test_chunk_falls_back_to_request_id_when_no_completion_id(self):
        # WayFlow does not assign completion_id in streaming.
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        events = proc._gather_events_for_event(
            llm_chunk(content="hi", request_id="req-9", completion_id=None), span
        )
        assert events[0].message_id == "req-9"

    def test_chunk_without_message_id_raises(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        with pytest.raises(ValueError, match="assistant message id"):
            proc._gather_events_for_event(
                llm_chunk(content="hi", request_id="", completion_id=None), span
            )

    def test_response_without_completion_id_raises(self):
        # Unlike the chunk path (which falls back to request_id), the response
        # path REQUIRES completion_id and raises if it is absent.
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        with pytest.raises(ValueError, match="assistant message id in LLM response"):
            proc._gather_events_for_event(
                llm_response(content="answer", request_id="req-1", completion_id=None), span
            )

    def test_response_emits_full_text_when_no_chunks_streamed(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        events = proc._gather_events_for_event(
            llm_response(content="full answer", completion_id="msg-1"), span
        )
        assert len(events) == 1
        assert isinstance(events[0], TextMessageChunkEvent)
        assert events[0].delta == "full answer"

    def test_response_suppresses_text_when_chunks_already_streamed(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        # First a streamed chunk marks the span as having emitted text...
        proc._gather_events_for_event(
            llm_chunk(content="partial", completion_id="msg-1"), span
        )
        # ...so the final response must not re-emit the (now duplicate) text.
        events = proc._gather_events_for_event(
            llm_response(content="partial", completion_id="msg-1"), span
        )
        text_events = [e for e in events if isinstance(e, TextMessageChunkEvent)]
        assert text_events == []


# ---------------------------------------------------------------------------
# Tool-call streaming / emission
# ---------------------------------------------------------------------------

class TestToolCallEmission:
    def test_response_tool_call_emits_chunk(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        tc = FakeToolCall(call_id="tc-1", tool_name="get_weather", arguments='{"city": "SF"}')
        events = proc._gather_events_for_event(
            llm_response(content="", completion_id="msg-1", tool_calls=[tc]), span
        )
        tool_events = [e for e in events if isinstance(e, ToolCallChunkEvent)]
        assert len(tool_events) == 1
        assert tool_events[0].tool_call_id == "tc-1"
        assert tool_events[0].tool_call_name == "get_weather"
        assert json.loads(tool_events[0].delta) == {"city": "SF"}

    def test_response_repairs_a2ui_json_argument(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        # a2ui_json nested as a broken JSON string should be repaired in place.
        args = json.dumps({"a2ui_json": '{"component": "Card"'})  # missing closing brace
        tc = FakeToolCall(call_id="tc-1", tool_name="render", arguments=args)
        events = proc._gather_events_for_event(
            llm_response(content="", completion_id="msg-1", tool_calls=[tc]), span
        )
        delta = json.loads(events[0].delta)
        assert json.loads(delta["a2ui_json"]) == {"component": "Card"}

    def test_response_does_not_double_emit_already_started_tool_call(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="llm-1")
        tc = FakeToolCall(call_id="tc-1", tool_name="get_weather", arguments="{}")
        # Streamed chunk starts the tool call...
        proc._gather_events_for_event(
            llm_chunk(content="", completion_id="msg-1", tool_calls=[tc]), span
        )
        # ...so the final response must not emit it again.
        events = proc._gather_events_for_event(
            llm_response(content="", completion_id="msg-1", tool_calls=[tc]), span
        )
        assert [e for e in events if isinstance(e, ToolCallChunkEvent)] == []


# ---------------------------------------------------------------------------
# Tool execution: result correlation. This is the langgraph KeyError path.
# ---------------------------------------------------------------------------

class TestToolExecutionLangGraph:
    def test_request_then_response_correlates_tool_call_id(self):
        proc = AgUiSpanProcessor(runtime="langgraph")
        # The request span carries the AG-UI tool_call_id in its description.
        req_span = make_span(id="span-req", description="tcid__client-tc-7")
        proc._gather_events_for_event(tool_request(request_id="run-1"), req_span)

        resp_span = make_span(id="span-resp")
        events = proc._gather_events_for_event(
            tool_response(request_id="run-1", outputs={"weather_result": "sunny"}), resp_span
        )
        results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(results) == 1
        # The emitted result must reference the *client* tool_call_id, not the run id.
        assert results[0].tool_call_id == "client-tc-7"
        assert results[0].content == "sunny"
        assert results[0].role == "tool"

    def test_response_for_unseen_request_id_does_not_raise_keyerror(self):
        """REGRESSION: a ToolExecutionResponse whose request_id was never
        recorded by a preceding ToolExecutionRequest (out-of-order events, or a
        request span lacking a ``tcid__`` description) must not crash with a
        KeyError. It must still emit a ToolCallResultEvent, falling back to the
        run-level request_id as the tool_call_id."""
        proc = AgUiSpanProcessor(runtime="langgraph")
        resp_span = make_span(id="span-resp")
        events = proc._gather_events_for_event(
            tool_response(request_id="UNSEEN", outputs={"r": "ok"}), resp_span
        )
        results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(results) == 1
        assert results[0].tool_call_id == "UNSEEN"
        assert results[0].content == "ok"

    def test_unseen_request_id_logs_correlation_miss_warning(self, caplog):
        """The fallback path (request_id never correlated) silently surrogates
        the raw request_id as the tool_call_id, which orphans the tool result on
        the frontend. That degraded path must be observable: a WARNING naming
        the missed request_id is emitted only on the genuine fallback."""
        proc = AgUiSpanProcessor(runtime="langgraph")
        resp_span = make_span(id="span-resp")
        with caplog.at_level(logging.WARNING, logger="ag_ui_agentspec.tracing"):
            proc._gather_events_for_event(
                tool_response(request_id="UNSEEN", outputs={"r": "ok"}), resp_span
            )
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        assert "UNSEEN" in warnings[0].getMessage()

    def test_correlated_request_id_does_not_log_warning(self, caplog):
        """The happy path (request correlated via tcid__ description) must NOT
        emit the correlation-miss warning."""
        proc = AgUiSpanProcessor(runtime="langgraph")
        req_span = make_span(id="span-req", description="tcid__client-tc-7")
        proc._gather_events_for_event(tool_request(request_id="run-1"), req_span)

        resp_span = make_span(id="span-resp")
        with caplog.at_level(logging.WARNING, logger="ag_ui_agentspec.tracing"):
            proc._gather_events_for_event(
                tool_response(request_id="run-1", outputs={"r": "ok"}), resp_span
            )
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert warnings == []


class TestToolExecutionWayflow:
    def test_request_emits_tool_call_chunk(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="span-req")
        events = proc._gather_events_for_event(
            tool_request(request_id="req-1", tool_name="get_weather", inputs={"city": "SF"}), span
        )
        chunks = [e for e in events if isinstance(e, ToolCallChunkEvent)]
        assert len(chunks) == 1
        assert chunks[0].tool_call_id == "req-1"
        assert chunks[0].tool_call_name == "get_weather"
        assert json.loads(chunks[0].delta) == {"city": "SF"}

    def test_response_uses_request_id_directly(self):
        proc = AgUiSpanProcessor(runtime="wayflow")
        span = make_span(id="span-resp")
        events = proc._gather_events_for_event(
            tool_response(request_id="req-1", outputs={"weather_result": "sunny"}), span
        )
        results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(results) == 1
        assert results[0].tool_call_id == "req-1"


class TestExceptionRaised:
    def test_exception_event_raises_runtime_error(self):
        proc = AgUiSpanProcessor(runtime="langgraph")
        span = make_span(id="span-1")
        with pytest.raises(RuntimeError, match="ExceptionRaised occurred"):
            proc._gather_events_for_event(exception_raised(message="kaboom"), span)

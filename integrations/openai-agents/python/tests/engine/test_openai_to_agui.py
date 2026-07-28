"""
Tests for OpenAIToAGUITranslator's streaming event mapping.

The rest of the suite pins IDs (test_openai_to_agui_snapshot) and wire strings
(test_types_drift); this one pins the actual translation: feed the
engine the SDK stream events a real run emits — raw Responses deltas,
run-item commits, agent-updated signals — and assert the exact AG-UI event
sequence it yields. No network, no model; just the mapping.

Events are driven through ``translate`` (the tier-1 dispatcher ``to_agui``
calls per event), so raw dispatch, family dispatch, and the per-type methods
are all on the path. Raw deltas are duck-typed SimpleNamespaces (the engine
reads them via ``read_attr``, exactly as it does the real payloads); run
items use the SDK's own item classes so the isinstance dispatch is real.
"""

from __future__ import annotations

from types import SimpleNamespace

from agents import (
    Agent,
    HandoffCallItem,
    HandoffOutputItem,
    MCPApprovalRequestItem,
    ReasoningItem,
)
from agents.items import MessageOutputItem, ToolCallItem, ToolCallOutputItem
from agents.models.fake_id import FAKE_RESPONSES_ID
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputRefusal,
    ResponseOutputText,
    ResponseReasoningItem,
)
from pydantic import BaseModel
from openai.types.responses.response_output_item import McpApprovalRequest

from ag_ui.core import EventType
from ag_ui_openai_agents.engine import OpenAIToAGUITranslator
from ag_ui_openai_agents.engine.types import (
    OpenAIItemType,
    OpenAIRawResponseEventType,
    OpenAIStreamEventType,
)

_AGENT = Agent(name="test-agent")


# ── event builders — shaped like the SDK's real stream events ────────────


def _raw(kind: OpenAIRawResponseEventType, **data) -> SimpleNamespace:
    """A RawResponsesStreamEvent wrapping one Responses payload."""
    return SimpleNamespace(
        type=OpenAIStreamEventType.RAW_RESPONSE,
        data=SimpleNamespace(type=kind, **data),
    )


def _added(item_type: OpenAIItemType, output_index: int = 0, **item) -> SimpleNamespace:
    return _raw(
        OpenAIRawResponseEventType.OUTPUT_ITEM_ADDED,
        item=SimpleNamespace(type=item_type, **item),
        output_index=output_index,
    )


def _done(item_type: OpenAIItemType, output_index: int = 0, **item) -> SimpleNamespace:
    return _raw(
        OpenAIRawResponseEventType.OUTPUT_ITEM_DONE,
        item=SimpleNamespace(type=item_type, **item),
        output_index=output_index,
    )


def _run_item(item) -> SimpleNamespace:
    return SimpleNamespace(type=OpenAIStreamEventType.RUN_ITEM, name="x", item=item)


def _message_item(item_id: str, text: str) -> MessageOutputItem:
    return MessageOutputItem(
        agent=_AGENT,
        raw_item=ResponseOutputMessage(
            id=item_id,
            type="message",
            role="assistant",
            status="completed",
            content=[ResponseOutputText(type="output_text", text=text, annotations=[])],
        ),
    )


def _agent_updated(name: str) -> SimpleNamespace:
    return SimpleNamespace(
        type=OpenAIStreamEventType.AGENT_UPDATED,
        new_agent=SimpleNamespace(name=name),
    )


def _drive(engine: OpenAIToAGUITranslator, *events) -> list:
    out: list = []
    for event in events:
        out.extend(engine.translate(event))
    return out


def _types(events) -> list[EventType]:
    return [e.type for e in events]


# ── text streaming ───────────────────────────────────────────────────────


def test_text_streams_start_content_end_under_one_id():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="Hel"),
        _raw(OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="lo"),
        _done(OpenAIItemType.MESSAGE, id="msg_1"),
    )
    assert _types(events) == [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ]
    ids = {e.message_id for e in events}
    assert ids == {"msg_1"}, "the whole window must carry the real item id"
    assert events[0].role == "assistant"
    assert [e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT] == [
        "Hel",
        "lo",
    ]


def test_text_delta_lazily_opens_window_without_output_item_added():
    # Some backends jump straight to deltas with no output_item.added first.
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _raw(OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="hi"),
    )
    assert _types(events) == [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]
    # The real item id must be reused even on the lazy path — a generated id here
    # would make a later MessageOutputItem commit fail to reconcile and duplicate.
    assert {e.message_id for e in events} == {"msg_1"}


def test_text_done_does_not_close_the_message_window():
    # output_text.done ends one content part, not the message — the window
    # must stay open for output_item.done to close.
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="hi"),
        _raw(OpenAIRawResponseEventType.TEXT_DONE, item_id="msg_1", output_index=0),
    )
    assert EventType.TEXT_MESSAGE_END not in _types(events)
    events = _drive(engine, _done(OpenAIItemType.MESSAGE, id="msg_1"))
    assert _types(events) == [EventType.TEXT_MESSAGE_END]
    assert events[0].message_id == "msg_1"


def test_two_text_parts_stream_as_one_message():
    # A message can carry several content parts, each with its own
    # output_text.done. All of them belong to one AG-UI message id.
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="First"),
        _raw(OpenAIRawResponseEventType.TEXT_DONE, item_id="msg_1", output_index=0),
        _raw(
            OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="Second"
        ),
        _raw(OpenAIRawResponseEventType.TEXT_DONE, item_id="msg_1", output_index=0),
        _done(OpenAIItemType.MESSAGE, id="msg_1"),
    )
    assert _types(events) == [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ]
    assert {e.message_id for e in events} == {"msg_1"}


def test_run_item_commit_closes_text_when_output_item_done_is_skipped():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="hi"),
        _raw(OpenAIRawResponseEventType.TEXT_DONE, item_id="msg_1", output_index=0),
        _run_item(_message_item("msg_1", "hi")),
    )
    assert _types(events)[-1] == EventType.TEXT_MESSAGE_END
    assert events[-1].message_id == "msg_1"


def test_finalize_closes_text_left_open_after_text_done():
    engine = OpenAIToAGUITranslator()
    _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="hi"),
        _raw(OpenAIRawResponseEventType.TEXT_DONE, item_id="msg_1", output_index=0),
    )
    events = engine.finalize()
    assert _types(events) == [EventType.TEXT_MESSAGE_END]
    assert events[0].message_id == "msg_1"


def test_message_with_text_and_refusal_records_both_in_snapshot():
    # extract_text ignores refusals, so a naive `text or refusal` would drop the
    # refusal from the snapshot even though it streamed into the same window.
    engine = OpenAIToAGUITranslator()
    raw = ResponseOutputMessage(
        id="msg_1",
        type="message",
        role="assistant",
        status="completed",
        content=[
            ResponseOutputText(type="output_text", text="Here is ", annotations=[]),
            ResponseOutputRefusal(type="refusal", refusal="I can't help with that."),
        ],
    )
    events = _drive(engine, _run_item(MessageOutputItem(agent=_AGENT, raw_item=raw)))
    streamed = "".join(
        e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT
    )
    assert streamed == "Here is I can't help with that."
    assert engine._snapshot_messages[0].content == "Here is I can't help with that."


def test_refusal_delta_streams_into_the_text_window():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, id="msg_1"),
        _raw(OpenAIRawResponseEventType.REFUSAL_DELTA, item_id="msg_1", output_index=0, delta="no"),
    )
    assert _types(events) == [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]
    assert events[1].delta == "no"


def test_text_less_message_item_wrapping_a_tool_call_emits_no_window():
    # Some backends can announce a message item even on a pure tool-call turn
    # that never carries text: an
    # output_item.added(message), the whole tool call, then
    # output_item.done(message) — with no text delta in between. The message
    # window must never open, so the tool call stays a clean sibling and no
    # empty TEXT_MESSAGE_START/END brackets it on the wire.
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.MESSAGE, output_index=0, id="msg_1"),
        _added(
            OpenAIItemType.FUNCTION_CALL,
            output_index=1,
            id="fc_1",
            call_id="call_1",
            name="change_background",
        ),
        _raw(
            OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=1,
            delta='{"background":"red"}',
        ),
        _done(
            OpenAIItemType.FUNCTION_CALL,
            output_index=1,
            id="fc_1",
            call_id="call_1",
            name="change_background",
        ),
        _done(OpenAIItemType.MESSAGE, output_index=0, id="msg_1"),
    )
    assert _types(events) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert EventType.TEXT_MESSAGE_START not in _types(events)
    assert EventType.TEXT_MESSAGE_END not in _types(events)


# ── tool-call streaming ──────────────────────────────────────────────────


def test_function_call_streams_start_args_end_under_the_call_id():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added(OpenAIItemType.FUNCTION_CALL, id="fc_1", call_id="call_1", name="get_weather"),
        _raw(
            OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=0,
            delta='{"city":',
        ),
        _raw(
            OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=0,
            delta='"Cairo"}',
        ),
        _done(OpenAIItemType.FUNCTION_CALL, id="fc_1", call_id="call_1", name="get_weather"),
    )
    assert _types(events) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert {e.tool_call_id for e in events} == {"call_1"}
    assert events[0].tool_call_name == "get_weather"
    assert "".join(e.delta for e in events if e.type == EventType.TOOL_CALL_ARGS) == (
        '{"city":"Cairo"}'
    )


def test_function_call_args_delta_before_added_is_buffered_then_dropped_if_uncommitted():
    # A provider that streams args with no output_item.added has no call_id to
    # emit yet, so the args are buffered (nothing on the wire) rather than opened
    # under a throwaway id the later commit could not reconcile. With no
    # output_item.added and no run-item commit ever arriving, the call was never
    # completed by the SDK, so finalize drops the buffer (no phantom call).
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _raw(
            OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=0,
            delta="{}",
        ),
    )
    assert events == [], "premature args must buffer, not open under a throwaway id"
    assert engine.finalize() == []


def test_placeholder_id_args_before_added_flush_into_single_call():
    # Chat-Completions-backed (FAKE id) backend streams args before
    # output_item.added, then the added arrives. The buffered args must flush into
    # the same call the added opens — one call under the real call_id, no split,
    # and no internal placeholder key leaked onto the wire.
    engine = OpenAIToAGUITranslator()
    assert (
        _drive(
            engine,
            _raw(
                OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
                item_id=FAKE_RESPONSES_ID,
                output_index=0,
                delta='{"a":',
            ),
        )
        == []
    )
    events = _drive(
        engine,
        _added(
            OpenAIItemType.FUNCTION_CALL,
            output_index=0,
            id=FAKE_RESPONSES_ID,
            call_id="call_1",
            name="f",
        ),
        _raw(
            OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id=FAKE_RESPONSES_ID,
            output_index=0,
            delta="1}",
        ),
        _done(
            OpenAIItemType.FUNCTION_CALL,
            output_index=0,
            id=FAKE_RESPONSES_ID,
            call_id="call_1",
            name="f",
        ),
    )
    assert _types(events) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert {e.tool_call_id for e in events} == {"call_1"}
    assert "".join(e.delta for e in events if e.type == EventType.TOOL_CALL_ARGS) == '{"a":1}'
    assert engine.finalize() == []


def test_placeholder_id_args_then_commit_emits_no_phantom():
    # FAKE-id backend streams args before any added, then commits via a
    # ToolCallItem. The buffer (keyed by a placeholder the commit cannot address
    # by id) must be consumed so finalize does not re-emit it as a phantom call.
    engine = OpenAIToAGUITranslator()
    assert (
        _drive(
            engine,
            _raw(
                OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
                item_id=FAKE_RESPONSES_ID,
                output_index=0,
                delta='{"a":1}',
            ),
        )
        == []
    )
    raw = ResponseFunctionToolCall(
        id=FAKE_RESPONSES_ID,
        type="function_call",
        call_id="call_1",
        name="f",
        arguments='{"a":1}',
    )
    commit = _drive(engine, _run_item(ToolCallItem(agent=_AGENT, raw_item=raw)))
    assert _types(commit) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert {e.tool_call_id for e in commit} == {"call_1"}
    assert engine.finalize() == []


def test_placeholder_id_text_delta_synthesizes_a_clean_message_id():
    # A FAKE-id text delta with no output_item.added must synthesize a real
    # generated id, never leak the internal "__idx_" placeholder window key.
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _raw(
            OpenAIRawResponseEventType.TEXT_DELTA,
            item_id=FAKE_RESPONSES_ID,
            output_index=0,
            delta="hi",
        ),
    )
    assert _types(events) == [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]
    mid = events[0].message_id
    assert mid.startswith("msg_")
    assert not mid.startswith("__idx_") and mid != FAKE_RESPONSES_ID


def test_reasoning_delta_reuses_real_wire_id():
    # Reasoning that streams deltas before output_item.added must still reuse the
    # real wire id for the phase (honors the id-reuse invariant), not synthesize one.
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _raw(
            OpenAIRawResponseEventType.REASONING_SUMMARY_DELTA,
            item_id="rs_9",
            output_index=0,
            delta="think",
        ),
    )
    starts = [e for e in events if e.type == EventType.REASONING_START]
    assert starts and starts[0].message_id == "rs_9"


def test_args_before_added_then_run_item_commit_emits_no_duplicate():
    # Regression: args stream before output_item.added, then the semantic
    # ToolCallItem commit arrives with the real call_id. Must emit exactly one
    # START/ARGS/END under the real call_id — not a duplicate (buffered id +
    # committed id) as the pre-fix throwaway-id path produced.
    engine = OpenAIToAGUITranslator()
    buffered = _drive(
        engine,
        _raw(
            OpenAIRawResponseEventType.FUNCTION_CALL_ARGUMENTS_DELTA,
            item_id="fc_1",
            output_index=0,
            delta='{"city":"Cairo"}',
        ),
    )
    assert buffered == []
    raw = ResponseFunctionToolCall(
        id="fc_1",
        type="function_call",
        call_id="call_1",
        name="get_weather",
        arguments='{"city":"Cairo"}',
    )
    commit = _drive(engine, _run_item(ToolCallItem(agent=_AGENT, raw_item=raw)))
    assert _types(commit) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert {e.tool_call_id for e in commit} == {"call_1"}
    # Buffer was consumed by the commit — finalize has nothing left to flush.
    assert engine.finalize() == []


def test_hosted_tool_call_with_distinct_call_id_streams_once():
    # Hosted calls like computer_call carry both an item id and a call_id.
    # The raw window and the run-item commit must agree on the call_id —
    # otherwise the same call streams two full lifecycles under two ids.
    engine = OpenAIToAGUITranslator()
    raw = SimpleNamespace(type="computer_call", id="comp_1", call_id="call_1")
    events = _drive(
        engine,
        _added("computer_call", id="comp_1", call_id="call_1"),
        _done("computer_call", id="comp_1", call_id="call_1"),
        _run_item(ToolCallItem(agent=_AGENT, raw_item=raw)),
    )
    assert _types(events) == [EventType.TOOL_CALL_START, EventType.TOOL_CALL_END]
    assert {e.tool_call_id for e in events} == {"call_1"}


def test_hosted_tool_call_without_call_id_falls_back_to_item_id():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _added("web_search_call", id="ws_1"),
        _done("web_search_call", id="ws_1"),
    )
    assert _types(events) == [EventType.TOOL_CALL_START, EventType.TOOL_CALL_END]
    assert {e.tool_call_id for e in events} == {"ws_1"}


def test_tool_output_item_emits_tool_call_result():
    engine = OpenAIToAGUITranslator()
    item = ToolCallOutputItem(
        agent=_AGENT,
        raw_item={"type": "function_call_output", "call_id": "call_1", "output": "sunny"},
        output="sunny",
    )
    events = _drive(engine, _run_item(item))
    assert _types(events) == [EventType.TOOL_CALL_RESULT]
    assert events[0].tool_call_id == "call_1"
    assert events[0].content == "sunny"


def test_tool_output_call_id_falls_back_to_raw_item_when_property_absent():
    # Older SDK ToolCallOutputItem has no `call_id` property; the translator must
    # fall back to the raw item rather than raise AttributeError.
    engine = OpenAIToAGUITranslator()
    item = SimpleNamespace(
        raw_item={"type": "function_call_output", "call_id": "call_1", "output": "sunny"},
        output="sunny",
    )
    events = engine.translate_tool_call_output_item(item)
    assert _types(events) == [EventType.TOOL_CALL_RESULT]
    assert events[0].tool_call_id == "call_1"
    assert events[0].content == "sunny"


# ── reasoning streaming ──────────────────────────────────────────────────


def test_reasoning_summary_delta_opens_phase_and_part():
    engine = OpenAIToAGUITranslator()
    events = _drive(
        engine,
        _raw(
            OpenAIRawResponseEventType.REASONING_SUMMARY_DELTA,
            item_id="rs_1",
            output_index=0,
            delta="thinking",
        ),
        _raw(OpenAIRawResponseEventType.REASONING_SUMMARY_PART_DONE, item_id="rs_1", output_index=0),
    )
    assert _types(events) == [
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
    ]
    assert events[2].delta == "thinking"
    # The phase stays open until finalize (only the part closed above).
    assert _types(engine.finalize()) == [EventType.REASONING_END]


def test_fake_reasoning_id_starts_fresh_when_output_index_is_reused():
    engine = OpenAIToAGUITranslator()
    events = []

    for encrypted in ("first", "second"):
        events.extend(
            _drive(
                engine,
                _added(OpenAIItemType.REASONING, id=FAKE_RESPONSES_ID),
                _raw(
                    OpenAIRawResponseEventType.REASONING_TEXT_DELTA,
                    item_id=FAKE_RESPONSES_ID,
                    output_index=0,
                    delta="thinking",
                ),
                _raw(
                    OpenAIRawResponseEventType.REASONING_TEXT_DONE,
                    item_id=FAKE_RESPONSES_ID,
                    output_index=0,
                ),
                _done(
                    OpenAIItemType.REASONING,
                    id=FAKE_RESPONSES_ID,
                    encrypted_content=encrypted,
                ),
            )
        )

    # A new item must also reset the key when the previous provider turn
    # omitted output_item.done but another output already closed its reasoning.
    events.extend(
        _drive(
            engine,
            _added(OpenAIItemType.REASONING, id=FAKE_RESPONSES_ID),
            _raw(
                OpenAIRawResponseEventType.REASONING_TEXT_DELTA,
                item_id=FAKE_RESPONSES_ID,
                output_index=0,
                delta="thinking",
            ),
            _raw(
                OpenAIRawResponseEventType.REASONING_TEXT_DONE,
                item_id=FAKE_RESPONSES_ID,
                output_index=0,
            ),
            _added(OpenAIItemType.MESSAGE, output_index=1, id="msg_1"),
            _added(OpenAIItemType.REASONING, id=FAKE_RESPONSES_ID),
            _raw(
                OpenAIRawResponseEventType.REASONING_TEXT_DELTA,
                item_id=FAKE_RESPONSES_ID,
                output_index=0,
                delta="thinking again",
            ),
        )
    )

    phase_ids = [
        event.message_id for event in events if event.type == EventType.REASONING_START
    ]
    part_ids = [
        event.message_id
        for event in events
        if event.type == EventType.REASONING_MESSAGE_START
    ]
    encrypted_values = [
        event.encrypted_value
        for event in events
        if event.type == EventType.REASONING_ENCRYPTED_VALUE
    ]

    assert part_ids == phase_ids
    assert encrypted_values == ["first", "second"]


def test_reasoning_commit_surfaces_encrypted_value_on_skip_path():
    # Reasoning streams and closes via raw events carrying no encrypted_content;
    # the ReasoningItem run-item commit is then the only carrier of it. The skip
    # path must still surface REASONING_ENCRYPTED_VALUE so replay data is not lost.
    engine = OpenAIToAGUITranslator()
    _drive(
        engine,
        _added(OpenAIItemType.REASONING, id="rs_1"),
        _raw(
            OpenAIRawResponseEventType.REASONING_TEXT_DELTA,
            item_id="rs_1",
            output_index=0,
            delta="hmm",
        ),
        _raw(OpenAIRawResponseEventType.REASONING_TEXT_DONE, item_id="rs_1", output_index=0),
        _done(OpenAIItemType.REASONING, id="rs_1"),  # no encrypted_content here
    )
    item = ReasoningItem(
        agent=_AGENT,
        raw_item=ResponseReasoningItem(
            id="rs_1", type="reasoning", summary=[], encrypted_content="secret"
        ),
    )
    events = _drive(engine, _run_item(item))
    assert _types(events) == [EventType.REASONING_ENCRYPTED_VALUE]
    assert events[0].encrypted_value == "secret"


def test_tool_output_pydantic_model_serializes_its_fields():
    # to_string should serialize a pydantic tool output to its field dict rather
    # than an opaque quoted repr.
    class Weather(BaseModel):
        city: str
        temp: int

    engine = OpenAIToAGUITranslator()
    item = ToolCallOutputItem(
        agent=_AGENT,
        raw_item={"type": "function_call_output", "call_id": "call_1", "output": "ignored"},
        output=Weather(city="Cairo", temp=30),
    )
    events = _drive(engine, _run_item(item))
    assert _types(events) == [EventType.TOOL_CALL_RESULT]
    assert __import__("json").loads(events[0].content) == {"city": "Cairo", "temp": 30}


def test_reasoning_auto_closes_when_text_output_starts():
    # Once real output begins, any open reasoning must be closed first —
    # reasoning must never bleed into the answer window.
    engine = OpenAIToAGUITranslator()
    _drive(
        engine,
        _raw(
            OpenAIRawResponseEventType.REASONING_TEXT_DELTA,
            item_id="rs_1",
            output_index=0,
            delta="hmm",
        ),
    )
    # output_item.added closes reasoning right away (output has begun), but
    # holds back TEXT_MESSAGE_START — that waits for a real delta so a
    # text-less item can't emit an empty window.
    events = _drive(engine, _added(OpenAIItemType.MESSAGE, id="msg_1"))
    assert _types(events) == [
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
    ]
    events = _drive(
        engine,
        _raw(OpenAIRawResponseEventType.TEXT_DELTA, item_id="msg_1", output_index=0, delta="ok"),
    )
    assert _types(events) == [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]
    assert events[0].message_id == "msg_1", "deferred START must carry the reserved id"


# ── multi-agent steps ────────────────────────────────────────────────────


def test_agent_updated_opens_a_step_finalize_closes_it():
    engine = OpenAIToAGUITranslator()
    events = _drive(engine, _agent_updated("triage_agent"))
    assert _types(events) == [EventType.STEP_STARTED]
    assert events[0].step_name == "triage_agent"
    closing = engine.finalize()
    assert _types(closing) == [EventType.STEP_FINISHED]
    assert closing[0].step_name == "triage_agent"


def test_handoff_pairs_step_finished_with_the_next_step_started():
    engine = OpenAIToAGUITranslator()
    _drive(engine, _agent_updated("triage_agent"))
    events = _drive(engine, _agent_updated("billing_agent"))
    assert _types(events) == [EventType.STEP_FINISHED, EventType.STEP_STARTED]
    assert events[0].step_name == "triage_agent"
    assert events[1].step_name == "billing_agent"


# ── handoff items (surface as a tool call + result) ──────────────────────


def test_handoff_call_and_output_items_map_to_tool_call_and_result():
    engine = OpenAIToAGUITranslator()
    call = HandoffCallItem(
        agent=_AGENT,
        raw_item=ResponseFunctionToolCall(
            id="fc_h",
            type="function_call",
            call_id="call_h",
            name="transfer_to_billing",
            arguments="{}",
        ),
    )
    output = HandoffOutputItem(
        agent=_AGENT,
        raw_item={"type": "function_call_output", "call_id": "call_h", "output": "done"},
        source_agent=_AGENT,
        target_agent=Agent(name="billing_agent"),
    )
    call_events = _drive(engine, _run_item(call))
    assert _types(call_events) == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
    ]
    assert {e.tool_call_id for e in call_events} == {"call_h"}
    assert call_events[0].tool_call_name == "transfer_to_billing"

    result_events = _drive(engine, _run_item(output))
    assert _types(result_events) == [EventType.TOOL_CALL_RESULT]
    assert result_events[0].tool_call_id == "call_h"
    assert result_events[0].content == "done"


# ── MCP approval → CUSTOM (no native AG-UI shape yet) ────────────────────


def test_mcp_approval_request_maps_to_a_custom_event():
    engine = OpenAIToAGUITranslator()
    item = MCPApprovalRequestItem(
        agent=_AGENT,
        raw_item=McpApprovalRequest(
            id="mcpr_1",
            type="mcp_approval_request",
            name="do_it",
            arguments="{}",
            server_label="srv",
        ),
    )
    events = _drive(engine, _run_item(item))
    assert _types(events) == [EventType.CUSTOM]
    assert events[0].name == "mcp_approval_request"
    assert events[0].value["name"] == "do_it"


# ── graceful degradation ─────────────────────────────────────────────────


def test_unknown_stream_event_type_translates_to_nothing():
    engine = OpenAIToAGUITranslator()
    assert engine.translate(SimpleNamespace(type="something_new", data=None)) == []

"""
Tests for OpenAIToAGUITranslator.build_messages_snapshot.

The invariant that matters: every id in the snapshot equals the id the
streamed events already used — guaranteed by construction, since the
engine resolves each item's id once and hands it to both the streamed
event and the accumulated snapshot message. See the snapshot-message
builders in engine/openai_to_agui.py.
"""

from __future__ import annotations

from agents import Agent
from agents.items import (
    MessageOutputItem,
    ReasoningItem,
    ToolCallItem,
    ToolCallOutputItem,
)
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseReasoningItem,
)

from ag_ui.core import (
    AssistantMessage,
    EventType,
    RunAgentInput,
    ToolMessage,
    UserMessage,
)
from ag_ui_openai_agents.engine import OpenAIToAGUITranslator

_AGENT = Agent(name="test-agent")


def _text_item(item_id: str = "msg_abc", text: str = "hello") -> MessageOutputItem:
    return MessageOutputItem(
        agent=_AGENT,
        raw_item=ResponseOutputMessage(
            id=item_id,
            type="message",
            role="assistant",
            status="completed",
            content=[
                ResponseOutputText(type="output_text", text=text, annotations=[])
            ],
        ),
    )


def _tool_call_item(call_id: str = "call_1", name: str = "get_weather") -> ToolCallItem:
    return ToolCallItem(
        agent=_AGENT,
        raw_item=ResponseFunctionToolCall(
            id="fc_1",
            type="function_call",
            call_id=call_id,
            name=name,
            arguments='{"city":"Cairo"}',
        ),
    )


def _tool_output_item(call_id: str = "call_1", output: str = "sunny") -> ToolCallOutputItem:
    return ToolCallOutputItem(
        agent=_AGENT,
        raw_item={
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        },
        output=output,
    )


def _reasoning_item(item_id: str = "rs_1") -> ReasoningItem:
    return ReasoningItem(
        agent=_AGENT,
        raw_item=ResponseReasoningItem(id=item_id, type="reasoning", summary=[]),
    )


# ── id consistency: snapshot ids == streamed event ids ───────────────────


def test_snapshot_ids_match_streamed_event_ids():
    engine = OpenAIToAGUITranslator()
    items = [_text_item(), _tool_call_item(), _tool_output_item()]
    streamed = []
    for item in items:
        streamed.extend(engine.translate_item(item))
    streamed.extend(engine.finalize())

    streamed_text_ids = {
        e.message_id for e in streamed if e.type == EventType.TEXT_MESSAGE_START
    }
    streamed_call_ids = {
        e.tool_call_id for e in streamed if e.type == EventType.TOOL_CALL_START
    }
    streamed_result_ids = {
        e.message_id for e in streamed if e.type == EventType.TOOL_CALL_RESULT
    }

    messages = engine._snapshot_messages
    text_ids = {
        m.id for m in messages
        if isinstance(m, AssistantMessage) and not m.tool_calls
    }
    call_ids = {
        call.id
        for m in messages
        if isinstance(m, AssistantMessage) and m.tool_calls
        for call in m.tool_calls
    }
    result_ids = {m.id for m in messages if isinstance(m, ToolMessage)}

    assert text_ids == streamed_text_ids == {"msg_abc"}
    assert call_ids == streamed_call_ids == {"call_1"}
    assert result_ids == streamed_result_ids == {"call_1-result"}

    # Guard against duplicate emission that the set comparisons above would
    # silently collapse: each id must appear on the wire exactly once.
    start_ids = [e.message_id for e in streamed if e.type == EventType.TEXT_MESSAGE_START]
    call_start_ids = [e.tool_call_id for e in streamed if e.type == EventType.TOOL_CALL_START]
    result_event_ids = [e.message_id for e in streamed if e.type == EventType.TOOL_CALL_RESULT]
    assert len(start_ids) == len(set(start_ids))
    assert len(call_start_ids) == len(set(call_start_ids))
    assert len(result_event_ids) == len(set(result_event_ids))


# ── tool call + result round-trip ────────────────────────────────────────


def test_tool_call_and_result_round_trip():
    engine = OpenAIToAGUITranslator()
    engine.translate_item(_tool_call_item())
    engine.translate_item(_tool_output_item())

    call_message, result_message = engine._snapshot_messages
    assert isinstance(call_message, AssistantMessage)
    assert call_message.id == "call_1"
    assert call_message.tool_calls[0].function.name == "get_weather"
    assert call_message.tool_calls[0].function.arguments == '{"city":"Cairo"}'

    assert isinstance(result_message, ToolMessage)
    assert result_message.tool_call_id == "call_1"
    assert result_message.id == "call_1-result"
    assert result_message.content == "sunny"


# ── multi-turn history: prior messages pass through untouched ────────────


def test_snapshot_prepends_input_history_with_original_ids():
    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=[
            UserMessage(id="m1", role="user", content="hi"),
            AssistantMessage(id="msg_prev", role="assistant", content="hello"),
            UserMessage(id="m2", role="user", content="and again"),
        ],
        tools=[],
        state={},
        context=[],
        forwarded_props=None,
    )
    engine = OpenAIToAGUITranslator()
    engine.translate_item(_text_item("msg_new", "hi again"))

    event = engine.build_messages_snapshot(run_input)

    assert event.type == EventType.MESSAGES_SNAPSHOT
    assert [m.id for m in event.messages] == ["m1", "msg_prev", "m2", "msg_new"]
    # Prior messages are the same objects, not copies with fresh ids.
    assert event.messages[0] is run_input.messages[0]


def test_snapshot_accepts_message_list_and_none_history():
    engine = OpenAIToAGUITranslator()
    engine.translate_item(_text_item())

    prior = [UserMessage(id="m1", role="user", content="hi")]
    assert [m.id for m in engine.build_messages_snapshot(prior).messages] == [
        "m1",
        "msg_abc",
    ]
    assert [m.id for m in engine.build_messages_snapshot(None).messages] == ["msg_abc"]
    assert [m.id for m in engine.build_messages_snapshot().messages] == ["msg_abc"]


# ── graceful degradation ─────────────────────────────────────────────────


def test_reasoning_items_are_skipped_from_snapshot():
    engine = OpenAIToAGUITranslator()
    engine.translate_item(_reasoning_item())
    engine.translate_item(_text_item())

    assert [m.id for m in engine._snapshot_messages] == ["msg_abc"]


def test_unknown_item_types_are_skipped_not_raised():
    from types import SimpleNamespace

    engine = OpenAIToAGUITranslator()
    unknown = SimpleNamespace(raw_item={"type": "something_else"})

    events = engine.translate_item(unknown)

    assert events == []
    assert engine._snapshot_messages == []


# ── raw close beats run-item commit: the real regression ────────────────
#
# Some backends emit response.output_item.done (closing the window via the
# raw-event path) before the RunItemStreamEvent commit for the same item
# arrives. translate_message_output_item/translate_tool_call_item then hit
# their "skip" branch (nothing left to close) — that branch used to return
# [] without ever recording a snapshot message, so the item streamed fully
# but never made it into MESSAGES_SNAPSHOT. Observed on a real run.


def test_text_message_closed_by_raw_event_before_commit_still_snapshots():
    from types import SimpleNamespace

    engine = OpenAIToAGUITranslator()

    # response.output_item.added then .done — closes the window via the
    # raw-event path, same as a real streaming run.
    added = SimpleNamespace(
        item=SimpleNamespace(type="message", id="msg_real"), output_index=0
    )
    done = SimpleNamespace(
        item=SimpleNamespace(type="message", id="msg_real"), output_index=0
    )
    engine.translate_output_item_added(added)
    # A text delta must actually open the (deferred) message window, so that
    # output_item.done closes it and appends msg_real to _closed_text_ids —
    # otherwise the commit reconciles as "new" and this never exercises the
    # "skip" branch the regression is about.
    engine.translate_text_delta(
        SimpleNamespace(item_id="msg_real", output_index=0, delta="hello")
    )
    engine.translate_output_item_done(done)
    assert engine._snapshot_messages == []  # streamed close alone never records

    # The run-item commit arrives after — must still record, under the
    # same id the raw close already used.
    engine.translate_item(_text_item("msg_real", "hello"))

    assert len(engine._snapshot_messages) == 1
    message = engine._snapshot_messages[0]
    assert isinstance(message, AssistantMessage)
    assert message.id == "msg_real"
    assert message.content == "hello"


def test_tool_call_closed_by_raw_event_before_commit_still_snapshots():
    from types import SimpleNamespace

    engine = OpenAIToAGUITranslator()

    added = SimpleNamespace(
        item=SimpleNamespace(
            type="function_call", id="fc_1", call_id="call_real", name="get_weather"
        ),
        output_index=0,
    )
    done = SimpleNamespace(
        item=SimpleNamespace(
            type="function_call", id="fc_1", call_id="call_real", name="get_weather"
        ),
        output_index=0,
    )
    engine.translate_output_item_added(added)
    engine.translate_output_item_done(done)
    assert engine._snapshot_messages == []

    engine.translate_item(_tool_call_item(call_id="call_real"))

    assert len(engine._snapshot_messages) == 1
    message = engine._snapshot_messages[0]
    assert isinstance(message, AssistantMessage)
    assert message.tool_calls[0].id == "call_real"
    assert message.tool_calls[0].function.name == "get_weather"

"""Tests for the native history ``_build_strands_history`` replays to the model.

The history is handed to the provider wholesale, so it has to be a history the
provider accepts. A ``toolResult`` block that no ``toolUse`` in the same history
answers is not: real providers reject it, which turns a turn the continuation
prompt could still have carried into a generic provider failure.
"""

from __future__ import annotations

import logging

from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    ToolCall,
    ToolMessage,
    UserMessage,
)

from ag_ui_strands.agent import _build_strands_history


def _tool_call(call_id: str, name: str = "get_weather") -> ToolCall:
    return ToolCall(id=call_id, function=FunctionCall(name=name, arguments="{}"))


def _tool_results(history: list) -> list:
    return [
        block["toolResult"]
        for message in history
        for block in message["content"]
        if "toolResult" in block
    ]


def _tool_use_ids(history: list) -> list:
    return [
        block["toolUse"]["toolUseId"]
        for message in history
        for block in message["content"]
        if "toolUse" in block
    ]


class TestOrphanToolResults:
    def test_answered_result_survives_replay(self):
        history = _build_strands_history(
            [
                UserMessage(id="u1", content="weather?"),
                AssistantMessage(id="a1", tool_calls=[_tool_call("tc1")]),
                ToolMessage(id="t1", content="sunny", tool_call_id="tc1"),
            ]
        )

        assert _tool_use_ids(history) == ["tc1"]
        assert [result["toolUseId"] for result in _tool_results(history)] == ["tc1"]

    def test_result_no_replayed_call_answers_is_dropped(self):
        # A delta-only continuation carries the result without the assistant
        # message that opened the call, so nothing in the replayed history
        # answers it.
        history = _build_strands_history(
            [ToolMessage(id="t1", content="sunny", tool_call_id="tc1")]
        )

        assert _tool_results(history) == []

    def test_only_the_unanswered_result_is_dropped(self):
        history = _build_strands_history(
            [
                UserMessage(id="u1", content="weather?"),
                AssistantMessage(id="a1", tool_calls=[_tool_call("tc1")]),
                ToolMessage(id="t1", content="sunny", tool_call_id="tc1"),
                ToolMessage(id="t2", content="stale", tool_call_id="tc-gone"),
            ]
        )

        assert [result["toolUseId"] for result in _tool_results(history)] == ["tc1"]

    def test_result_ahead_of_its_call_is_dropped(self):
        # Nothing offers it a home at the point it arrives, and the forward scan
        # that pairs calls with results never looks backwards for one.
        history = _build_strands_history(
            [
                ToolMessage(id="t1", content="sunny", tool_call_id="tc1"),
                AssistantMessage(id="a1", tool_calls=[_tool_call("tc1")]),
            ]
        )

        assert _tool_results(history) == []
        assert _tool_use_ids(history) == ["tc1"]

    def test_a_dropped_result_is_reported(self, caplog):
        with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
            _build_strands_history(
                [ToolMessage(id="t1", content="sunny", tool_call_id="tc-gone")]
            )

        reported = [record.getMessage() for record in caplog.records]
        assert any(
            "no replayed tool call" in message and "tc-gone" in message
            for message in reported
        )

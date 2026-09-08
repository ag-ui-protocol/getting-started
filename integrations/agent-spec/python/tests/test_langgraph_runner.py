# Copyright © 2025 Oracle and/or its affiliates.
#
# This software is under the Apache License 2.0
# (LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0) or Universal Permissive License
# (UPL) 1.0 (LICENSE-UPL or https://oss.oracle.com/licenses/upl), at your option.
"""Behaviour tests for the LangGraph runner's input-preparation helpers.

These exercise the pure message-shaping logic and the new-message filter with a
fake CompiledStateGraph; no LLM or LangGraph runtime is invoked.
"""

from types import SimpleNamespace

import pytest

from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    SystemMessage,
    ToolCall,
    ToolMessage,
    UserMessage,
)

from ag_ui_agentspec.runtimes.langgraph_runner import (
    filter_only_new_messages,
    prepare_langgraph_agent_inputs,
)


class TestPrepareLangGraphAgentInputs:
    def test_empty_messages_returns_empty(self, make_input):
        assert prepare_langgraph_agent_inputs(make_input(messages=[])) == []

    def test_user_message_name_is_stripped(self, make_input):
        inp = make_input(messages=[UserMessage(id="1", role="user", content="hi", name="alice")])
        out = prepare_langgraph_agent_inputs(inp)
        assert "name" not in out[0]
        assert out[0]["content"] == "hi"

    def test_assistant_message_name_is_stripped(self, make_input):
        inp = make_input(
            messages=[AssistantMessage(id="1", role="assistant", content="hi", name="bot")]
        )
        out = prepare_langgraph_agent_inputs(inp)
        assert "name" not in out[0]

    def test_assistant_none_content_becomes_empty_string(self, make_input):
        inp = make_input(
            messages=[AssistantMessage(id="1", role="assistant", content=None)]
        )
        out = prepare_langgraph_agent_inputs(inp)
        assert out[0]["content"] == ""

    def test_assistant_with_only_tool_calls_has_content_backfilled(self, make_input):
        """An assistant turn that carries only tool calls has no content at all.

        Distinct from the case above, which sets ``content=None`` explicitly: an
        optional field with no value is absent from ``model_dump()`` output, not
        present as ``None``. Reading it with ``[]`` raises ``KeyError`` on exactly
        this shape, which is an ordinary tool-calling turn rather than an edge case.
        """
        inp = make_input(
            messages=[
                AssistantMessage(
                    id="1",
                    role="assistant",
                    tool_calls=[
                        ToolCall(
                            id="tc1",
                            function=FunctionCall(name="search", arguments="{}"),
                        )
                    ],
                )
            ]
        )
        out = prepare_langgraph_agent_inputs(inp)
        assert out[0]["content"] == ""
        assert out[0]["tool_calls"][0]["id"] == "tc1"

    def test_tool_message_error_key_is_stripped(self, make_input):
        inp = make_input(
            messages=[ToolMessage(id="1", role="tool", content="r", tool_call_id="tc1", error="oops")]
        )
        out = prepare_langgraph_agent_inputs(inp)
        assert "error" not in out[0]

    def test_system_message_is_passed_through(self, make_input):
        inp = make_input(messages=[SystemMessage(id="1", role="system", content="be nice")])
        out = prepare_langgraph_agent_inputs(inp)
        assert out[0]["role"] == "system"
        assert out[0]["content"] == "be nice"


class _FakeGraph:
    """Minimal stand-in for a CompiledStateGraph exposing only ``aget_state``."""

    def __init__(self, existing_messages):
        self._existing = existing_messages

    async def aget_state(self, config):
        return SimpleNamespace(values={"messages": self._existing})


class TestFilterOnlyNewMessages:
    async def test_filters_out_already_seen_ids(self):
        existing = [SimpleNamespace(id="m1"), SimpleNamespace(id="m2")]
        graph = _FakeGraph(existing)
        incoming = [{"id": "m1", "content": "old"}, {"id": "m3", "content": "new"}]
        out = await filter_only_new_messages(graph, "thread-1", incoming)
        assert [m["id"] for m in out] == ["m3"]

    async def test_keeps_all_when_state_empty(self):
        graph = _FakeGraph([])
        incoming = [{"id": "m1"}, {"id": "m2"}]
        out = await filter_only_new_messages(graph, "thread-1", incoming)
        assert [m["id"] for m in out] == ["m1", "m2"]

    async def test_handles_none_messages_in_state(self):
        # state_snapshot.values.get("messages") may be None.
        class _NoneGraph(_FakeGraph):
            async def aget_state(self, config):
                return SimpleNamespace(values={"messages": None})

        out = await filter_only_new_messages(_NoneGraph([]), "t", [{"id": "x"}])
        assert [m["id"] for m in out] == ["x"]

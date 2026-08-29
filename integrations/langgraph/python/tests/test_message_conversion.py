"""Tests for AG-UI <-> LangChain message conversion functions."""
import unittest
import json
import pytest

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage

from ag_ui.core import (
    UserMessage as AGUIUserMessage,
    AssistantMessage as AGUIAssistantMessage,
    SystemMessage as AGUISystemMessage,
    ToolMessage as AGUIToolMessage,
    ReasoningMessage as AGUIReasoningMessage,
    DeveloperMessage as AGUIDeveloperMessage,
    ToolCall as AGUIToolCall,
    FunctionCall as AGUIFunctionCall,
    TextInputContent,
    BinaryInputContent,
)
from ag_ui_langgraph.utils import (
    agui_messages_to_langchain,
    langchain_messages_to_agui,
    normalize_tool_content,
)


class TestAguiMessagesToLangchain(unittest.TestCase):
    """Tests for agui_messages_to_langchain()."""

    def test_human_message(self):
        msg = AGUIUserMessage(id="h1", role="user", content="Hello")
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        assert isinstance(result[0], HumanMessage)
        assert result[0].content == "Hello"
        assert result[0].id == "h1"

    def test_assistant_message_plain(self):
        msg = AGUIAssistantMessage(id="a1", role="assistant", content="Hi there")
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        assert isinstance(result[0], AIMessage)
        assert result[0].content == "Hi there"
        assert result[0].id == "a1"

    def test_assistant_message_with_tool_calls(self):
        msg = AGUIAssistantMessage(
            id="a2",
            role="assistant",
            content="",
            tool_calls=[
                AGUIToolCall(
                    id="tc1",
                    type="function",
                    function=AGUIFunctionCall(
                        name="search",
                        arguments='{"query": "weather"}',
                    ),
                )
            ],
        )
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        ai = result[0]
        assert isinstance(ai, AIMessage)
        assert len(ai.tool_calls) == 1
        assert ai.tool_calls[0]["id"] == "tc1"
        assert ai.tool_calls[0]["name"] == "search"
        assert ai.tool_calls[0]["args"] == {"query": "weather"}

    def test_system_message(self):
        msg = AGUISystemMessage(id="s1", role="system", content="You are helpful")
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        assert isinstance(result[0], SystemMessage)
        assert result[0].content == "You are helpful"

    def test_tool_message(self):
        msg = AGUIToolMessage(id="t1", role="tool", content="42", tool_call_id="tc1")
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        assert isinstance(result[0], ToolMessage)
        assert result[0].content == "42"
        assert result[0].tool_call_id == "tc1"
        # A tool result with no error maps to LangChain's default "success" status.
        assert result[0].status == "success"

    def test_tool_message_name_round_trip(self):
        # LangChain routes tool results by ToolMessage.name; the AG-UI tool
        # message must carry the name in both conversion directions (#2530).
        lc = ToolMessage(content="42", tool_call_id="tc1", name="request_page_oncall")
        agui = langchain_messages_to_agui([lc])
        assert isinstance(agui[0], AGUIToolMessage)
        assert agui[0].name == "request_page_oncall"

        msg = AGUIToolMessage(
            id="t1",
            role="tool",
            content="42",
            tool_call_id="tc1",
            name="request_page_oncall",
        )
        result = agui_messages_to_langchain([msg])
        assert isinstance(result[0], ToolMessage)
        assert result[0].name == "request_page_oncall"

    def test_tool_message_error_maps_to_status(self):
        # A client-reported tool failure must reach the model as an error, not a
        # silent success -- AG-UI's ToolMessage.error becomes status="error".
        msg = AGUIToolMessage(
            id="t1",
            role="tool",
            content="Tool failed: invalid id",
            tool_call_id="tc1",
            error="invalid id",
        )
        result = agui_messages_to_langchain([msg])
        assert isinstance(result[0], ToolMessage)
        assert result[0].status == "error"

    def test_multimodal_with_url(self):
        msg = AGUIUserMessage(
            id="m1",
            role="user",
            content=[
                TextInputContent(type="text", text="What is this?"),
                BinaryInputContent(type="binary", mime_type="image/png", url="https://example.com/img.png"),
            ],
        )
        result = agui_messages_to_langchain([msg])
        assert isinstance(result[0], HumanMessage)
        content = result[0].content
        assert isinstance(content, list)
        assert content[0] == {"type": "text", "text": "What is this?"}
        assert content[1]["type"] == "image_url"
        assert content[1]["image_url"]["url"] == "https://example.com/img.png"

    def test_multimodal_with_base64(self):
        msg = AGUIUserMessage(
            id="m2",
            role="user",
            content=[
                BinaryInputContent(type="binary", mime_type="image/jpeg", data="abc123base64"),
            ],
        )
        result = agui_messages_to_langchain([msg])
        content = result[0].content
        assert isinstance(content, list)
        assert content[0]["image_url"]["url"] == "data:image/jpeg;base64,abc123base64"

    def test_unsupported_role_raises(self):
        # Create a message-like object with an unsupported role
        class FakeMsg:
            id = "x"
            role = "unknown"
            content = "test"
            name = None
        with pytest.raises(ValueError, match="Unsupported message role"):
            agui_messages_to_langchain([FakeMsg()])

    def test_multiple_messages_ordering(self):
        msgs = [
            AGUIUserMessage(id="1", role="user", content="Q"),
            AGUIAssistantMessage(id="2", role="assistant", content="A"),
            AGUIUserMessage(id="3", role="user", content="Q2"),
        ]
        result = agui_messages_to_langchain(msgs)
        assert len(result) == 3
        assert isinstance(result[0], HumanMessage)
        assert isinstance(result[1], AIMessage)
        assert isinstance(result[2], HumanMessage)

    def test_reasoning_messages_folded_into_assistant(self):
        # Reasoning belongs as a content block ON the assistant AIMessage at the
        # LangChain layer. It is not emitted as a standalone LangChain
        # message — that would duplicate context and can drive a tool-call loop —
        # but it must not be dropped either, or the model loses its
        # chain-of-thought on a stateless round-trip.
        msgs = [
            AGUIUserMessage(id="u1", role="user", content="Hi"),
            AGUIReasoningMessage(id="r1", role="reasoning", content="thinking..."),
            AGUIAssistantMessage(id="a1", role="assistant", content="Hello"),
        ]
        result = agui_messages_to_langchain(msgs)
        assert len(result) == 2
        assert isinstance(result[0], HumanMessage)
        assert isinstance(result[1], AIMessage)
        # Reasoning is folded onto the assistant, not dropped.
        reasoning_blocks = [
            b for b in result[1].content
            if isinstance(b, dict) and b.get("type") == "reasoning"
        ]
        assert len(reasoning_blocks) == 1
        assert reasoning_blocks[0]["id"] == "r1"

    def test_developer_messages_dropped(self):
        # Developer prompts are configured on the agent itself, not round-tripped.
        msgs = [
            AGUIDeveloperMessage(id="d1", role="developer", content="be concise"),
            AGUIUserMessage(id="u1", role="user", content="Hi"),
        ]
        result = agui_messages_to_langchain(msgs)
        assert len(result) == 1
        assert isinstance(result[0], HumanMessage)


class TestLangchainMessagesToAgui(unittest.TestCase):
    """Tests for langchain_messages_to_agui()."""

    def test_human_message(self):
        msg = HumanMessage(id="h1", content="Hello")
        result = langchain_messages_to_agui([msg])
        assert len(result) == 1
        assert result[0].role == "user"
        assert result[0].content == "Hello"
        assert result[0].id == "h1"

    def test_ai_message_plain(self):
        msg = AIMessage(id="a1", content="Response")
        result = langchain_messages_to_agui([msg])
        assert result[0].role == "assistant"
        assert result[0].content == "Response"

    def test_ai_message_with_tool_calls(self):
        msg = AIMessage(
            id="a2",
            content="",
            tool_calls=[
                {"id": "tc1", "name": "search", "args": {"q": "hello"}},
            ],
        )
        result = langchain_messages_to_agui([msg])
        assistant = result[0]
        assert assistant.role == "assistant"
        assert len(assistant.tool_calls) == 1
        tc = assistant.tool_calls[0]
        assert tc.id == "tc1"
        assert tc.function.name == "search"
        assert json.loads(tc.function.arguments) == {"q": "hello"}

    def test_system_message(self):
        msg = SystemMessage(id="s1", content="System prompt")
        result = langchain_messages_to_agui([msg])
        assert result[0].role == "system"
        assert result[0].content == "System prompt"

    def test_tool_message(self):
        msg = ToolMessage(id="t1", content="result", tool_call_id="tc1")
        result = langchain_messages_to_agui([msg])
        assert result[0].role == "tool"
        assert result[0].content == "result"
        assert result[0].tool_call_id == "tc1"
        # No error status carries no failure signal, so error stays unset.
        assert result[0].error is None

    def test_tool_message_error_status_maps_to_error(self):
        # The reverse of #2263: a LangChain tool result with status "error" must set
        # AG-UI's error so the failure survives the round trip. The value is a fixed
        # sentinel -- the original text is not recoverable from the flag alone (#2305).
        msg = ToolMessage(
            id="t1",
            content="Tool failed: invalid id",
            tool_call_id="tc1",
            status="error",
        )
        result = langchain_messages_to_agui([msg])
        assert result[0].role == "tool"
        assert result[0].error == "error"

    def test_multimodal_human_message(self):
        msg = HumanMessage(
            id="m1",
            content=[
                {"type": "text", "text": "Look at this"},
                {"type": "image_url", "image_url": {"url": "https://example.com/img.png"}},
            ],
        )
        result = langchain_messages_to_agui([msg])
        content = result[0].content
        assert isinstance(content, list)
        assert content[0].type == "text"
        assert content[0].text == "Look at this"
        assert content[1].type == "image"
        assert content[1].source.type == "url"
        assert content[1].source.value == "https://example.com/img.png"

    def test_multimodal_data_url_parsed(self):
        msg = HumanMessage(
            id="m2",
            content=[
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,abc123"}},
            ],
        )
        result = langchain_messages_to_agui([msg])
        content = result[0].content
        assert isinstance(content, list)
        assert content[0].type == "image"
        assert content[0].source.type == "data"
        assert content[0].source.mime_type == "image/jpeg"
        assert content[0].source.value == "abc123"

    def test_multimodal_plain_string_entry_preserved(self):
        msg = HumanMessage(
            id="m3",
            content=["hello", {"type": "text", "text": " world"}],
        )
        result = langchain_messages_to_agui([msg])
        content = result[0].content
        assert isinstance(content, list)
        assert len(content) == 2
        assert content[0].type == "text"
        assert content[0].text == "hello"
        assert content[1].type == "text"
        assert content[1].text == " world"


class TestRoundTrip(unittest.TestCase):
    """Tests that messages survive conversion in both directions."""

    def test_human_round_trip(self):
        original = AGUIUserMessage(id="rt1", role="user", content="Test message")
        lc = agui_messages_to_langchain([original])
        back = langchain_messages_to_agui(lc)
        assert back[0].role == "user"
        assert back[0].content == "Test message"
        assert back[0].id == "rt1"

    def test_assistant_with_tools_round_trip(self):
        original = AGUIAssistantMessage(
            id="rt2",
            role="assistant",
            content="",
            tool_calls=[
                AGUIToolCall(
                    id="tc1",
                    type="function",
                    function=AGUIFunctionCall(name="calc", arguments='{"x": 1}'),
                )
            ],
        )
        lc = agui_messages_to_langchain([original])
        back = langchain_messages_to_agui(lc)
        assert back[0].role == "assistant"
        assert len(back[0].tool_calls) == 1
        assert back[0].tool_calls[0].function.name == "calc"
        assert json.loads(back[0].tool_calls[0].function.arguments) == {"x": 1}

    def test_tool_message_round_trip(self):
        original = AGUIToolMessage(id="rt3", role="tool", content="done", tool_call_id="tc1")
        lc = agui_messages_to_langchain([original])
        back = langchain_messages_to_agui(lc)
        assert back[0].role == "tool"
        assert back[0].content == "done"
        assert back[0].tool_call_id == "tc1"


class TestNormalizeToolContent(unittest.TestCase):
    """Tests for normalize_tool_content()."""

    def test_string_passthrough(self):
        assert normalize_tool_content("hello") == "hello"

    def test_list_of_strings(self):
        assert normalize_tool_content(["a", "b"]) == "ab"

    def test_list_of_text_blocks(self):
        blocks = [{"type": "text", "text": "hello "}, {"type": "text", "text": "world"}]
        assert normalize_tool_content(blocks) == "hello world"

    def test_dict_serialized(self):
        result = normalize_tool_content({"key": "value"})
        assert json.loads(result) == {"key": "value"}

    def test_mixed_list(self):
        blocks = ["prefix", {"type": "text", "text": "content"}, {"type": "other", "data": 1}]
        result = normalize_tool_content(blocks)
        assert "prefix" in result
        assert "content" in result

    def test_empty_string(self):
        assert normalize_tool_content("") == ""

    def test_none_serialized(self):
        result = normalize_tool_content(None)
        assert result == "null"


class TestEdgeCases(unittest.TestCase):
    """Edge cases for conversion functions."""

    def test_empty_message_list(self):
        """Empty input → empty output, no exception."""
        assert agui_messages_to_langchain([]) == []
        assert langchain_messages_to_agui([]) == []

    def test_ai_message_with_list_content(self):
        """AI message with list content (text blocks) → text is extracted."""
        msg = AIMessage(id="a1", content=[{"type": "text", "text": "extracted"}])
        result = langchain_messages_to_agui([msg])
        assert result[0].content == "extracted"

    def test_ai_message_with_empty_content_string(self):
        """AI message with empty string content → empty string preserved."""
        msg = AIMessage(id="a2", content="")
        result = langchain_messages_to_agui([msg])
        assert result[0].content == ""

    def test_tool_message_with_list_content(self):
        """Tool message with list content → normalize_tool_content applied."""
        msg = ToolMessage(id="t1", content=[{"type": "text", "text": "ok"}], tool_call_id="tc1")
        result = langchain_messages_to_agui([msg])
        assert result[0].content == "ok"

    def test_human_message_name_preserved(self):
        """HumanMessage name field should be preserved in the AG-UI message."""
        msg = HumanMessage(id="h1", content="hi", name="alice")
        result = langchain_messages_to_agui([msg])
        assert result[0].name == "alice"

    def test_agui_assistant_message_no_tool_calls_converts(self):
        """AG-UI assistant message without tool_calls should produce an AIMessage with empty tool_calls."""
        msg = AGUIAssistantMessage(id="a3", role="assistant", content="plain text")
        result = agui_messages_to_langchain([msg])
        assert isinstance(result[0], AIMessage)
        assert result[0].tool_calls == []


class TestReasoningRoundTrip(unittest.TestCase):
    """Reasoning must survive AG-UI <-> LangChain conversion losslessly.

    An OpenAI reasoning model (Responses API) emits reasoning as a
    content block on the assistant AIMessage. AG-UI carries it as a separate
    ``role:"reasoning"`` message. Without a lossless converter pair, a stateless
    round-trip (no checkpoint to retain the block) drops the reasoning, so the
    model loses its own chain-of-thought on the next turn.
    """

    def test_reasoning_message_reattached_to_adjacent_assistant(self):
        """AG-UI -> LangChain: a reasoning message is folded into the following
        assistant AIMessage as a content block (not dropped, not a standalone
        message)."""
        msgs = [
            AGUIUserMessage(id="u1", role="user", content="Hi"),
            AGUIReasoningMessage(
                id="rs_abc", role="reasoning", content="step 1; step 2",
                encrypted_value="ENC123",
            ),
            AGUIAssistantMessage(id="a1", role="assistant", content="Hello"),
        ]
        result = agui_messages_to_langchain(msgs)

        # No standalone reasoning message — it's folded into the assistant.
        assert len(result) == 2
        assert isinstance(result[0], HumanMessage)
        assert isinstance(result[1], AIMessage)

        content = result[1].content
        assert isinstance(content, list), "assistant content should be a block list"
        reasoning_blocks = [
            b for b in content if isinstance(b, dict) and b.get("type") == "reasoning"
        ]
        assert len(reasoning_blocks) == 1
        rb = reasoning_blocks[0]
        assert rb["id"] == "rs_abc"
        assert rb.get("encrypted_content") == "ENC123"
        summary_text = " ".join(
            s.get("text", "") for s in rb.get("summary", []) if isinstance(s, dict)
        )
        assert "step 1" in summary_text
        # The assistant's own text is preserved alongside the reasoning block.
        text_blocks = [
            b for b in content
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text") == "Hello"
        ]
        assert len(text_blocks) == 1

    def test_ai_reasoning_block_emitted_as_reasoning_message(self):
        """LangChain -> AG-UI: a reasoning content block becomes a ReasoningMessage
        placed before the assistant message, carrying the block id + encrypted
        content so it is stable across snapshots."""
        msg = AIMessage(
            id="a1",
            content=[
                {
                    "type": "reasoning",
                    "id": "rs_abc",
                    "summary": [{"type": "summary_text", "text": "step 1; step 2"}],
                    "encrypted_content": "ENC123",
                },
                {"type": "text", "text": "Hello"},
            ],
        )
        result = langchain_messages_to_agui([msg])

        assert len(result) == 2
        reasoning, assistant = result[0], result[1]
        assert reasoning.role == "reasoning"
        assert reasoning.id == "rs_abc"
        assert reasoning.content == "step 1; step 2"
        assert reasoning.encrypted_value == "ENC123"
        assert assistant.role == "assistant"
        assert assistant.content == "Hello"

    def test_reasoning_block_with_only_id_is_preserved(self):
        """Real OpenAI Responses (store=True) persists the reasoning block as
        just an ``rs_`` id with empty summary/content. The id is the round-trip
        handle, so it must still be surfaced and re-attached."""
        msg = AIMessage(
            id="a1",
            content=[
                {"type": "reasoning", "id": "rs_only", "summary": [], "content": []},
                {"type": "text", "text": "Done."},
            ],
        )
        agui = langchain_messages_to_agui([msg])
        reasoning_msgs = [m for m in agui if m.role == "reasoning"]
        assert len(reasoning_msgs) == 1
        assert reasoning_msgs[0].id == "rs_only"

        back = agui_messages_to_langchain(agui)
        blocks = [
            b for b in back[0].content
            if isinstance(b, dict) and b.get("type") == "reasoning"
        ]
        assert len(blocks) == 1
        assert blocks[0]["id"] == "rs_only"

    def test_reasoning_round_trips_losslessly(self):
        """langchain -> agui -> langchain preserves the reasoning block id and
        encrypted content on the assistant AIMessage."""
        original = AIMessage(
            id="a1",
            content=[
                {
                    "type": "reasoning",
                    "id": "rs_abc",
                    "summary": [{"type": "summary_text", "text": "because X implies Y"}],
                    "encrypted_content": "ENC123",
                },
                {"type": "text", "text": "The answer is 42."},
            ],
        )
        agui = langchain_messages_to_agui([original])
        back = agui_messages_to_langchain(agui)

        assert len(back) == 1
        assert isinstance(back[0], AIMessage)
        reasoning_blocks = [
            b for b in back[0].content
            if isinstance(b, dict) and b.get("type") == "reasoning"
        ]
        assert len(reasoning_blocks) == 1
        assert reasoning_blocks[0]["id"] == "rs_abc"
        assert reasoning_blocks[0].get("encrypted_content") == "ENC123"
        # The summary text (the human-readable chain-of-thought) must survive too,
        # not just the id/encrypted handle.
        summary_text = "".join(
            s.get("text", "") for s in reasoning_blocks[0].get("summary", [])
            if isinstance(s, dict)
        )
        assert "because X implies Y" in summary_text
        # The assistant's own text block survives alongside the reasoning.
        assert any(
            isinstance(b, dict) and b.get("type") == "text"
            and b.get("text") == "The answer is 42."
            for b in back[0].content
        )

    def test_multipart_summary_text_survives_round_trip(self):
        """A reasoning block with multiple summary parts keeps every part's text
        on the round-trip (joined, not dropped)."""
        original = AIMessage(
            id="a1",
            content=[
                {
                    "type": "reasoning",
                    "id": "rs_multi",
                    "summary": [
                        {"type": "summary_text", "text": "first part"},
                        {"type": "summary_text", "text": "second part"},
                    ],
                },
                {"type": "text", "text": "Answer."},
            ],
        )
        back = agui_messages_to_langchain(langchain_messages_to_agui([original]))
        block = next(
            b for b in back[0].content
            if isinstance(b, dict) and b.get("type") == "reasoning"
        )
        text = "".join(
            s.get("text", "") for s in block.get("summary", []) if isinstance(s, dict)
        )
        assert "first part" in text
        assert "second part" in text

    def test_multiple_idless_reasoning_blocks_get_distinct_ids(self):
        """Two reasoning blocks on one message that lack a provider id must not
        collapse onto a single shared fallback id."""
        msg = AIMessage(
            id="a1",
            content=[
                {"type": "reasoning", "summary": [{"text": "alpha"}]},
                {"type": "reasoning", "summary": [{"text": "beta"}]},
                {"type": "text", "text": "Done."},
            ],
        )
        reasoning_msgs = [m for m in langchain_messages_to_agui([msg]) if m.role == "reasoning"]
        assert len(reasoning_msgs) == 2
        assert reasoning_msgs[0].id != reasoning_msgs[1].id

    def test_two_reasoning_blocks_fold_onto_one_assistant(self):
        """Two reasoning messages buffered before a single assistant both fold
        onto it (exercises multi-block accumulation, not just one)."""
        msgs = [
            AGUIReasoningMessage(id="rs_1", role="reasoning", content="first"),
            AGUIReasoningMessage(id="rs_2", role="reasoning", content="second"),
            AGUIAssistantMessage(id="a1", role="assistant", content="Hello"),
        ]
        result = agui_messages_to_langchain(msgs)
        assert len(result) == 1
        reasoning_ids = [
            b["id"] for b in result[0].content
            if isinstance(b, dict) and b.get("type") == "reasoning"
        ]
        assert reasoning_ids == ["rs_1", "rs_2"]

    def test_orphan_reasoning_without_following_assistant_is_dropped(self):
        """Reasoning not immediately followed by an assistant has no message to
        attach to; it is intentionally dropped rather than materialized as a
        standalone message (which would loop under add_messages). This locks in
        that deliberate behavior."""
        # Trailing reasoning (no following assistant).
        trailing = agui_messages_to_langchain([
            AGUIUserMessage(id="u1", role="user", content="Hi"),
            AGUIReasoningMessage(id="rs_x", role="reasoning", content="orphan"),
        ])
        assert [type(m).__name__ for m in trailing] == ["HumanMessage"]

        # Reasoning followed by a non-assistant message.
        followed_by_user = agui_messages_to_langchain([
            AGUIReasoningMessage(id="rs_y", role="reasoning", content="orphan"),
            AGUIUserMessage(id="u1", role="user", content="Hi"),
        ])
        assert [type(m).__name__ for m in followed_by_user] == ["HumanMessage"]

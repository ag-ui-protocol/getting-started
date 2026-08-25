"""Tests for resolve_reasoning_content and resolve_encrypted_reasoning_content.

Covers all supported AI provider formats including the Bedrock Converse API
fix for issue #1361.
"""
import unittest
import pytest

from ag_ui_langgraph.utils import resolve_reasoning_content, resolve_encrypted_reasoning_content


class FakeChunk:
    """Minimal mock for an AIMessageChunk with content and additional_kwargs."""

    def __init__(self, content=None, additional_kwargs=None):
        self.content = content or []
        self.additional_kwargs = additional_kwargs or {}


# ---------------------------------------------------------------------------
# resolve_reasoning_content
# ---------------------------------------------------------------------------
class TestResolveReasoningContent(unittest.TestCase):

    def test_anthropic_old_format_thinking(self):
        """Old langchain-anthropic: { type: "thinking", thinking: "..." }"""
        chunk = FakeChunk(content=[{"type": "thinking", "thinking": "Let me think..."}])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Let me think..."
        assert result["type"] == "text"
        assert result["index"] == 0

    def test_anthropic_old_format_with_signature(self):
        chunk = FakeChunk(content=[{
            "type": "thinking",
            "thinking": "Deep thought",
            "signature": "sig123",
            "index": 1,
        }])
        result = resolve_reasoning_content(chunk)
        assert result["text"] == "Deep thought"
        assert result["signature"] == "sig123"
        assert result["index"] == 1

    def test_langchain_new_format_reasoning(self):
        """New LangChain standardized: { type: "reasoning", reasoning: "..." }"""
        chunk = FakeChunk(content=[{"type": "reasoning", "reasoning": "Step 1..."}])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Step 1..."
        assert result["type"] == "text"

    def test_openai_responses_api_v1(self):
        """OpenAI Responses API: { type: "reasoning", summary: [{ text: "..." }] }"""
        chunk = FakeChunk(content=[{
            "type": "reasoning",
            "summary": [{"text": "Because X implies Y"}],
        }])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Because X implies Y"

    def test_openai_legacy_additional_kwargs(self):
        """OpenAI legacy via additional_kwargs.reasoning.summary."""
        chunk = FakeChunk(
            content=[],
            additional_kwargs={
                "reasoning": {
                    "summary": [{"text": "Legacy reasoning", "index": 2}],
                }
            },
        )
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "Legacy reasoning"
        assert result["index"] == 2

    def test_bedrock_converse_api_format(self):
        """Bedrock Converse API: { type: "reasoning_content", reasoning_content: { type: "text", text: "..." } }

        This is the fix for issue #1361: Bedrock format was silently dropped.
        """
        chunk = FakeChunk(content=[{
            "type": "reasoning_content",
            "reasoning_content": {"type": "text", "text": "Bedrock reasoning here"},
        }])
        result = resolve_reasoning_content(chunk)
        assert result is not None, "Bedrock Converse format should be handled (issue #1361)"
        assert result["text"] == "Bedrock reasoning here"
        assert result["type"] == "text"

    def test_bedrock_converse_with_index(self):
        chunk = FakeChunk(content=[{
            "type": "reasoning_content",
            "reasoning_content": {"type": "text", "text": "Step 2", "index": 3},
        }])
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["index"] == 3

    def test_empty_content_returns_none(self):
        chunk = FakeChunk(content=[])
        assert resolve_reasoning_content(chunk) is None

    def test_none_content_returns_none(self):
        chunk = FakeChunk(content=None)
        assert resolve_reasoning_content(chunk) is None

    def test_unknown_format_returns_none(self):
        chunk = FakeChunk(content=[{"type": "unknown", "data": "stuff"}])
        assert resolve_reasoning_content(chunk) is None

    def test_text_block_returns_none(self):
        """Normal text content blocks should not be treated as reasoning."""
        chunk = FakeChunk(content=[{"type": "text", "text": "Regular text"}])
        assert resolve_reasoning_content(chunk) is None

    def test_empty_thinking_returns_none(self):
        """Thinking block with empty string should return None."""
        chunk = FakeChunk(content=[{"type": "thinking", "thinking": ""}])
        assert resolve_reasoning_content(chunk) is None

    def test_empty_reasoning_returns_none(self):
        chunk = FakeChunk(content=[{"type": "reasoning", "reasoning": ""}])
        assert resolve_reasoning_content(chunk) is None

    def test_reasoning_content_inner_not_dict_returns_none(self):
        """Bedrock block present but inner value is not a dict — should not crash."""
        chunk = FakeChunk(content=[{
            "type": "reasoning_content",
            "reasoning_content": "not-a-dict",
        }])
        assert resolve_reasoning_content(chunk) is None

    def test_reasoning_content_inner_missing_text_returns_none(self):
        """Bedrock inner dict present but no text key — should return None."""
        chunk = FakeChunk(content=[{
            "type": "reasoning_content",
            "reasoning_content": {"type": "text"},
        }])
        assert resolve_reasoning_content(chunk) is None

    def test_thinking_block_missing_thinking_key_returns_none(self):
        """Thinking block with type but no thinking key — should return None."""
        chunk = FakeChunk(content=[{"type": "thinking"}])
        assert resolve_reasoning_content(chunk) is None

    def test_openai_summary_empty_list_returns_none(self):
        """OpenAI Responses API format with empty summary list should return None."""
        chunk = FakeChunk(content=[{"type": "reasoning", "summary": []}])
        assert resolve_reasoning_content(chunk) is None

    def test_additional_kwargs_empty_summary_returns_none(self):
        """OpenAI legacy format with empty summary list should return None."""
        chunk = FakeChunk(
            content=[],
            additional_kwargs={"reasoning": {"summary": []}},
        )
        assert resolve_reasoning_content(chunk) is None

    def test_additional_kwargs_summary_entry_without_text_returns_none(self):
        """OpenAI legacy summary entry with no text key should return None."""
        chunk = FakeChunk(
            content=[],
            additional_kwargs={"reasoning": {"summary": [{"index": 0}]}},
        )
        assert resolve_reasoning_content(chunk) is None

    # DeepSeek / Qwen / xAI: additional_kwargs.reasoning_content as a plain string
    def test_deepseek_reasoning_content_string(self):
        """additional_kwargs.reasoning_content string should return reasoning at index 0."""
        chunk = FakeChunk(
            content=[],
            additional_kwargs={"reasoning_content": "thinking step by step"},
        )
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["type"] == "text"
        assert result["text"] == "thinking step by step"
        assert result["index"] == 0

    def test_deepseek_reasoning_content_empty_string_returns_none(self):
        """Empty reasoning_content string should return None (no false positive)."""
        chunk = FakeChunk(
            content=[],
            additional_kwargs={"reasoning_content": ""},
        )
        assert resolve_reasoning_content(chunk) is None

    def test_deepseek_reasoning_content_non_string_returns_none(self):
        """Non-string reasoning_content in additional_kwargs should return None."""
        chunk = FakeChunk(
            content=[],
            additional_kwargs={"reasoning_content": {"unexpected": "dict"}},
        )
        assert resolve_reasoning_content(chunk) is None

    def test_content_block_takes_priority_over_additional_kwargs(self):
        """A valid content reasoning block wins over additional_kwargs.reasoning_content."""
        chunk = FakeChunk(
            content=[{"type": "thinking", "thinking": "from content block"}],
            additional_kwargs={"reasoning_content": "from additional_kwargs"},
        )
        result = resolve_reasoning_content(chunk)
        assert result is not None
        assert result["text"] == "from content block"


# ---------------------------------------------------------------------------
# resolve_encrypted_reasoning_content
# ---------------------------------------------------------------------------
class TestResolveEncryptedReasoningContent(unittest.TestCase):

    def test_redacted_thinking_block(self):
        chunk = FakeChunk(content=[{"type": "redacted_thinking", "data": "encrypted_data_here"}])
        result = resolve_encrypted_reasoning_content(chunk)
        assert result == "encrypted_data_here"

    def test_no_redacted_thinking(self):
        chunk = FakeChunk(content=[{"type": "thinking", "thinking": "visible"}])
        assert resolve_encrypted_reasoning_content(chunk) is None

    def test_empty_content(self):
        chunk = FakeChunk(content=[])
        assert resolve_encrypted_reasoning_content(chunk) is None

    def test_none_chunk(self):
        assert resolve_encrypted_reasoning_content(None) is None

    def test_redacted_without_data(self):
        chunk = FakeChunk(content=[{"type": "redacted_thinking"}])
        assert resolve_encrypted_reasoning_content(chunk) is None

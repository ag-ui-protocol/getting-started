"""Unit tests for the pure helper utilities in ag_ui_claude_sdk.utils.

These functions carry the load-bearing translation logic (tool-name
normalisation, surrogate repair, message/state shaping) and have no external
dependencies, so they are tested directly with plain data.
"""

import json
from collections.abc import AsyncIterable

import pytest

from ag_ui.core import RunAgentInput, AssistantMessage as AguiAssistantMessage
from ag_ui_claude_sdk.config import (
    STATE_MANAGEMENT_TOOL_NAME,
    STATE_MANAGEMENT_TOOL_FULL_NAME,
)
from ag_ui_claude_sdk.utils import (
    fix_surrogates,
    fix_surrogates_deep,
    extract_tool_names,
    strip_mcp_prefix,
    process_messages,
    build_state_context_addendum,
    apply_forwarded_props,
    _is_state_management_tool,
    build_agui_assistant_message,
    build_agui_tool_message,
)


class TestStripMcpPrefix:
    def test_strips_server_prefix(self):
        assert strip_mcp_prefix("mcp__weather__get_weather") == "get_weather"

    def test_strips_ag_ui_prefix(self):
        assert strip_mcp_prefix("mcp__ag_ui__generate_haiku") == "generate_haiku"

    def test_unprefixed_unchanged(self):
        assert strip_mcp_prefix("local_tool") == "local_tool"

    def test_preserves_double_underscore_in_tool_name(self):
        # mcp__server__tool__with__underscores -> tool__with__underscores
        assert strip_mcp_prefix("mcp__srv__a__b") == "a__b"

    def test_too_few_parts_unchanged(self):
        assert strip_mcp_prefix("mcp__only") == "mcp__only"


class TestExtractToolNames:
    def test_dict_tools(self):
        tools = [{"name": "a"}, {"name": "b"}]
        assert extract_tool_names(tools) == ["a", "b"]

    def test_object_tools(self):
        class T:
            def __init__(self, name):
                self.name = name

        assert extract_tool_names([T("x"), T("y")]) == ["x", "y"]

    def test_skips_nameless(self):
        assert extract_tool_names([{"description": "no name"}, {"name": "ok"}]) == ["ok"]

    def test_empty(self):
        assert extract_tool_names([]) == []


class TestFixSurrogates:
    def test_plain_text_unchanged(self):
        assert fix_surrogates("hello world") == "hello world"

    def test_reassembles_surrogate_pair(self):
        # U+1F35D (🍝) as a *split* UTF-16 surrogate pair: a high surrogate
        # (U+D83C) followed by a low surrogate (U+DF5D). This is the genuinely
        # broken shape produced when a JS String.slice() splits the codepoint.
        # A normal "🍝" literal carries no surrogates and would not exercise
        # the repair path at all.
        broken = "\ud83c\udf5d"
        assert "\ud83c" in broken and "\udf5d" in broken  # sanity: lone surrogates present
        fixed = fix_surrogates(broken)
        # Reassembled into the single real codepoint U+1F35D.
        assert fixed == chr(0x1F35D)
        assert fixed == "🍝"
        # Round-trips to valid UTF-8 (the original `broken` cannot).
        assert fixed.encode("utf-8").decode("utf-8") == "🍝"

    def test_lone_surrogate_uses_fallback(self):
        # An *unpaired* high surrogate cannot be reassembled into a valid
        # codepoint, so the "surrogatepass" round-trip succeeds in re-creating
        # the same lone surrogate; the result must still be UTF-8 encodable
        # without raising (Pydantic-serialisable). We assert the function
        # returns a string and that string encodes cleanly to UTF-8.
        broken = "a\ud83cb"  # lone high surrogate between two ASCII chars
        assert "\ud83c" in broken
        fixed = fix_surrogates(broken)
        assert isinstance(fixed, str)
        # Must not raise — the whole point of the repair is UTF-8 safety.
        fixed.encode("utf-8")

    def test_deep_fixes_nested_structure(self):
        broken = "\ud83c\udf5d"  # split surrogate pair for U+1F35D
        data = {"a": broken, "b": [broken, {"c": broken}]}
        fixed = fix_surrogates_deep(data)
        assert fixed["a"] == "🍝"
        assert fixed["b"][0] == "🍝"
        assert fixed["b"][1]["c"] == "🍝"

    def test_deep_preserves_non_strings(self):
        data = {"n": 1, "f": 1.5, "b": True, "none": None}
        assert fix_surrogates_deep(data) == data


class TestIsStateManagementTool:
    def test_short_name(self):
        assert _is_state_management_tool(STATE_MANAGEMENT_TOOL_NAME) is True

    def test_full_prefixed_name(self):
        assert _is_state_management_tool(STATE_MANAGEMENT_TOOL_FULL_NAME) is True

    def test_other_tool(self):
        assert _is_state_management_tool("get_weather") is False


class TestProcessMessages:
    @staticmethod
    async def _only_sdk_message(prompt):
        assert isinstance(prompt, AsyncIterable)
        messages = [message async for message in prompt]
        assert len(messages) == 1
        return messages[0]

    def test_extracts_last_user_message(self, make_input):
        inp = make_input(
            messages=[
                {"id": "1", "role": "user", "content": "first"},
                {"id": "2", "role": "user", "content": "latest"},
            ]
        )
        user_msg, pending = process_messages(inp)
        assert user_msg == "latest"
        assert pending is False

    def test_detects_pending_tool_result(self, make_input):
        from ag_ui.core import ToolMessage

        inp = make_input(
            messages=[
                ToolMessage(id="t1", role="tool", content="result", tool_call_id="tc1"),
            ]
        )
        user_msg, pending = process_messages(inp)
        assert pending is True

    def test_empty_messages(self, make_input):
        inp = make_input(messages=[])
        user_msg, pending = process_messages(inp)
        assert user_msg == ""
        assert pending is False

    def test_skips_empty_text_blocks(self, make_input):
        inp = make_input(
            messages=[
                {
                    "id": "1",
                    "role": "user",
                    "content": [
                        {"type": "text", "text": ""},
                        {"type": "text", "text": "   "},
                    ],
                }
            ]
        )
        user_msg, pending = process_messages(inp)
        assert user_msg == ""
        assert pending is False

    @pytest.mark.asyncio
    async def test_preserves_ordered_text_image_and_pdf(self, make_input):
        inp = make_input(
            thread_id="multimodal-thread",
            messages=[
                {
                    "id": "1",
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "describe these"},
                        {
                            "type": "image",
                            "source": {
                                "type": "data",
                                "value": "aW1hZ2U=",
                                "mime_type": "image/png",
                            },
                        },
                        {"type": "text", "text": "then read this"},
                        {
                            "type": "document",
                            "source": {
                                "type": "data",
                                "value": "cGRm",
                                "mime_type": "application/pdf",
                            },
                        },
                    ],
                }
            ],
        )

        prompt, pending = process_messages(inp)
        message = await self._only_sdk_message(prompt)

        assert pending is False
        assert message == {
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe these"},
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": "aW1hZ2U=",
                        },
                    },
                    {"type": "text", "text": "then read this"},
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": "cGRm",
                        },
                    },
                ],
            },
            "parent_tool_use_id": None,
            "session_id": "multimodal-thread",
        }

    @pytest.mark.asyncio
    async def test_maps_supported_remote_image_and_pdf_urls(self, make_input):
        inp = make_input(
            messages=[
                {
                    "id": "1",
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "url", "value": "https://example.com/image.png"},
                        },
                        {
                            "type": "document",
                            "source": {
                                "type": "url",
                                "value": "https://example.com/file.pdf",
                                "mime_type": "application/pdf",
                            },
                        },
                    ],
                }
            ]
        )

        prompt, _ = process_messages(inp)
        message = await self._only_sdk_message(prompt)

        assert message["message"]["content"] == [
            {
                "type": "image",
                "source": {"type": "url", "url": "https://example.com/image.png"},
            },
            {
                "type": "document",
                "source": {"type": "url", "url": "https://example.com/file.pdf"},
            },
        ]

    @pytest.mark.parametrize("content_type", ["audio", "video"])
    def test_rejects_unsupported_media_instead_of_dropping_it(
        self, make_input, content_type
    ):
        inp = make_input(
            messages=[
                {
                    "id": "1",
                    "role": "user",
                    "content": [
                        {
                            "type": content_type,
                            "source": {
                                "type": "data",
                                "value": "Ynl0ZXM=",
                                "mime_type": f"{content_type}/mp4",
                            },
                        }
                    ],
                }
            ]
        )

        with pytest.raises(ValueError, match=f"type {content_type} is not supported"):
            process_messages(inp)

    def test_rejects_opaque_binary_id_instead_of_dropping_it(self, make_input):
        inp = make_input(
            messages=[
                {
                    "id": "1",
                    "role": "user",
                    "content": [
                        {
                            "type": "binary",
                            "mime_type": "image/png",
                            "id": "file-123",
                        }
                    ],
                }
            ]
        )

        with pytest.raises(ValueError, match="opaque file id"):
            process_messages(inp)


class TestBuildStateContextAddendum:
    def test_empty_when_nothing(self, make_input):
        inp = make_input()
        assert build_state_context_addendum(inp) == ""

    def test_includes_state_json(self, make_input):
        inp = make_input(state={"count": 3})
        addendum = build_state_context_addendum(inp)
        assert "Current Shared State" in addendum
        assert "ag_ui_update_state" in addendum
        assert '"count": 3' in addendum

    def test_includes_context(self, make_input):
        from ag_ui.core import Context

        inp = make_input(context=[Context(description="page", value="/home")])
        addendum = build_state_context_addendum(inp)
        assert "Context from the application" in addendum
        assert "page" in addendum
        assert "/home" in addendum


class TestApplyForwardedProps:
    def test_applies_whitelisted_key(self):
        result = apply_forwarded_props({"model": "claude-x"}, {}, {"model"})
        assert result["model"] == "claude-x"

    def test_ignores_non_whitelisted(self):
        result = apply_forwarded_props({"evil": "x"}, {}, {"model"})
        assert "evil" not in result

    def test_ignores_none_value(self):
        result = apply_forwarded_props({"model": None}, {}, {"model"})
        assert "model" not in result

    def test_non_dict_returns_unchanged(self):
        base = {"a": 1}
        assert apply_forwarded_props(None, base, {"model"}) is base


class _Block:
    """A content block exposing the ``.type`` attribute that
    build_agui_assistant_message keys off of."""

    def __init__(self, type, **kw):
        self.type = type
        for k, v in kw.items():
            setattr(self, k, v)


class TestBuildAguiAssistantMessage:
    def test_text_only(self):
        class Msg:
            content = [_Block("text", text="Hello")]

        msg = build_agui_assistant_message(Msg(), "m1")
        assert msg is not None
        assert msg.content == "Hello"
        assert msg.id == "m1"
        assert msg.tool_calls is None

    def test_tool_use_block(self):
        class Msg:
            content = [_Block("tool_use", id="tc1", name="mcp__ag_ui__search", input={"q": "x"})]

        msg = build_agui_assistant_message(Msg(), "m2")
        assert msg is not None
        assert msg.tool_calls is not None
        assert len(msg.tool_calls) == 1
        # MCP prefix stripped for client matching
        assert msg.tool_calls[0].function.name == "search"
        assert json.loads(msg.tool_calls[0].function.arguments) == {"q": "x"}

    def test_skips_state_management_tool(self):
        class Msg:
            content = [
                _Block(
                    "tool_use",
                    id="tc1",
                    name=STATE_MANAGEMENT_TOOL_FULL_NAME,
                    input={"state_updates": {"x": 1}},
                )
            ]

        # Only the internal state tool -> nothing user-visible -> None
        assert build_agui_assistant_message(Msg(), "m3") is None

    def test_reasoning_only_returns_none(self):
        class Msg:
            content = []

        assert build_agui_assistant_message(Msg(), "m4") is None

    def test_real_sdk_blocks_build_assistant_message(self):
        """Real Claude SDK TextBlock/ToolUseBlock build a proper message.

        The real Claude SDK ``TextBlock``/``ToolUseBlock`` dataclasses do NOT
        expose a ``.type`` attribute. build_agui_assistant_message now
        dispatches via ``isinstance`` against the real SDK block classes, so a
        genuine ``TextBlock`` produces a populated AG-UI assistant message
        instead of being silently dropped.
        """
        from claude_agent_sdk.types import TextBlock, ToolUseBlock

        class Msg:
            content = [
                TextBlock(text="Hello"),
                ToolUseBlock(id="tc1", name="mcp__ag_ui__search", input={"q": "x"}),
            ]

        msg = build_agui_assistant_message(Msg(), "m5")
        assert msg is not None
        assert msg.content == "Hello"
        assert msg.id == "m5"
        assert msg.tool_calls is not None
        assert len(msg.tool_calls) == 1
        assert msg.tool_calls[0].function.name == "search"
        assert json.loads(msg.tool_calls[0].function.arguments) == {"q": "x"}


class TestBuildAguiToolMessage:
    def test_extracts_text_block_json(self):
        content = [{"type": "text", "text": '{"temp": 72}'}]
        msg = build_agui_tool_message("tc1", content)
        assert msg.role == "tool"
        assert msg.tool_call_id == "tc1"
        assert msg.id == "tc1-result"
        assert json.loads(msg.content) == {"temp": 72}

    def test_plain_text_passthrough(self):
        content = [{"type": "text", "text": "not json"}]
        msg = build_agui_tool_message("tc1", content)
        assert msg.content == "not json"

    def test_none_content(self):
        msg = build_agui_tool_message("tc1", None)
        assert msg.content == ""

    def test_bare_string_not_double_quoted(self):
        # A bare-string (non-JSON) result must be passed through unquoted, NOT
        # json.dumps-quoted into '"plain"'. (Item 5 encoding symmetry)
        msg = build_agui_tool_message("tc1", "plain")
        assert msg.content == "plain"

    def test_bare_string_matches_list_text_block(self):
        # The MESSAGES_SNAPSHOT builder must encode a logical tool result the
        # SAME way regardless of whether the SDK delivered it as a bare string
        # or as a list of text blocks — mirroring the TOOL_CALL_RESULT path's
        # canonical normalization (Item 5). Otherwise the same result renders
        # differently depending on transport shape.
        for raw in ("not json", '{"temp": 72}', "[1, 2, 3]", "42"):
            bare = build_agui_tool_message("tc1", raw)
            listed = build_agui_tool_message(
                "tc1", [{"type": "text", "text": raw}]
            )
            assert bare.content == listed.content, (
                f"asymmetric encoding for {raw!r}: "
                f"bare={bare.content!r} list={listed.content!r}"
            )

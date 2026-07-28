"""
Tests for AGUIToOpenAITranslator's multimodal content mapping.

Pins the wire shape each ``translate_*_content`` method produces (or the
``None``/drop behavior when unsupported), and validates the final input against
the OpenAI Agents SDK types. No network or model is used.
"""

from __future__ import annotations

import warnings
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from ag_ui.core import (
    AudioInputContent,
    BinaryInputContent,
    DocumentInputContent,
    ImageInputContent,
    InputContentDataSource,
    InputContentUrlSource,
    RunAgentInput,
    TextInputContent,
    UserMessage,
    VideoInputContent,
)
from ag_ui_openai_agents import AGUITranslator
from ag_ui_openai_agents.engine.agui_to_openai import AGUIToOpenAITranslator
from ag_ui_openai_agents.engine.types import TranslatedInput

_engine = AGUIToOpenAITranslator()


def _binary(**kwargs) -> BinaryInputContent:
    """BinaryInputContent is deprecated but still a real inbound shape callers
    may send; construct it without polluting test output with the warning."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        return BinaryInputContent(**kwargs)


# ── image ──────────────────────────────────────────────────────────────


def test_image_url_source_passes_through():
    part = ImageInputContent(source=InputContentUrlSource(value="https://x/y.png"))
    out = _engine.translate_image_content(part)
    assert out == {
        "type": "input_image",
        "image_url": "https://x/y.png",
        "detail": "auto",
    }


def test_image_data_source_becomes_data_url():
    part = ImageInputContent(
        source=InputContentDataSource(value="Zm9v", mime_type="image/png")
    )
    out = _engine.translate_image_content(part)
    assert out == {
        "type": "input_image",
        "image_url": "data:image/png;base64,Zm9v",
        "detail": "auto",
    }


def test_image_with_no_usable_source_returns_none():
    part = ImageInputContent(source=InputContentDataSource(value="", mime_type="image/png"))
    assert _engine.translate_image_content(part) is None


# ── audio ──────────────────────────────────────────────────────────────


def test_audio_data_source_maps_to_input_audio():
    part = AudioInputContent(
        source=InputContentDataSource(value="Zm9v", mime_type="audio/wav")
    )
    out = _engine.translate_audio_content(part)
    assert out == {
        "type": "input_audio",
        "input_audio": {"data": "Zm9v", "format": "wav"},
    }


def test_audio_url_source_is_dropped():
    # Responses API accepts no URL form for audio input.
    part = AudioInputContent(source=InputContentUrlSource(value="https://x/y.wav"))
    assert _engine.translate_audio_content(part) is None


def test_audio_missing_mime_defaults_to_wav():
    part = AudioInputContent(source=InputContentDataSource(value="Zm9v", mime_type=""))
    out = _engine.translate_audio_content(part)
    assert out["input_audio"]["format"] == "wav"


def test_audio_format_from_mime_variants():
    fmt = _engine._audio_format_from_mime
    assert fmt("audio/mpeg") == "mp3"
    assert fmt("audio/mp3") == "mp3"
    assert fmt("audio/mpeg3") == "mp3"
    assert fmt("audio/x-wav") == "wav"
    assert fmt("audio/wav") == "wav"
    assert fmt("audio/wave") == "wav"
    assert fmt(None) == "wav"
    # Content types carrying parameters must still match (params stripped).
    assert fmt("audio/wav; codecs=1") == "wav"
    assert fmt("audio/mpeg; rate=16000") == "mp3"
    # Chat Completions only takes wav/mp3 — anything else must map to None
    # so the caller drops the part instead of sending a rejectable request.
    assert fmt("audio/ogg") is None
    assert fmt("audio/flac") is None


def test_audio_unsupported_format_is_dropped():
    part = AudioInputContent(
        source=InputContentDataSource(value="Zm9v", mime_type="audio/ogg")
    )
    assert _engine.translate_audio_content(part) is None


# ── document ───────────────────────────────────────────────────────────


def test_document_url_source_uses_file_url():
    part = DocumentInputContent(source=InputContentUrlSource(value="https://x/y.pdf"))
    out = _engine.translate_document_content(part)
    assert out == {"type": "input_file", "file_url": "https://x/y.pdf"}


def test_document_data_source_uses_file_data():
    part = DocumentInputContent(
        source=InputContentDataSource(value="Zm9v", mime_type="application/pdf")
    )
    out = _engine.translate_document_content(part)
    assert out == {
        "type": "input_file",
        "filename": "document.pdf",
        "file_data": "data:application/pdf;base64,Zm9v",
    }


def test_document_with_no_usable_value_returns_none():
    part = DocumentInputContent(
        source=InputContentDataSource(value="", mime_type="application/pdf")
    )
    assert _engine.translate_document_content(part) is None


# ── video (unsupported by the Responses API) ─────────────────────────────


def test_video_is_always_dropped():
    part = VideoInputContent(source=InputContentUrlSource(value="https://x/y.mp4"))
    assert _engine.translate_video_content(part) is None


# ── binary (mime-sniffed, routed to image/audio/file) ────────────────────


def test_binary_image_mime_routes_to_image_url():
    part = _binary(mime_type="image/png", url="https://x/y.png")
    out = _engine.translate_binary_content(part)
    assert out == {
        "type": "input_image",
        "image_url": "https://x/y.png",
        "detail": "auto",
    }


def test_binary_audio_mime_routes_to_input_audio():
    part = _binary(mime_type="audio/wav", data="Zm9v")
    out = _engine.translate_binary_content(part)
    assert out == {
        "type": "input_audio",
        "input_audio": {"data": "Zm9v", "format": "wav"},
    }


def test_binary_other_mime_routes_to_file():
    part = _binary(mime_type="application/pdf", data="Zm9v", filename="a.pdf")
    out = _engine.translate_binary_content(part)
    assert out == {
        "type": "input_file",
        "file_data": "data:application/pdf;base64,Zm9v",
        "filename": "a.pdf",
    }


def test_binary_as_image_prefers_url_over_data():
    part = _binary(mime_type="image/png", url="https://x/y.png", data="Zm9v")
    out = _engine._binary_as_image(part)
    assert out == {
        "type": "input_image",
        "image_url": "https://x/y.png",
        "detail": "auto",
    }


def test_binary_as_image_falls_back_to_data():
    part = _binary(mime_type="image/png", data="Zm9v")
    out = _engine._binary_as_image(part)
    assert out == {
        "type": "input_image",
        "image_url": "data:image/png;base64,Zm9v",
        "detail": "auto",
    }


def test_binary_as_image_with_neither_returns_none():
    part = _binary(mime_type="image/png", id="file-123")
    assert _engine._binary_as_image(part) is None


def test_binary_as_audio_without_data_is_dropped():
    # URL-only audio isn't accepted by the Responses API.
    part = _binary(mime_type="audio/wav", url="https://x/y.wav")
    assert _engine._binary_as_audio(part, "audio/wav") is None


def test_binary_as_audio_unsupported_format_is_dropped():
    part = _binary(mime_type="audio/ogg", data="Zm9v")
    assert _engine._binary_as_audio(part, "audio/ogg") is None


def test_binary_as_file_url_source():
    part = _binary(mime_type="application/pdf", url="https://x/y.pdf")
    out = _engine._binary_as_file(part, "application/pdf")
    assert out == {"type": "input_file", "file_url": "https://x/y.pdf"}


def test_binary_as_file_data_without_filename_synthesizes_one():
    # Base64 file_data requires a filename (Responses API); synthesize from mime.
    part = _binary(mime_type="application/pdf", data="Zm9v")
    out = _engine._binary_as_file(part, "application/pdf")
    assert out == {
        "type": "input_file",
        "filename": "file.pdf",
        "file_data": "data:application/pdf;base64,Zm9v",
    }


# ── source resolution helper ──────────────────────────────────────────────


def test_data_source_to_url_handles_url_data_and_none():
    fn = _engine._data_source_to_url
    assert fn(InputContentUrlSource(value="https://x/y.png")) == "https://x/y.png"
    assert (
        fn(InputContentDataSource(value="Zm9v", mime_type="image/png"))
        == "data:image/png;base64,Zm9v"
    )
    assert fn(None) is None


# ── dict-shaped fallback dispatch ─────────────────────────────────────────


def test_dispatch_dict_content_part_text():
    out = _engine._dispatch_dict_content_part({"type": "text", "text": "hi"})
    assert out == {"type": "input_text", "text": "hi"}


def test_dispatch_dict_content_part_image():
    out = _engine._dispatch_dict_content_part(
        {"type": "image", "source": {"type": "url", "value": "https://x/y.png"}}
    )
    assert out == {
        "type": "input_image",
        "image_url": "https://x/y.png",
        "detail": "auto",
    }


def test_dispatch_dict_content_part_unknown_type_returns_none():
    assert _engine._dispatch_dict_content_part({"type": "carrier_pigeon"}) is None


# ── translate_content_part tier-2 dispatcher ──────────────────────────────


def test_translate_content_part_dispatches_by_type():
    text = TextInputContent(text="hi")
    image = ImageInputContent(source=InputContentUrlSource(value="https://x/y.png"))
    assert _engine.translate_content_part(text) == {"type": "input_text", "text": "hi"}
    assert _engine.translate_content_part(image) == {
        "type": "input_image",
        "image_url": "https://x/y.png",
        "detail": "auto",
    }


# ── all-unsupported content: drop, never stringify ────────────────────────


def test_content_list_of_only_unsupported_parts_translates_to_empty():
    # A video-only message must come back empty — not fall through to the
    # stringify path and send the parts' repr to the model as input_text.
    parts = [VideoInputContent(source=InputContentUrlSource(value="https://x/y.mp4"))]
    assert _engine.translate_content(parts) == []


def test_user_message_with_only_unsupported_parts_is_dropped_whole():
    message = UserMessage(
        id="u1",
        role="user",
        content=[VideoInputContent(source=InputContentUrlSource(value="https://x/y.mp4"))],
    )
    assert _engine.translate_user_message(message) is None
    assert _engine.translate_message(message) == []


def test_user_message_with_invalid_image_and_text_keeps_only_text():
    message = UserMessage(
        id="u1",
        role="user",
        content=[
            TextInputContent(text="look"),
            ImageInputContent(
                source=InputContentDataSource(value="", mime_type="image/png")
            ),
        ],
    )
    item = _engine.translate_user_message(message)
    assert item["content"] == [{"type": "input_text", "text": "look"}]


# ── end-to-end: mixed multimodal user message ─────────────────────────────


def test_mixed_multimodal_parts_translate_to_matching_blocks():
    parts = [
        TextInputContent(text="what's this?"),
        ImageInputContent(source=InputContentUrlSource(value="https://x/y.png")),
        AudioInputContent(
            source=InputContentDataSource(value="Zm9v", mime_type="audio/mpeg")
        ),
        DocumentInputContent(source=InputContentUrlSource(value="https://x/y.pdf")),
        VideoInputContent(source=InputContentUrlSource(value="https://x/y.mp4")),
    ]
    blocks = [_engine.translate_content_part(p) for p in parts]
    assert blocks == [
        {"type": "input_text", "text": "what's this?"},
        {
            "type": "input_image",
            "image_url": "https://x/y.png",
            "detail": "auto",
        },
        {"type": "input_audio", "input_audio": {"data": "Zm9v", "format": "mp3"}},
        {"type": "input_file", "file_url": "https://x/y.pdf"},
        None,  # video: no Responses-API input block
    ]


def test_image_survives_translated_input_validation():
    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=[
            UserMessage(
                id="u1",
                role="user",
                content=[
                    ImageInputContent(
                        source=InputContentUrlSource(value="https://x/y.png")
                    )
                ],
            )
        ],
        tools=[],
        state={},
        context=[],
        forwarded_props=None,
    )

    translated = AGUITranslator().to_openai(run_input)

    assert translated.messages[0]["content"][0] == {
        "type": "input_image",
        "image_url": "https://x/y.png",
        "detail": "auto",
    }


def test_translated_input_skips_message_validation():
    # messages uses SkipValidation, so shapes that are not Responses input-item
    # members (e.g. a detail-less image, or an input_audio block) construct
    # without a ValidationError; the SDK validates what it consumes at run time.
    ti = TranslatedInput(
        thread_id="t1",
        run_id="r1",
        messages=[
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_image", "image_url": "https://x/y.png"}],
            }
        ],
        tools=[],
        state={},
        context=[],
        forwarded_props=None,
    )
    assert ti.messages[0]["content"][0] == {
        "type": "input_image",
        "image_url": "https://x/y.png",
    }


def test_audio_user_message_survives_to_openai():
    # input_audio is a Chat-Completions shape, not a Responses input-item member;
    # with SkipValidation an audio request translates instead of crashing.
    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=[
            UserMessage(
                id="u1",
                role="user",
                content=[
                    AudioInputContent(
                        source=InputContentDataSource(value="Zm9v", mime_type="audio/wav")
                    )
                ],
            )
        ],
        tools=[],
        state={},
        context=[],
        forwarded_props=None,
    )
    translated = AGUITranslator().to_openai(run_input)
    assert translated.messages[0]["content"][0] == {
        "type": "input_audio",
        "input_audio": {"data": "Zm9v", "format": "wav"},
    }


def test_reasoning_summary_survives_as_a_stable_list_through_to_openai():
    from ag_ui.core import ReasoningMessage

    run_input = RunAgentInput(
        thread_id="t1",
        run_id="r1",
        messages=[
            ReasoningMessage(
                id="rs", role="reasoning", content="because", encrypted_value="enc"
            )
        ],
        tools=[],
        state={},
        context=[],
        forwarded_props=None,
    )
    translated = AGUITranslator().to_openai(run_input)
    summary = translated.messages[0]["summary"]
    # A real list that survives multiple reads, not a one-shot ValidatorIterator.
    assert list(summary) == [{"type": "summary_text", "text": "because"}]
    assert list(summary) == [{"type": "summary_text", "text": "because"}]


# ── empty-content dropping ───────────────────────────────────────────────


def test_empty_string_user_message_is_dropped():
    # translate_content("") yields no parts, so translate_user_message returns
    # None and the turn is omitted rather than sent as an empty content part the
    # API rejects (matches the method's documented contract).
    assert _engine.translate_message(UserMessage(id="u1", role="user", content="")) == []


def test_empty_list_user_message_is_dropped():
    assert _engine.translate_message(UserMessage(id="u1", role="user", content=[])) == []


# ── defensive reads for newest RunAgentInput fields ──────────────────────


def test_translate_reads_resume_defensively_when_field_absent():
    # Older RunAgentInput versions lack `resume` (and `parent_run_id`). translate
    # must read them via getattr and not raise AttributeError.
    run_input = SimpleNamespace(
        thread_id="t1",
        run_id="r1",
        messages=[],
        tools=[],
        state=None,
        context=[],
        forwarded_props=None,
    )
    result = _engine.translate(run_input)
    assert result.resume is None
    assert result.parent_run_id is None
    assert result.thread_id == "t1"


# ── document data source carries a synthesized filename ──────────────────


def test_document_data_source_includes_synthesized_filename():
    # The Responses API requires a filename alongside base64 file_data.
    part = DocumentInputContent(
        source=InputContentDataSource(value="Zm9v", mime_type="application/pdf")
    )
    out = _engine.translate_document_content(part)
    assert out == {
        "type": "input_file",
        "filename": "document.pdf",
        "file_data": "data:application/pdf;base64,Zm9v",
    }


# ── inbound message-type translation ─────────────────────────────────────


def test_system_and_developer_messages_map_to_role_items():
    from ag_ui.core import DeveloperMessage, SystemMessage

    assert _engine.translate_message(
        SystemMessage(id="s1", role="system", content="be nice")
    ) == [{"type": "message", "role": "system", "content": [{"type": "input_text", "text": "be nice"}]}]
    assert _engine.translate_message(
        DeveloperMessage(id="d1", role="developer", content="dev note")
    ) == [{"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "dev note"}]}]


def test_assistant_message_maps_text_and_tool_calls_without_type_message():
    from ag_ui.core import AssistantMessage, FunctionCall, ToolCall

    msg = AssistantMessage(
        id="a1",
        role="assistant",
        content="hi",
        tool_calls=[
            ToolCall(id="call_1", type="function", function=FunctionCall(name="f", arguments='{"x":1}'))
        ],
    )
    items = _engine.translate_message(msg)
    # Prior assistant text stays an EasyInputMessageParam: NO type="message".
    assert items[0] == {"role": "assistant", "content": "hi"}
    assert "type" not in items[0]
    assert items[1] == {
        "type": "function_call",
        "call_id": "call_1",
        "name": "f",
        "arguments": '{"x":1}',
    }


def test_tool_message_surfaces_error_when_content_empty():
    from ag_ui.core import ToolMessage

    ok = _engine.translate_message(
        ToolMessage(id="t1", role="tool", tool_call_id="call_1", content="result")
    )
    assert ok[0]["output"] == "result"

    err = _engine.translate_message(
        ToolMessage(id="t2", role="tool", tool_call_id="call_2", content="", error="boom")
    )
    assert err[0] == {"type": "function_call_output", "call_id": "call_2", "output": "boom"}


def test_reasoning_message_replays_only_with_encrypted_value():
    from ag_ui.core import ReasoningMessage

    assert (
        _engine.translate_message(ReasoningMessage(id="r1", role="reasoning", content="thinking"))
        == []
    )
    items = _engine.translate_message(
        ReasoningMessage(id="r2", role="reasoning", content="sum", encrypted_value="enc")
    )
    assert items == [
        {
            "type": "reasoning",
            "id": "r2",
            "encrypted_content": "enc",
            "summary": [{"type": "summary_text", "text": "sum"}],
        }
    ]


def test_activity_message_is_dropped():
    from ag_ui.core import ActivityMessage

    assert _engine.translate_message(
        ActivityMessage(id="act1", role="activity", activity_type="typing", content={})
    ) == []


def test_translate_context_renders_nonempty_items():
    from ag_ui.core import Context

    rendered = _engine.translate_context(
        [
            Context(description="Language", value="German"),
            Context(description="", value=""),
        ]
    )
    assert rendered == "Language: German"


# ── CR4 fixes: filename synthesis, context filtering, reasoning summary ───


def test_translate_context_drops_items_missing_either_field():
    from ag_ui.core import Context

    rendered = _engine.translate_context(
        [
            Context(description="Language", value="German"),
            Context(description="LabelOnly", value=""),
            Context(description="", value="ValueOnly"),
        ]
    )
    assert rendered == "Language: German"


def test_reasoning_message_with_empty_content_omits_summary_entry():
    from ag_ui.core import ReasoningMessage

    items = _engine.translate_message(
        ReasoningMessage(id="r3", role="reasoning", content="", encrypted_value="enc")
    )
    assert items == [
        {"type": "reasoning", "id": "r3", "encrypted_content": "enc", "summary": []}
    ]

"""Unit tests for the tool-definition and text helpers."""

from types import SimpleNamespace

from ag_ui_claude_managed_agents import (
    BackendTool,
    custom_tool_from,
    normalize_tool_name,
)
from ag_ui_claude_managed_agents.constants import (
    SEARCH_RESULT_PREVIEW_CHARS,
    TOOL_DESCRIPTION_MAX_LENGTH,
)
from ag_ui_claude_managed_agents.text import (
    decode_entities,
    describe_tool_result,
    text_of,
)


def test_normalize_tool_name_keeps_valid_names():
    assert normalize_tool_name("show_chart") == "show_chart"
    assert normalize_tool_name("Get-Weather_2") == "Get-Weather_2"


def test_normalize_tool_name_replaces_invalid_characters_and_truncates():
    assert normalize_tool_name("search web!") == "search_web_"
    assert normalize_tool_name("x" * 200) == "x" * 128
    assert normalize_tool_name("") == "tool"


def test_custom_tool_from_builds_input_schema_and_default_description():
    tool = BackendTool(
        name="ping",
        description="",
        parameters={"properties": {"a": {"type": "string"}}},
        handler=lambda _i: "pong",
    )
    assert custom_tool_from(tool) == {
        "type": "custom",
        "name": "ping",
        "description": "Tool ping",
        "input_schema": {
            "type": "object",
            "properties": {"a": {"type": "string"}},
        },
    }


def test_custom_tool_from_handles_missing_parameters():
    tool = BackendTool(
        name="ping", description="Ping", parameters=None, handler=lambda _i: "pong"
    )  # type: ignore[arg-type]
    assert custom_tool_from(tool)["input_schema"] == {
        "type": "object",
        "properties": {},
    }


def test_text_of_joins_text_blocks_only():
    assert (
        text_of(
            [
                {"type": "text", "text": "a"},
                {"type": "image"},
                {"type": "text", "text": "b"},
            ]
        )
        == "ab"
    )
    assert text_of(None) == ""


def test_decode_entities_decodes_numeric_and_named_entities() -> None:
    assert (
        decode_entities("5 &lt; 6 &amp;&amp; &#x1F600; &#65; &quot;q&quot; &gt;")
        == '5 < 6 && \U0001f600 A "q" >'
    )


def test_decode_entities_matches_the_typescript_and_dotnet_ports() -> None:
    """Cases where the three ports could drift apart, asserted in all three."""
    # An uppercase hex marker is accepted (`&#[xX]`).
    assert decode_entities("&#X41;") == "A"
    # Non-ASCII digits are not numeric references. With `\d` (the whole Unicode
    # Nd category) this decoded to "A" in Python alone.
    assert decode_entities("&#\u0666\u0665;") == "&#\u0666\u0665;"
    # An absurdly long decimal folds to U+FFFD rather than raising ValueError out
    # of the turn: CPython refuses more than 4300 decimal digits.
    assert decode_entities("&#" + "1" * 5000 + ";") == "\ufffd"


def test_decode_entities_resolves_each_entity_exactly_once() -> None:
    """Regression: decoding numeric entities before named ones turned `&#38;lt;`
    into `&lt;` and then into `<`, discarding the escaping the source wrote."""
    assert decode_entities("&#38;lt;") == "&lt;"
    assert decode_entities("&#x26;lt;") == "&lt;"
    assert decode_entities("&amp;lt;") == "&lt;"
    assert decode_entities("&amp;amp;") == "&amp;"
    assert decode_entities("&#38;#60;") == "&#60;"


def test_decode_entities_leaves_unknown_and_malformed_entities_alone() -> None:
    assert (
        decode_entities("&nbsp; &copy; &#; &# 65; &lt")
        == "&nbsp; &copy; &#; &# 65; &lt"
    )


def test_describe_tool_result_summarizes_blocks_and_decodes_only_search_results():
    described = describe_tool_result(
        [
            {"type": "text", "text": "5 &lt; 6 &amp;&amp; &#x1F600; &#65;"},
            {
                "type": "search_result",
                "title": "T &amp; U",
                "source": "https://x",
                "content": [{"type": "text", "text": "a &lt; b"}],
            },
            {"type": "document"},
        ]
    )
    assert described == (
        "5 &lt; 6 &amp;&amp; &#x1F600; &#65;\n"
        "[search result] T & U — https://x\na < b\n[document]"
    )


def test_describe_tool_result_passes_literal_tool_output_through_verbatim() -> None:
    """A file read or shell transcript means `&lt;` literally; decoding it would
    corrupt the very output the user asked to see."""
    html = '<a href="x">&lt;div&gt;</a> &amp; more'
    assert describe_tool_result([{"type": "text", "text": html}]) == html


def test_decode_entities_substitutes_unusable_code_points() -> None:
    """A lone surrogate cannot be encoded as UTF-8, so `chr` would produce a
    string that raises inside SSE encoding rather than reach the UI. Every port
    substitutes U+FFFD here instead, identically."""
    assert decode_entities("a&#xD800;b") == "a�b"
    assert decode_entities("a&#55296;b") == "a�b"
    assert decode_entities("a&#xDFFF;b") == "a�b"
    # Out of range, and the boundaries around the surrogate block, still work.
    assert decode_entities("a&#x110000;b") == "a�b"
    assert decode_entities("a&#xD7FF;&#xE000;b") == "a\ud7ff\ue000b"
    # A well-formed astral character written as one code point is unaffected.
    assert decode_entities("&#x1F600;") == "\U0001f600"
    # The result is encodable, which is the point of the substitution.
    decode_entities("a&#xD800;b").encode("utf-8")


def test_custom_tool_from_normalizes_name_and_caps_description() -> None:
    """The API caps descriptions; a long one must be truncated, not rejected."""
    tool = custom_tool_from(
        SimpleNamespace(
            name="show chart!", description="d" * (TOOL_DESCRIPTION_MAX_LENGTH + 50), parameters=None
        )
    )
    assert tool["name"] == "show_chart_"
    assert len(tool["description"]) == TOOL_DESCRIPTION_MAX_LENGTH
    # The API accepts 1-4096; capping lower silently truncated valid descriptions.
    assert TOOL_DESCRIPTION_MAX_LENGTH == 4096
    kept = custom_tool_from(
        SimpleNamespace(name="ok", description="d" * 2000, parameters=None)
    )
    assert len(kept["description"]) == 2000


def test_describe_tool_result_previews_a_long_search_result_body() -> None:
    body = "x" * (SEARCH_RESULT_PREVIEW_CHARS + 200)
    out = describe_tool_result(
        [
            {
                "type": "search_result",
                "title": "Docs",
                "source": "https://example.com",
                "content": [{"type": "text", "text": body}],
            }
        ]
    )
    header, preview = out.split("\n", 1)
    assert "[search result] Docs" in header
    assert "https://example.com" in header
    # Only a readable prefix of the body is shown.
    assert preview == "x" * SEARCH_RESULT_PREVIEW_CHARS


def test_describe_tool_result_placeholders_unknown_blocks_and_handles_nothing() -> None:
    assert describe_tool_result([{"type": "image"}]) == "[image]"
    assert describe_tool_result([]) == ""
    assert describe_tool_result(None) == ""


ROUTE_SCHEMA = {
    "type": "object",
    "description": "A route",
    "additionalProperties": False,
    "properties": {
        "from": {"$ref": "#/$defs/point"},
        "to": {"$ref": "#/$defs/point"},
        "via": {"type": "array", "items": {"$ref": "#/$defs/point"}},
    },
    "required": ["from", "to"],
    "$defs": {
        "point": {
            "type": "object",
            "properties": {"x": {"type": "number"}, "y": {"type": "number"}},
            "required": ["x", "y"],
        }
    },
}


def test_custom_tool_from_preserves_a_nested_schema_with_reused_definitions() -> None:
    """Regression: only `properties` and `required` were copied, so `$defs`
    vanished and every `$ref` pointing into it became dangling."""
    tool = SimpleNamespace(name="route", description="Plot", parameters=ROUTE_SCHEMA)
    assert custom_tool_from(tool)["input_schema"] == ROUTE_SCHEMA


def test_custom_tool_from_preserves_composition_keywords_and_a_top_level_ref() -> None:
    any_of = {
        "type": "object",
        "anyOf": [{"required": ["a"]}, {"required": ["b"]}],
        "properties": {"a": {}, "b": {}},
    }
    assert (
        custom_tool_from(
            SimpleNamespace(name="either", description="d", parameters=any_of)
        )["input_schema"]
        == any_of
    )

    top_level_ref = {
        "$ref": "#/$defs/args",
        "$defs": {"args": {"type": "object", "properties": {"q": {"type": "string"}}}},
    }
    assert custom_tool_from(
        SimpleNamespace(name="ref", description="d", parameters=top_level_ref)
    )["input_schema"] == {
        **top_level_ref,
        # The API accepts object input schemas only, so `type` is asserted.
        "type": "object",
    }


def test_custom_tool_from_falls_back_for_a_non_object_parameters_value() -> None:
    for parameters in (None, "nope", 7, [1, 2]):
        tool = SimpleNamespace(name="ping", description="d", parameters=parameters)
        assert custom_tool_from(tool)["input_schema"] == {
            "type": "object",
            "properties": {},
        }

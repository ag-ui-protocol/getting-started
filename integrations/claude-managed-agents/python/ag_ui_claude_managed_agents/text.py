"""Helpers for turning Managed Agents content blocks into display text."""

import re
from collections.abc import Sequence
from typing import Any

from ._util import get
from .constants import SEARCH_RESULT_PREVIEW_CHARS

REPLACEMENT_CHARACTER = "�"
"""Substituted for any entity that does not denote a usable character."""

_NAMED_ENTITIES = {"quot": '"', "lt": "<", "gt": ">", "amp": "&"}

# `[0-9]`, not `\d`: in Python `\d` matches the whole Unicode Nd category, so
# `&#٦٥;` (Arabic-Indic digits) would decode to `A` here while the TypeScript and
# .NET ports -- whose `\d` is ASCII-only and whose pattern is literally `[0-9]` --
# leave it alone. HTML numeric references are ASCII digits only.
_ENTITY = re.compile(r"&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(quot|lt|gt|amp));")

# Beyond this many decimal digits a code point is necessarily out of range, and
# CPython refuses to convert a decimal string longer than 4300 digits at all.
_MAX_DECIMAL_DIGITS = 7
"""Numeric (hex or decimal) and the handful of named entities, in one alternation."""


def _code_point(n: int) -> str:
    """The character an entity's code point denotes, or U+FFFD.

    Surrogate code points (U+D800-U+DFFF) are rejected as well as out-of-range
    ones: `chr` happily produces a lone surrogate, but that string cannot be
    encoded as UTF-8, so it would raise inside SSE encoding rather than reach
    the UI. Substituting here keeps every port's output well-formed and
    identical.
    """
    if n < 0 or n > 0x10FFFF or 0xD800 <= n <= 0xDFFF:
        return REPLACEMENT_CHARACTER
    return chr(n)


def _decode_match(match: re.Match[str]) -> str:
    hex_digits, dec_digits, name = match.groups()
    if name is not None:
        return _NAMED_ENTITIES[name]
    if hex_digits is not None:
        # Base 16 is a power of two and exempt from CPython's str->int limit.
        return _code_point(int(hex_digits, 16))
    if len(dec_digits) > _MAX_DECIMAL_DIGITS:
        # `int()` raises ValueError past 4300 digits, which would escape
        # `describe_tool_result` and fail the whole run over a display string.
        # The other two ports fold an unparseable numeric into U+FFFD.
        return REPLACEMENT_CHARACTER
    return _code_point(int(dec_digits))


def decode_entities(s: str) -> str:
    """Decode numeric and the common named HTML entities in one pass.

    One pass matters: decoding numeric entities before named ones would rewrite
    `&#38;lt;` to `&lt;` and then to `<`, losing the escaping the source went to
    the trouble of writing. Each match is resolved exactly once, so `&#38;lt;`
    decodes to the literal `&lt;`.
    """
    return _ENTITY.sub(_decode_match, s)


def text_of(content: Sequence[Any] | None) -> str:
    """Concatenate the text of every `text` block."""
    parts: list[str] = []
    for block in content or []:
        text = get(block, "text")
        if get(block, "type") == "text" and isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def describe_tool_result(content: Sequence[Any] | None) -> str:
    """Flatten a tool result's blocks (text, search results, images, documents) into a string.

    `text` blocks are passed through verbatim. They carry literal tool output —
    a file read, a shell transcript — where `&lt;` means those four characters,
    so decoding them would corrupt the very output the user asked to see. Only
    `search_result` blocks, whose bodies are extracted from HTML, are decoded.
    """
    lines: list[str] = []
    for block in content or []:
        block_type = get(block, "type")
        text = get(block, "text")
        if block_type == "text" and isinstance(text, str):
            lines.append(text)
            continue
        if block_type == "search_result":
            inner_content = get(block, "content")
            inner = text_of(inner_content) if isinstance(inner_content, list) else ""
            title = decode_entities(str(get(block, "title") or ""))
            source = str(get(block, "source") or "")
            line = f"[search result] {title} — {source}"
            if inner:
                line += f"\n{decode_entities(inner)[:SEARCH_RESULT_PREVIEW_CHARS]}"
            lines.append(line)
            continue
        lines.append(f"[{block_type}]")
    return "\n".join(lines).strip()

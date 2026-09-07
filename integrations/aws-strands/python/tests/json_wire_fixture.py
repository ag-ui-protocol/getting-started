"""Canonical fixture for wire serialization normalized by ``dumps_wire``.

It covers nesting, non-ASCII and astral characters, forward slashes, and
control characters. Numeric formatting is intentionally excluded because it
remains Python-native.
"""

from __future__ import annotations

import json

PARITY_VALUE = {
    "note": "café 😀 a/b \u0007",
    "nested": {"items": [1, "é"]},
}

# What JSON.stringify(PARITY_VALUE) produces, character for character.
PARITY_JSON = '{"note":"café 😀 a/b \\u0007","nested":{"items":[1,"é"]}}'

# The padded, ASCII-escaped form a bare json.dumps produces. Used as input
# wherever a test needs a string the site under test has to re-serialize.
PARITY_JSON_PYTHON_DEFAULT = json.dumps(PARITY_VALUE)

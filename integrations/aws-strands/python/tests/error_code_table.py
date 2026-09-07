"""The shared ``error-codes.json`` table, read by this bridge's suites.

One table, two runtimes: ``../../error-codes.json`` holds the codes and the
message text for both bridges, and the TypeScript suite reads the same file
through ``src/__tests__/error-code-table.ts``. A terminal-path test drives the
real agent or endpoint to a failure and asserts the emitted frame against the
entry here, so a code the table marks shared carries the same text on both
sides because both sides are matched against this one copy of it.

Templates render every interpolated value as ``{}``. ``matches_template`` turns
one into a pattern so the literal text around the interpolations is compared
character for character, which is what a client matching literally depends on.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SIDE = "python"
TABLE_PATH = Path(__file__).resolve().parents[2] / "error-codes.json"
TABLE: dict[str, Any] = json.loads(TABLE_PATH.read_text(encoding="utf-8"))
CODES: dict[str, dict[str, Any]] = {entry["code"]: entry for entry in TABLE["codes"]}
FORCE_STOP_FALLBACK: str = TABLE["sharedMessageConstants"]["forceStopFallback"]


def templates_for(code: str) -> list[str]:
    """Every message text this side may emit under ``code``."""
    entry = CODES[code]
    side_only = entry.get("sideOnlyMessages", {}).get(SIDE, [])
    return list(entry["messages"]) + list(side_only)


def matches_template(template: str, message: str) -> bool:
    """Whether ``message`` is ``template`` with its ``{}`` slots filled in."""
    pattern = ".*".join(re.escape(part) for part in template.split("{}"))
    return re.fullmatch(pattern, message, re.DOTALL) is not None


def assert_contract_error(error: Any, code: str) -> None:
    """Assert a ``RunErrorEvent`` carries ``code`` and text the table allows."""
    assert error.code == code, f"expected {code}, got {error.code}: {error.message!r}"
    templates = templates_for(code)
    assert any(matches_template(template, error.message) for template in templates), (
        f"{code} emitted {error.message!r}, which matches none of the message "
        f"templates recorded for {SIDE} in error-codes.json: {templates!r}"
    )

"""The cross-runtime parity check for the shared error-code table.

Modelled on ``integrations/langgraph/cross-runtime-parity-cases.json``: one
table, read by both runtimes' suites, so a contract that has to hold on both
sides lives in one file rather than in two hand-mirrored lists. The TypeScript
half of this check is ``src/__tests__/error-code-table.test.ts``, and it makes
the same assertions over the same data.

What is checked here is the SHAPE of the contract, not either source. A code
listed on both sides carries one copy of its text, so the terminal-path suites
on the two sides are matched against the same string; a code listed on one side
has to say why. The last test is a literal-string backstop, and only in the
direction the table can support: a code named here must still appear in this
bridge's source. Nothing reads that source as code.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.error_code_table import CODES, SIDE, TABLE, matches_template

SIDES = {"python", "typescript"}

_SOURCES = [
    path.read_text(encoding="utf-8")
    for path in sorted(
        (Path(__file__).resolve().parents[1] / "src" / "ag_ui_strands").glob("*.py")
    )
]


@pytest.mark.parametrize("code", sorted(CODES))
def test_every_entry_names_at_least_one_known_side(code: str):
    sides = CODES[code]["sides"]
    assert sides, f"{code} names no side"
    assert set(sides) <= SIDES, f"{code} names an unknown side: {sides}"
    assert len(set(sides)) == len(sides), f"{code} repeats a side: {sides}"


@pytest.mark.parametrize("code", sorted(CODES))
def test_a_shared_code_carries_one_copy_of_its_text(code: str):
    """Both sides are matched against the same string, or the split is stated."""
    entry = CODES[code]
    if len(entry["sides"]) < 2:
        return
    if entry["messages"]:
        return
    side_only = entry.get("sideOnlyMessages", {})
    assert set(side_only) == set(entry["sides"]), (
        f"{code} is shared but has no shared text, and its sideOnlyMessages "
        f"does not cover every side it names"
    )
    assert entry.get("note"), f"{code} has no shared text and no note saying why"


@pytest.mark.parametrize("code", sorted(CODES))
def test_a_one_sided_code_states_its_reason(code: str):
    entry = CODES[code]
    if len(entry["sides"]) != 1:
        return
    assert entry.get("note"), f"{code} is one-sided with no reason recorded"


@pytest.mark.parametrize("code", sorted(CODES))
def test_side_only_text_names_a_side_the_code_has_and_states_its_reason(code: str):
    entry = CODES[code]
    side_only = entry.get("sideOnlyMessages")
    if not side_only:
        return
    assert set(side_only) <= set(entry["sides"]), (
        f"{code} records side-only text for a side it does not name"
    )
    assert all(texts for texts in side_only.values()), f"{code} has an empty side list"
    assert entry.get("note"), f"{code} has side-only text with no reason recorded"


def test_codes_are_listed_once_and_in_order():
    listed = [entry["code"] for entry in TABLE["codes"]]
    assert len(listed) == len(set(listed)), "a code is listed twice"
    assert listed == sorted(listed), "codes are not in alphabetical order"


def test_a_template_pattern_pins_the_text_around_its_slots():
    """The matcher the terminal-path suites use is not a wildcard."""
    assert matches_template("Interrupt '{}' has expired.", "Interrupt 'a' has expired.")
    assert not matches_template(
        "Interrupt '{}' has expired.", "Interrupt 'a' has expired"
    )
    assert not matches_template("Interrupt '{}' has expired.", "interrupt 'a' expired.")


def test_every_code_on_this_side_still_appears_in_the_source():
    """The backstop. A literal search, in the only direction data can support.

    A code named here for Python that no longer appears in ``ag_ui_strands``
    has been renamed or removed without the table following. The reverse, a
    code added to the source and never written down here, is not caught: see
    the error-code contract section of ``ARCHITECTURE.md``.
    """
    missing = [
        code
        for code, entry in CODES.items()
        if SIDE in entry["sides"]
        and not any(f'"{code}"' in source for source in _SOURCES)
    ]
    assert missing == [], f"named in error-codes.json but absent from source: {missing}"

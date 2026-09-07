"""The README's load-bearing claims, checked against the code.

Review of this package repeatedly found documentation that named a constant the
adapter does not emit, or a shape it does not produce. Prose drifts because
nothing reads it. These assertions read it, so the mechanically checkable claims
cannot drift silently again.

Deliberately narrow. A test can check that a named error code exists and that a
documented shape is the shape produced; it cannot check whether a sentence is
complete or whether a rationale still holds. Those stay with human review.
"""

from __future__ import annotations

import re
from pathlib import Path

from ag_ui_strands import INTERRUPT_CANCELLED

_ROOT = Path(__file__).resolve().parent.parent
README = (_ROOT / "README.md").read_text()
SOURCE = (_ROOT / "src" / "ag_ui_strands" / "agent.py").read_text()


def test_the_readme_never_names_a_near_miss_of_a_real_error_code():
    """The demonstrated failure was a near miss, not an invention.

    Review found the TypeScript README naming ``UNKNOWN_INTERRUPT`` where its
    adapter emits ``UNKNOWN_INTERRUPT_ID``. This README did not carry that
    mistake, but it names codes the same way and can drift the same way, so the
    signal to catch is a token that is a strict prefix of a real code. That
    stays precise: event names and environment variables here are nobody's
    prefix.
    """
    emitted = set(re.findall(r'code="([A-Z_]+)"', SOURCE))
    assert emitted, "no adapter error code found in the source to check against"

    named = set(re.findall(r"`([A-Z][A-Z_]{4,})`", README))
    near_misses = sorted(
        token
        for token in named - emitted
        if any(code != token and code.startswith(token) for code in emitted)
    )
    assert near_misses == [], (
        f"the README names near misses of real error codes: {near_misses}"
    )


def test_the_readme_documents_the_resume_contract_shapes_the_adapter_builds():
    for shape in ('{"response": payload}', '{"response": None}', '{"cancelled": True}'):
        assert shape in README, (
            f"the resume-contract table no longer documents {shape}"
        )


def test_the_readme_documents_the_cancellation_sentinel_it_exports():
    assert INTERRUPT_CANCELLED == {"cancelled": True}
    assert '`{"cancelled": True}`' in README, (
        "the README no longer states the cancellation shape it exports"
    )


def test_the_readme_documents_the_reserved_interrupt_name_prefix():
    prefix = "ag_ui:tool_call:"
    assert f'"{prefix}"' in SOURCE
    assert prefix in README, "the reserved name prefix is undocumented"


def test_the_readme_documents_every_approval_metadata_key_published():
    """Derived from the code, not from a list kept beside it.

    A hardcoded list is why this passed while a published key could be renamed
    or added without the README noticing.
    """
    from ag_ui_strands.agent import _approval_metadata

    published = set(
        _approval_metadata(
            "ag_ui:tool_call:x",
            "x",
            {},
            {"tool_name": "x", "tool_input": {}, "tool_use_id": "t"},
        )
    )
    assert published, "no approval metadata keys found to check"

    # Scoped to the passage that documents these keys, and matched as a code
    # span. A search of the whole README passes on any token that happens to
    # appear anywhere in it, which is how a rename to a word the prose already
    # uses would go unnoticed.
    anchor = README.find("always carries")
    assert anchor != -1, "the approval-metadata passage moved or was renamed"
    passage = README[anchor : README.index("\n\n", anchor)]

    undocumented = sorted(key for key in published if f"`{key}`" not in passage)
    assert undocumented == [], (
        f"the README does not document published approval metadata keys: {undocumented}"
    )

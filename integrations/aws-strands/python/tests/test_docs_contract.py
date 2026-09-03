"""The load-bearing claims of README.md, checked against the code.

Review of this package repeatedly found documentation that named a constant the
adapter does not emit, or a shape it does not produce. Prose drifts because
nothing reads it. These assertions read it, so the mechanically checkable claims
cannot drift silently again.

Deliberately narrow. A test can check that a named error code exists and that a
documented shape is the shape produced; it cannot check whether a sentence is
complete or whether a rationale still holds. Those stay with human review.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import ag_ui_strands
from ag_ui_strands import INTERRUPT_CANCELLED, __all__

_ROOT = Path(__file__).resolve().parent.parent
README = (_ROOT / "README.md").read_text()
SOURCE = (_ROOT / "src" / "ag_ui_strands" / "agent.py").read_text()

_PACKAGING_HEADING = "## Packaging surface"


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


def _packaging_surface_region() -> str:
    """The packaging-surface section of README.md, heading to next heading."""
    start = README.find(_PACKAGING_HEADING)
    assert start != -1, (
        f"the packaging-surface heading {_PACKAGING_HEADING!r} moved or was reworded"
    )
    end = README.find("\n## ", start + 1)
    return README[start:] if end == -1 else README[start:end]


def _packaging_surface_names() -> list[str]:
    """Every name listed in the grouped fence, in document order.

    The fence lines are either ``label<gap>Name / Name /`` or an indented
    continuation carrying bare names, so a label is whatever precedes the first
    run of two or more spaces on an unindented line.
    """
    region = _packaging_surface_region()
    fence = re.search(r"```\n(.*?)```", region, re.DOTALL)
    assert fence is not None, "the packaging-surface group listing is no longer fenced"

    names: list[str] = []
    for line in fence.group(1).splitlines():
        if not line.strip():
            continue
        if line[0].isspace():
            listed = line
        else:
            parts = re.split(r"\s{2,}", line.strip(), maxsplit=1)
            assert len(parts) == 2, f"packaging-surface line carries no names: {line!r}"
            listed = parts[1]
        names.extend(name.strip() for name in listed.split("/") if name.strip())

    assert names, "the packaging-surface fence parsed to no names"
    return names


def test_the_readme_lists_exactly_the_names_the_package_exports():
    """Set, block size and prose numeral, all three against ``__all__``.

    The audited drift was a fence listing 8 of 32 names beside a prose numeral
    that was wrong on its own. Asserting only the set would let the numeral rot;
    asserting only the numeral would let someone satisfy the test by editing one
    digit while the fence stays short. Nothing here is a literal name list, so
    adding an export fails until the fence and the sentence both catch up.
    """
    listed = _packaging_surface_names()
    exported = list(__all__)

    assert set(listed) == set(exported), (
        "the packaging-surface fence and `__all__` disagree: "
        f"only in the document {sorted(set(listed) - set(exported))}, "
        f"only in `__all__` {sorted(set(exported) - set(listed))}"
    )
    assert len(listed) == len(exported), (
        f"the fence lists {len(listed)} names but `__all__` carries {len(exported)}"
    )

    prose = re.search(
        r"`__all__` is the exact surface and currently carries (\d+) names",
        _packaging_surface_region(),
    )
    assert prose is not None, (
        "the sentence stating how many names `__all__` carries moved or was reworded"
    )
    claimed = int(prose.group(1))
    assert claimed == len(listed) == len(exported), (
        f"the prose claims {claimed} names, the fence lists {len(listed)}, "
        f"`__all__` carries {len(exported)}"
    )


def _code_parameter_names() -> dict[str, list[str]]:
    """Declared parameter names of every callable in ``__all__``, in order.

    Varargs are dropped because a document spells them inconsistently and they
    say nothing about the call a reader will write. Protocol classes reduce to
    nothing here and are simply never matched by a documented span.
    """
    names: dict[str, list[str]] = {}
    for name in __all__:
        obj = getattr(ag_ui_strands, name)
        if not callable(obj):
            continue
        try:
            signature = inspect.signature(obj)
        except (TypeError, ValueError):
            continue
        names[name] = [
            parameter.name
            for parameter in signature.parameters.values()
            if parameter.kind not in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD)
        ]
    return names


def _split_top_level(text: str) -> list[str]:
    """Split on commas outside brackets and quotes, so defaults stay intact."""
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    quote = ""
    for char in text:
        if quote:
            current.append(char)
            if char == quote:
                quote = ""
            continue
        if char in "\"'":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append("".join(current))
            current = []
            continue
        current.append(char)
    parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def _documented_parameter_names(arguments: str) -> list[str]:
    names = []
    for argument in _split_top_level(arguments):
        if argument in {"*", "/"} or argument.startswith("*"):
            continue
        names.append(argument.split("=", 1)[0].split(":", 1)[0].strip())
    return names


# A documented signature is a code span that opens a list item. Both looser
# rules admit an example call, which legitimately passes a variable or a chosen
# value where the signature names a parameter, so reading one as a signature
# would fail against correct prose: dropping the list marker admits a sentence
# that happens to start with a call span, and dropping the line-start anchor
# admits a call quoted mid-sentence. A genuine signature written some other way
# is not silently skipped either, because the set of callables this finds is
# asserted below.
_SIGNATURE_SPAN = re.compile(
    r"^[ \t]*[-*+][ \t]+`([A-Za-z_][A-Za-z0-9_]*)\((.*?)\)`",
    re.MULTILINE,
)

# Which callables the README currently quotes a signature for. Pinned so a
# signature quietly vanishing from the prose fails here instead of shrinking the
# scan to nothing. Parameter names are never pinned; those come from the code.
DOCUMENTED_SIGNATURES = {"add_strands_fastapi_endpoint", "create_strands_app"}


def test_every_quoted_signature_matches_the_parameters_the_code_declares():
    """Ordered names, because a reader passes positional arguments by position.

    The audited drift was a quoted signature missing ``invocation_state_provider``
    in two documents while the parameter had existed for releases. Comparing
    sets rather than sequences would have caught that one and missed a reorder,
    which misleads a reader in exactly the same way.
    """
    declared = _code_parameter_names()
    found: dict[str, set[str]] = {}

    for label, document in (("README.md", README),):
        for match in _SIGNATURE_SPAN.finditer(document):
            name, arguments = match.group(1), match.group(2)
            if name not in declared:
                continue
            found.setdefault(name, set()).add(label)
            documented = _documented_parameter_names(arguments)
            assert documented == declared[name], (
                f"{label} documents {name} as {documented} but the code declares "
                f"{declared[name]}"
            )

    assert set(found) == DOCUMENTED_SIGNATURES, (
        f"the README quotes signatures for {sorted(found)}, expected "
        f"{sorted(DOCUMENTED_SIGNATURES)}"
    )

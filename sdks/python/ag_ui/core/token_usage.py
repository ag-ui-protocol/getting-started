"""
Vendor -> :class:`TokenUsage` mappers and aggregation for the Python SDK.

Python twin of ``sdks/typescript/packages/core/src/token-usage.ts``. Producers
(the LangGraph integration today) accumulate one entry per model call and
aggregate at the terminal event, so ``RUN_FINISHED.usage`` / ``RUN_ERROR.usage``
carry one summary per ``(provider, model)``.

Only numeric counts and the optional provider/model labels are ever mapped.
:class:`TokenUsage` feeds anonymous usage telemetry, so no prompt, completion,
message or other content-bearing field may be copied into it — see the type's
own docstring.
"""

import math
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .events import TokenUsage

__all__ = [
    "token_usage_from_langchain_metadata",
    "aggregate_token_usage",
]

# The snake_case :class:`TokenUsage` count fields, in wire order. Labels
# (provider/model) are deliberately not here: a labels-only entry is not usage,
# which is what ``_build_entry`` checks this tuple to decide.
_COUNT_KEYS: Tuple[str, ...] = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "reasoning_tokens",
    "cached_input_tokens",
)


# The largest count that survives every binding's wire representation. Proto
# `int64` and C# `long?` reach 2**63 - 1, but the TypeScript protobuf decoder
# stops at `Number.MAX_SAFE_INTEGER`, so that is the real ceiling across the
# bindings. Python ints are unbounded, so a provider (or a bad cast upstream of
# one) can hand over a number that simply cannot be encoded; it is rejected
# here, at the producer, rather than becoming an encoder crash mid-stream.
_MAX_TOKEN_COUNT = 2**53 - 1


def _normalize_number(value: Any) -> Optional[int]:
    """
    Accept a value only if it is a real, finite, non-negative whole number that
    fits the wire, and return it as an ``int``.

    Providers do hand over strings, ``None``s and ``NaN``s in their usage
    metadata, and a bad value must not reach the wire: consumers validate every
    incoming event and raise on failure, so one malformed count would fail an
    otherwise-successful run at its final event — costing the user the answer,
    not just the token count.

    This guards harder than the TypeScript ``num()`` it mirrors, which only
    checks finiteness and leaves the integer/non-negative bound to schema
    validation. In Python that bound is enforced by :class:`TokenUsage` itself
    (``Optional[int]`` with ``ge=0``), i.e. by a constructor the *producer*
    calls — so an unguarded ``-1`` or ``1.5`` would not merely reach the wire,
    it would raise inside the producer's own terminal-event path and kill the
    run there. Rejecting the count is strictly better than losing the run.

    ``bool`` is excluded even though it subclasses ``int``: ``True`` is not a
    token count, and TypeScript's ``typeof v === "number"`` would not have
    admitted it either.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None

    # Integers are settled BEFORE any float check, and never converted to one.
    # ``math.isfinite`` coerces its argument to a float and raises
    # ``OverflowError`` on a large int — ``math.isfinite(10**1000)`` does — so
    # checking finiteness first would abort the run from inside the very guard
    # whose job is to render bad metadata harmless. An int is finite by
    # construction; the only questions are sign and range.
    if isinstance(value, int):
        return value if 0 <= value <= _MAX_TOKEN_COUNT else None

    if not math.isfinite(value):  # NaN, +Infinity, -Infinity
        return None
    # Range before ``int()``: bounding first keeps the conversion cheap and
    # keeps a 1e300 from being materialised as a 300-digit integer just to be
    # thrown away.
    if value < 0 or value > _MAX_TOKEN_COUNT or int(value) != value:
        return None
    return int(value)


def _prop(value: Any, key: str) -> Any:
    """
    Read a property from a value of unknown shape, yielding ``None`` for
    anything that carries no such key. Vendor payloads are untrusted, so every
    access is narrowed rather than assumed.

    Both mapping and attribute access are tried. LangChain's ``usage_metadata``
    is a ``TypedDict`` (a plain ``dict`` at runtime), but the same dual-path
    accommodation the LangGraph integration already makes for chunk shapes
    applies here: an object-shaped payload should lose its usage counts, not be
    silently reported as "no usage".
    """
    if isinstance(value, Mapping):
        return value.get(key)
    if isinstance(value, (str, bytes, int, float, bool)) or value is None:
        return None
    return getattr(value, key, None)


def _build_entry(
    counts: Mapping[str, Optional[int]],
    provider: Optional[str],
    model: Optional[str],
) -> Optional[TokenUsage]:
    """
    Build a :class:`TokenUsage` from already-guarded counts, or ``None`` when no
    count survived. Returning ``None`` rather than a labels-only entry keeps
    "the provider reported no usage" distinct from "the provider reported
    usage", so callers omit the field instead of emitting an entry that claims
    nothing — and never substitute zeros, which would read as a measured zero.
    """
    if all(counts.get(key) is None for key in _COUNT_KEYS):
        return None

    fields: Dict[str, Any] = {}
    if provider is not None:
        fields["provider"] = provider
    if model is not None:
        fields["model"] = model
    for key in _COUNT_KEYS:
        value = counts.get(key)
        if value is not None:
            fields[key] = value
    return TokenUsage(**fields)


def token_usage_from_langchain_metadata(
    usage_metadata: Any,
    *,
    provider: Optional[str] = None,
    model: Optional[str] = None,
) -> Optional[TokenUsage]:
    """
    Map a LangChain-family ``usage_metadata`` object into a :class:`TokenUsage`.

    LangChain and LangGraph both attach usage as ``{input_tokens,
    output_tokens, total_tokens, input_token_details: {cache_read},
    output_token_details: {reasoning}}``. This maps only those numeric counts
    plus the optional provider/model labels — never prompt/completion content.
    Returns ``None`` when no usable count is present, so callers can omit usage
    rather than report zeros.
    """
    if not usage_metadata:
        return None

    input_details = _prop(usage_metadata, "input_token_details")
    output_details = _prop(usage_metadata, "output_token_details")

    return _build_entry(
        {
            "input_tokens": _normalize_number(_prop(usage_metadata, "input_tokens")),
            "output_tokens": _normalize_number(_prop(usage_metadata, "output_tokens")),
            "total_tokens": _normalize_number(_prop(usage_metadata, "total_tokens")),
            "reasoning_tokens": _normalize_number(_prop(output_details, "reasoning")),
            "cached_input_tokens": _normalize_number(_prop(input_details, "cache_read")),
        },
        provider,
        model,
    )


def aggregate_token_usage(entries: Sequence[TokenUsage]) -> List[TokenUsage]:
    """
    Sum per-call :class:`TokenUsage` entries into one entry per
    ``(provider, model)`` pair. Order follows first appearance. A count field
    stays unset when no member of the group reported it, so "not reported" stays
    distinct from zero.

    Protocol-agnostic: works on any producer's list of entries, so integrations
    share it rather than reimplementing aggregation.
    """
    grouped: Dict[Tuple[Optional[str], Optional[str]], Dict[str, Optional[int]]] = {}

    for entry in entries:
        # Keyed on the label pair itself rather than on a joined string (what
        # the TypeScript version does): a separator inside a label cannot then
        # collide two distinct pairs into one group.
        key = (entry.provider, entry.model)
        target = grouped.setdefault(key, {})
        for field in _COUNT_KEYS:
            value = getattr(entry, field)
            if value is None:
                continue
            target[field] = (target.get(field) or 0) + value

    return [
        TokenUsage(
            provider=provider,
            model=model,
            **{key: value for key, value in counts.items() if value is not None},
        )
        for (provider, model), counts in grouped.items()
    ]

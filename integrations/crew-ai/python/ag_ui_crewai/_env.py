"""Shared env-var parse helpers for ag_ui_crewai.

Prior to this module, ``crews.py`` imported ``_parse_env_float`` from
``endpoint.py`` via a function-local import to sidestep the module-load cycle
(``endpoint`` imports ``ChatWithCrewFlow`` from ``crews`` at the top level).
That workaround was fragile (a cold-``__pycache__`` first run could fail when
both modules resolve each other simultaneously) and leaked import plumbing into
a hot path. Extracting the shared helper here gives both ``endpoint`` and
``crews`` a neutral third module to import from at load time, eliminating the
cycle. This module intentionally has NO imports from ``endpoint`` or ``crews``;
it must remain a leaf.
"""

import math
import os


def _parse_env_float(
    name: str,
    default: float,
    *,
    allow_disable: bool,
) -> float | None:
    """Parse a float env var with shared "non-finite / non-positive" policy.

    Consolidates the triplicated parse scaffolding previously spread
    across ``_flow_timeout_seconds`` / ``_cancel_join_timeout_seconds``
    / ``crews._llm_timeout_seconds``.

    Semantics:
    * Unset env var -> return ``default``.
    * Unparseable value (``TypeError`` / ``ValueError``) or non-finite
      (NaN / +/-inf) -> return ``default``. ``float('nan') > 0`` is
      False, which without the isfinite guard would silently flip to
      "disable" when ``allow_disable=True``.
    * ``allow_disable=True`` + non-positive value -> return ``None``
      (caller interprets as "disable the guard").
    * ``allow_disable=False`` + non-positive value -> return ``default``
      (caller requires a bounded positive; see
      ``_cancel_join_timeout_seconds`` for rationale).
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value):
        return default
    if value <= 0:
        return None if allow_disable else default
    return value


# Values that read as "on" for a boolean env var. Anything else (including
# unset) is "off": a conservative default for opt-in features.
_TRUE_VALUES = frozenset({"1", "true", "yes", "on", "y", "t"})

# The mirror set. Not used by the parser (anything outside ``_TRUE_VALUES`` is
# already false); it exists so a caller can tell an explicit "off" from an
# unrecognised value and report the latter as a probable typo.
_FALSE_VALUES = frozenset({"0", "false", "no", "off", "n", "f"})


def _parse_env_bool(name: str, default: bool = False) -> bool:
    """Parse a boolean env var with a permissive true-set.

    Unset -> ``default``. Otherwise case-insensitively true for
    ``1/true/yes/on/y/t`` and false for everything else (so a typo fails
    safe to "off" rather than silently enabling an opt-in feature).
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE_VALUES


def _parse_env_str(name: str, default: str) -> str:
    """Parse a string env var, treating unset OR empty/whitespace as unset.

    An operator who exports ``CREWAI_CHECKPOINT_DIR=`` (empty) means "use the
    default", not "checkpoint to the current directory root".
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip()


def _parse_env_int(name: str, default: int | None) -> int | None:
    """Parse an optional positive-int env var.

    Unset / unparseable / non-positive -> ``default`` (``None`` disables the
    associated bound). Mirrors ``_parse_env_float``'s fail-safe-to-default
    policy so a bad value never silently changes behaviour.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    if value <= 0:
        return default
    return value

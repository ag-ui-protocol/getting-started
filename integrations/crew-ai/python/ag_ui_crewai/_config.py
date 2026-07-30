"""Protocol-surface configuration for ag_ui_crewai.

A LEAF over ``_env`` + the stdlib, so ``_capabilities`` can report the resolved
configuration without importing the streaming stack (``_frames`` pulls in ``sdk``
and therefore litellm).

Resolution order for every option: an explicit argument on the endpoint factory
wins over the environment variable, which wins over the shipped default. The two
paths deliberately differ on a BAD value: an unrecognised env value falls back to
the default (a typo in a deployment variable must not take the service down),
while a wrong-typed argument raises at registration time (a mistake in code should
fail loudly, once, at startup rather than per request).
"""

import logging
import os

from ._env import _FALSE_VALUES, _TRUE_VALUES, _parse_env_bool

_LOGGER = logging.getLogger(__name__)

# RAW passthrough ships OFF: the payloads are large and carry prompt / completion
# text, so enabling it widens what leaves the process. Named so the capability
# declaration reports the shipped default rather than hardcoding it.
DEFAULT_EMIT_RAW_EVENTS = False

EMIT_RAW_EVENTS_ENV_VAR = "AGUI_CREWAI_EMIT_RAW_EVENTS"

# Wire shape for streamed text / tool-call output. Triples (START/CONTENT/END) is
# the canonical discrete form and the shipped default; "chunks" is a compatibility
# opt-out. Kept here (a leaf module) so the capability declaration can report it
# without importing the streaming stack.
SUPPORTED_EMISSION_SHAPES = frozenset({"triples", "chunks"})
DEFAULT_EMISSION_SHAPE = "triples"

EMISSION_SHAPE_ENV_VAR = "AGUI_CREWAI_EMISSION_SHAPE"

# Vocabulary ``_parse_env_bool`` accepts, so the "was this value used?" check stays
# in step with the parser instead of duplicating its token list.
_BOOL_TOKENS = _TRUE_VALUES | _FALSE_VALUES

_ENV_WARN_SEEN: set[tuple[str, str]] = set()


def _warn_if_env_value_ignored(name: str, raw: str | None, used: bool) -> None:
    """WARN once per (var, value) when a SET env var was silently ignored.

    Falling back on a typo is the right behaviour; falling back SILENTLY made the
    typo undiagnosable, because the operator sees default behaviour and no
    explanation. ``used`` is decided by the CALLER, which knows its own vocabulary.
    """
    if raw is None or used:
        return
    if raw.strip() == "":
        # ``_env`` treats an empty value as unset, so falling back is specified
        # behaviour rather than an ignored typo.
        return
    key = (name, raw)
    if key in _ENV_WARN_SEEN:
        return
    _ENV_WARN_SEEN.add(key)
    _LOGGER.warning(
        "ag-ui-crewai ignored %s=%r (unrecognised value) and is using the default "
        "instead",
        name,
        raw,
    )


def resolve_emit_raw_events(emit_raw_events: bool | None) -> bool:
    """Resolve RAW passthrough: explicit argument > env var > shipped default."""
    if emit_raw_events is not None:
        # Validate rather than trusting truthiness: config plumbing commonly hands
        # over the STRING "false", which is truthy, and silently enabling RAW
        # passthrough leaks prompt / completion text.
        if not isinstance(emit_raw_events, bool):
            raise ValueError(
                f"emit_raw_events must be a bool, got "
                f"{type(emit_raw_events).__name__} ({emit_raw_events!r}). Use the "
                f"{EMIT_RAW_EVENTS_ENV_VAR} env var for string values."
            )
        return emit_raw_events
    raw = os.environ.get(EMIT_RAW_EVENTS_ENV_VAR)
    resolved = _parse_env_bool(EMIT_RAW_EVENTS_ENV_VAR, DEFAULT_EMIT_RAW_EVENTS)
    used = raw is not None and raw.strip().casefold() in _BOOL_TOKENS
    _warn_if_env_value_ignored(EMIT_RAW_EVENTS_ENV_VAR, raw, used)
    return resolved


def resolve_emission_shape(emission_shape: str | None) -> str:
    """Resolve the wire shape: explicit argument > env var > shipped default."""
    if emission_shape is not None:
        if not isinstance(emission_shape, str):
            raise ValueError(
                f"emission_shape must be a string, got "
                f"{type(emission_shape).__name__} ({emission_shape!r})"
            )
        normalized = emission_shape.strip().casefold()
        if normalized not in SUPPORTED_EMISSION_SHAPES:
            raise ValueError(
                f"Unknown emission_shape {emission_shape!r}; "
                f"expected one of {sorted(SUPPORTED_EMISSION_SHAPES)}"
            )
        return normalized
    raw = os.environ.get(EMISSION_SHAPE_ENV_VAR)
    resolved = DEFAULT_EMISSION_SHAPE
    used = False
    if raw is not None:
        token = raw.strip().casefold()
        if token in SUPPORTED_EMISSION_SHAPES:
            resolved, used = token, True
    _warn_if_env_value_ignored(EMISSION_SHAPE_ENV_VAR, raw, used)
    return resolved

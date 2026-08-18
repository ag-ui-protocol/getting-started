"""Protocol-surface configuration for ag_ui_crewai.

A LEAF over ``_env`` + the stdlib, so ``_capabilities`` can report the resolved
configuration without importing the streaming stack (``_frames`` pulls in ``sdk``
and therefore litellm).

Resolution order for the two options the endpoint factory takes
(``emit_raw_events``, ``emission_shape``): the explicit argument wins over the
environment variable, which wins over the shipped default. The two paths
deliberately differ on a BAD value: an unrecognised env value falls back to the
default (a typo in a deployment variable must not take the service down), while a
wrong-typed argument raises at registration time (a mistake in code should fail
loudly, once, at startup rather than per request).

The remaining options - thread-scoped memory, the conversational worker cap and
the provider timeout - have no factory argument at all: they are env-only and
re-read per call, so an operator can retune them without a redeploy.
"""

import logging
import math
import os

from ._env import (
    _FALSE_VALUES,
    _TRUE_VALUES,
    _parse_env_bool,
    _parse_env_float,
)

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
# Per-thread memory isolation (crew and agent) ships ON: sharing one namespace across
# every AG-UI ``threadId`` leaks one chat's remembered facts into another, which
# is a privacy bug rather than a feature. The opt-out exists because a
# deployment may WANT one durable knowledge base behind every chat; turning it
# off restores the pre-fix "one namespace per crew name" behaviour exactly.
DEFAULT_THREAD_SCOPED_MEMORY = True

THREAD_SCOPED_MEMORY_ENV_VAR = "AGUI_CREWAI_THREAD_SCOPED_MEMORY"

# Process-wide ceiling on concurrently-active SYNC conversational workers.
#
# CrewAI exposes no async turn stream, so ``conversational=True`` drives its
# synchronous ``StreamSession`` on a background thread. That thread cannot be
# killed from the request loop, so a turn abandoned by its client keeps running
# until its own upstream call returns. Without a cap, disconnect-heavy load
# grows that population without bound. The cap is on WORKERS, not requests: a
# rejected request costs one RUN_ERROR, an unbounded worker costs a thread plus
# a provider connection for the remainder of its turn.
DEFAULT_MAX_CONVERSATION_WORKERS = 16

MAX_CONVERSATION_WORKERS_ENV_VAR = "AGUI_CREWAI_MAX_CONVERSATION_WORKERS"

# Upper sanity bound on that cap: eight times the default, which leaves real
# headroom for a busy deployment while still catching an extra digit (a mistyped
# ``160`` for ``16`` reserves ten times the unkillable threads the operator meant
# to). A deployment that genuinely wants more concurrent sync turns than this
# wants a second process, not a bigger thread population in this one. Refused
# rather than clamped, matching the other rejections here: the default plus a
# warning naming the limit is diagnosable, a silently different number is not.
MAX_CONVERSATION_WORKERS_CEILING = 128

# Per-read timeout handed to the provider client. Shared by the crew-chat flow
# and the shipped example flows. It bounds one READ, not one turn: crewai
# composes it (see ``resolve_agent_execution_ceiling_seconds``), so it is a
# building block of the per-turn bound rather than the bound itself.
DEFAULT_PROVIDER_TIMEOUT_SECONDS = 120.0

# What a provider client uses when this integration passes no timeout at all.
# Read out of the installed clients rather than assumed: litellm's
# ``completion`` resolves an absent timeout to 600 (``litellm/main.py:1059``) and
# the OpenAI SDK's ``DEFAULT_TIMEOUT`` is a 600s read timeout
# (``openai/_constants.py``). Same number on both, and the same number as the
# shipped flow ceiling, which is why disabling the knob is not the safe end of the
# range it looks like.
PROVIDER_DEFAULT_TIMEOUT_SECONDS = 600.0

PROVIDER_TIMEOUT_ENV_VAR = "AGUI_CREWAI_LLM_TIMEOUT_SECONDS"

# The request-side wall-clock ceiling on one flow run. Declared by ``endpoint``,
# which enforces it; mirrored here because this module is a leaf and importing
# ``endpoint`` back would close a load cycle (``endpoint`` -> ``crews`` -> here).
# Same variable and same default, so the two must be changed together.
FLOW_TIMEOUT_ENV_VAR = "AGUI_CREWAI_FLOW_TIMEOUT_SECONDS"
DEFAULT_FLOW_TIMEOUT_SECONDS = 600.0

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


def _warn_if_env_value_rejected(name: str, raw: str, limit: str) -> None:
    """WARN once per (var, value) when a PARSED env value was refused by policy.

    Separate from ``_warn_if_env_value_ignored`` on purpose: reporting an
    explicit ``0`` or ``-1`` as an unrecognised value tells the operator their
    value was a typo, when in fact it parsed fine and the option simply refuses
    it. The two need different words to be diagnosable.
    """
    key = (name, raw)
    if key in _ENV_WARN_SEEN:
        return
    _ENV_WARN_SEEN.add(key)
    _LOGGER.warning(
        "ag-ui-crewai refused %s=%r (%s) and is using the default instead",
        name,
        raw,
        limit,
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


def resolve_thread_scoped_memory() -> bool:
    """Resolve per-thread crew-memory isolation: env var > shipped default (on).

    Env-only, and re-read per request rather than resolved once at registration:
    unlike ``emit_raw_events`` there is no endpoint-factory argument to conflict
    with, and an operator flipping the variable should not have to know which
    call it was frozen at.

    Deliberately NOT ``_parse_env_bool``: that parser treats anything outside its
    true-set as false, which is the right fail-safe for an option that ships OFF
    but the wrong one here: a typo would silently DISABLE isolation and restore
    the cross-thread leak. Only a recognised false token turns it off; anything
    else keeps the shipped default and warns once.
    """
    raw = os.environ.get(THREAD_SCOPED_MEMORY_ENV_VAR)
    if raw is None:
        return DEFAULT_THREAD_SCOPED_MEMORY
    token = raw.strip().casefold()
    used = token in _BOOL_TOKENS
    _warn_if_env_value_ignored(THREAD_SCOPED_MEMORY_ENV_VAR, raw, used)
    if not used:
        return DEFAULT_THREAD_SCOPED_MEMORY
    return token in _TRUE_VALUES


def resolve_max_conversation_workers() -> int:
    """Resolve the sync conversational worker ceiling: env var > shipped default.

    Env-only and re-read per request, matching ``resolve_thread_scoped_memory``:
    there is no endpoint-factory argument to conflict with, and an operator
    raising the ceiling under load should not have to redeploy.

    Deliberately NOT disable-able. A non-positive or unparseable value keeps the
    shipped default and warns once, because a cap that can be turned off is not
    a cap: the whole point is that an abandoned worker cannot be killed, so an
    unbounded population is a guaranteed leak rather than a tuning choice. The
    two rejections warn DIFFERENTLY: an operator who wrote ``0`` on purpose
    needs to hear that the option refuses it, not that it looked like a typo.
    """
    raw = os.environ.get(MAX_CONVERSATION_WORKERS_ENV_VAR)
    if raw is None:
        return DEFAULT_MAX_CONVERSATION_WORKERS
    try:
        value = int(raw.strip())
    except (TypeError, ValueError):
        # Unparseable (or empty, which ``_env`` treats as unset and never warns
        # about) - the "looked like a typo" wording is the right one.
        _warn_if_env_value_ignored(MAX_CONVERSATION_WORKERS_ENV_VAR, raw, False)
        return DEFAULT_MAX_CONVERSATION_WORKERS
    if value <= 0:
        _warn_if_env_value_rejected(
            MAX_CONVERSATION_WORKERS_ENV_VAR,
            raw,
            "the worker cap cannot be disabled; it must be a positive integer",
        )
        return DEFAULT_MAX_CONVERSATION_WORKERS
    if value > MAX_CONVERSATION_WORKERS_CEILING:
        _warn_if_env_value_rejected(
            MAX_CONVERSATION_WORKERS_ENV_VAR,
            raw,
            f"the worker cap must not exceed {MAX_CONVERSATION_WORKERS_CEILING}",
        )
        return DEFAULT_MAX_CONVERSATION_WORKERS
    return value


def _env_float_was_used(raw: str | None) -> bool:
    """Whether ``_parse_env_float`` USED ``raw`` rather than falling back.

    Mirrors that parser: an unparseable or non-finite value falls back to the
    default, while a non-positive one is honoured as "disable the guard".
    """
    if raw is None:
        return False
    try:
        return math.isfinite(float(raw))
    except (TypeError, ValueError):
        return False


def _warn_if_provider_timeout_exceeds_ceiling(
    timeout: float | None,
    ceiling: float | None,
) -> None:
    """WARN once when one provider read can outlast the whole flow run.

    The rule was documented and enforced nowhere. A read allowed to outlast the
    request-side ceiling guarantees the shape that ceiling exists to bound: the
    response is torn down while the worker behind it is still waiting on the
    provider, and on the conversational path that worker cannot be killed.

    ``None`` is the case that most needs saying, not one to skip: it means this
    integration passes no timeout, so the client's own 600s stands in, which MEETS
    the 600s shipped ceiling rather than staying under it. So the comparison is
    ">=" against the effective read bound, and the message reports which of the two
    it is.

    ``ceiling`` is passed in rather than resolved here so one call resolves each
    variable exactly once: a caller that already has it would otherwise read it a
    second time, and two reads can disagree.
    """
    if ceiling is None:
        return
    effective = (
        PROVIDER_DEFAULT_TIMEOUT_SECONDS if timeout is None else timeout
    )
    if effective < ceiling:
        return
    key = (PROVIDER_TIMEOUT_ENV_VAR, f"{effective}>={ceiling}")
    if key in _ENV_WARN_SEEN:
        return
    _ENV_WARN_SEEN.add(key)
    _LOGGER.warning(
        "ag-ui-crewai provider read bound %ss (%s) is not shorter than the %ss flow "
        "ceiling (%s): one provider read can now outlast the request that wanted "
        "it, leaving the worker behind it running after the response is gone",
        effective,
        "the provider client's own default, since the timeout is disabled"
        if timeout is None
        else PROVIDER_TIMEOUT_ENV_VAR,
        ceiling,
        FLOW_TIMEOUT_ENV_VAR,
    )


def resolve_provider_timeout_seconds() -> float | None:
    """Resolve the provider per-read timeout, or ``None`` when disabled.

    A non-positive value disables it; a non-finite one falls back to the
    default (see ``_env._parse_env_float``). Lives here rather than on
    ``crews`` so the example flows can configure a real timeout without
    importing the crew-chat module (and its litellm surface).

    ``None`` means "this integration passes no timeout", NOT "unbounded": the
    provider client substitutes its own default, 600s on both litellm and the
    OpenAI SDK (see ``PROVIDER_DEFAULT_TIMEOUT_SECONDS``), which is exactly as long
    as the shipped flow ceiling rather than shorter. Disabling the knob therefore
    relaxes the bound on an abandoned worker to the ceiling itself rather than
    removing it, and it warns.

    Bounds ONE read. crewai multiplies it - the OpenAI SDK retries a call
    ``max_retries`` times and the agent executor loops up to ``max_iter`` times -
    so it is not a per-turn bound on its own; see
    ``resolve_agent_execution_ceiling_seconds``.
    """
    return _resolve_provider_timeout(resolve_flow_ceiling_seconds())


def _resolve_provider_timeout(ceiling: float | None) -> float | None:
    """The body of ``resolve_provider_timeout_seconds``, against a known ceiling.

    Split out so a caller that has already resolved the flow ceiling can hand it
    over instead of causing a second read of the same variable.
    """
    raw = os.environ.get(PROVIDER_TIMEOUT_ENV_VAR)
    resolved = _parse_env_float(
        PROVIDER_TIMEOUT_ENV_VAR,
        DEFAULT_PROVIDER_TIMEOUT_SECONDS,
        allow_disable=True,
    )
    # The only resolver here that used to fall back in silence, so a ``30s``
    # typo left every worker on the provider's own default with no explanation.
    _warn_if_env_value_ignored(
        PROVIDER_TIMEOUT_ENV_VAR, raw, _env_float_was_used(raw)
    )
    _warn_if_provider_timeout_exceeds_ceiling(resolved, ceiling)
    return resolved


def resolve_flow_ceiling_seconds() -> float | None:
    """Resolve the request-side flow ceiling, or ``None`` when disabled.

    Reads the variable ``endpoint`` enforces rather than importing it (see
    ``FLOW_TIMEOUT_ENV_VAR``), so both the provider-timeout sanity check and the
    agent-execution ceiling below can be derived from the same horizon.
    """
    return _parse_env_float(
        FLOW_TIMEOUT_ENV_VAR,
        DEFAULT_FLOW_TIMEOUT_SECONDS,
        allow_disable=True,
    )


def resolve_agent_execution_ceiling_seconds() -> int | None:
    """Resolve the ceiling for ONE synchronous crewai agent execution.

    A crewai ``Agent`` composes the provider timeout rather than obeying it: the
    OpenAI SDK retries each call (``max_retries=2``), the executor loops
    (``max_iter=25``) and a failed execution is retried (``max_retry_limit=2``),
    so a 120s read timeout composes into hours of wall clock inside one turn.
    ``Agent(max_execution_time=...)`` is the knob that bounds the execution
    itself, and crewai leaves it unset.

    Derived, not a fresh number: the request-side flow ceiling is the horizon a
    turn is wanted for, so an execution outliving it is pure waste. With the
    ceiling disabled the provider timeout is the longest legitimate single wait
    and stands in for it; with both disabled the deployment has opted out of
    bounding and gets ``None``.

    A positive WHOLE number, guaranteed here rather than by the field it feeds:
    crewai's ``max_execution_time`` is a plain ``int | None`` field with no
    constraint (``agent/core.py:212``), and the positive-int check runs only when a
    task executes (``agent/utils.py:313-317``), so a bad value would surface deep
    inside a turn instead of at construction.
    """
    ceiling = resolve_flow_ceiling_seconds()
    if ceiling is None:
        # The already-resolved (disabled) ceiling is handed over rather than let
        # the provider resolver read that variable a second time: two reads of one
        # variable in one call can disagree, and the second one drives a warning.
        ceiling = _resolve_provider_timeout(None)
    if ceiling is None:
        return None
    return max(1, math.ceil(ceiling))

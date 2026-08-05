"""CrewAI flow checkpointing / thread persistence for the AG-UI bridge.

``build_checkpoint_kwargs(flow, input_data)`` produces the kwargs the endpoints
splice into a flow kickoff. It is opt-in (off unless ``CREWAI_CHECKPOINT`` is
set, so the default path is unchanged), capability-gated (returns ``{}`` unless
the installed crewai and this specific flow both support ``from_checkpoint``),
and per-thread (each ``thread_id`` gets its own store). A leaf module: imports
only the stdlib, ``_env`` and ``_capabilities``.

crewai has two mutually exclusive resume systems: passing ``from_checkpoint``
and ``restore_from_state_id`` together raises ``ValueError``. This module uses
only Checkpointing: ``from_checkpoint=CheckpointConfig(...)`` persists, and
resume is explicit via ``CheckpointConfig(restore_from=<checkpoint path>)`` (a
fresh kickoff with ``from_checkpoint`` alone re-runs every step). It never
emits ``restore_from_state_id``. ``inputs["id"]`` stays as the thread linkage.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

from . import _capabilities as _caps
from ._env import _parse_env_bool, _parse_env_int, _parse_env_str

_LOGGER = logging.getLogger(__name__)

# Env knobs (all optional; the feature is off unless CREWAI_CHECKPOINT is set).
_ENV_ENABLED = "CREWAI_CHECKPOINT"
_ENV_PROVIDER = "CREWAI_CHECKPOINT_PROVIDER"  # "json" (default) | "sqlite"
_ENV_DIR = "CREWAI_CHECKPOINT_DIR"  # base location; per-thread subdir appended
_ENV_MAX = "CREWAI_CHECKPOINT_MAX"  # int cap on retained checkpoints per thread
_ENV_ON_EVENTS = "CREWAI_CHECKPOINT_ON_EVENTS"  # comma-separated event triggers

_DEFAULT_DIR = "./.checkpoints"
_DEFAULT_PROVIDER = "json"
# CheckpointConfig defaults ``on_events`` to ``["task_completed"]``, a crew
# trigger. The bridge always drives a flow (which emits
# ``method_execution_finished``, not ``task_completed``), so the stock default
# would write nothing; a flow-appropriate trigger is required.
_DEFAULT_ON_EVENTS = ("method_execution_finished",)

# ``thread_id`` becomes a path segment, so it is sanitised to a safe charset;
# a value that reduces to nothing usable yields ``None`` (caller then skips
# checkpointing rather than sharing a bucket).
_UNSAFE_SEGMENT = re.compile(r"[^A-Za-z0-9._-]+")
_MAX_SEGMENT_LEN = 128
# The json provider writes under ``<location>/main/``; a checkpoint id resolves
# to ``<location>/main/<id>.json``.
_CHECKPOINT_BRANCH_DIR = "main"

# forwarded_props keys a client may use to request restoring a checkpoint
# (checked top-level and nested under a "crewai" key). RunAgentInput.resume is
# deliberately not consulted (it is the AG-UI interrupt-resume list, not a
# checkpoint reference), and "restore_from_state_id" is intentionally excluded
# (that is the @persist kwarg name, a different system).
_RESUME_KEYS = ("restore_from", "checkpoint_id")

# Dedupe one-time warnings so they log once, not per request.
_WARN_SEEN: set[str] = set()


@dataclass(frozen=True)
class _CheckpointSettings:
    enabled: bool
    provider: str
    base_dir: str
    max_checkpoints: int | None
    on_events: tuple[str, ...]


def resolve_checkpoint_settings() -> _CheckpointSettings:
    """Read the checkpoint env knobs into an immutable settings snapshot.

    Read per request (not cached) so tests / operators can flip
    ``CREWAI_CHECKPOINT`` without reimporting the module; the parse is cheap.
    """
    enabled = _parse_env_bool(_ENV_ENABLED, default=False)
    provider = _parse_env_str(_ENV_PROVIDER, _DEFAULT_PROVIDER).lower()
    if provider not in ("json", "sqlite"):
        if enabled:
            _warn_once(
                "provider-unknown",
                "ag-ui-crewai: unknown CREWAI_CHECKPOINT_PROVIDER %r; using %r.",
                provider,
                _DEFAULT_PROVIDER,
            )
        provider = _DEFAULT_PROVIDER
    raw_events = _parse_env_str(_ENV_ON_EVENTS, "")
    on_events = (
        tuple(e.strip() for e in raw_events.split(",") if e.strip())
        or _DEFAULT_ON_EVENTS
    )
    return _CheckpointSettings(
        enabled=enabled,
        provider=provider,
        base_dir=_parse_env_str(_ENV_DIR, _DEFAULT_DIR),
        max_checkpoints=_parse_env_int(_ENV_MAX, default=None),
        on_events=on_events,
    )


def _safe_thread_segment(thread_id: Any) -> str | None:
    """Map ``thread_id`` to a safe, injective path segment, or ``None``.

    Returns ``None`` for a missing / non-string id, so the caller skips
    checkpointing rather than sharing a store (a cross-session leak). Otherwise
    the segment is ``<sanitised>-<hash>``: the sanitised prefix stays readable
    (unsafe chars collapse to ``_``, capped in length, never escaping the base
    dir), and the hash of the RAW id makes the mapping injective, so distinct
    thread_ids (e.g. ``"a/b"`` vs ``"a_b"``) never collide onto one store while
    the same id always maps to the same segment.
    """
    if not isinstance(thread_id, str) or not thread_id:
        return None
    cleaned = _UNSAFE_SEGMENT.sub("_", thread_id).strip("._")[:_MAX_SEGMENT_LEN].strip("._")
    digest = hashlib.sha256(thread_id.encode("utf-8")).hexdigest()[:12]
    return f"{cleaned}-{digest}" if cleaned else digest


def _make_provider(provider: str) -> Any | None:
    """Instantiate the configured provider, or ``None`` if none is available.

    Falls back to the OTHER installed provider (with a one-time warning) when
    the requested one is missing, symmetrically for both ``json`` and
    ``sqlite`` requests, so a partial install degrades rather than silently
    disabling persistence. Constructors are invoked here but the sole caller
    (``_build_config``) runs this inside its try/except, so a raising
    constructor degrades instead of surfacing as a request-level 500.
    """
    json_cls = _caps.JsonProvider
    sqlite_cls = _caps.SqliteProvider
    if provider == "sqlite":
        primary, fallback, requested = sqlite_cls, json_cls, "sqlite"
    else:  # default / "json"
        primary, fallback, requested = json_cls, sqlite_cls, "json"
    if primary is not None:
        return primary()
    if fallback is not None:
        _warn_once(
            "provider-fallback",
            "ag-ui-crewai: CREWAI_CHECKPOINT_PROVIDER=%s but that crewai "
            "provider is unavailable; falling back to the other installed "
            "provider.",
            requested,
        )
        return fallback()
    return None


def _thread_location(settings: _CheckpointSettings, segment: str) -> str:
    """Per-thread checkpoint store path under the configured base dir.

    ``os.path.join`` keeps this correct across separators; ``segment`` is
    already sanitised to a safe single component.
    """
    return os.path.join(settings.base_dir, segment)


def _resolve_restore_path(location: str, raw: str) -> str | None:
    """Resolve a client-supplied checkpoint id to a file inside this thread's store.

    The id is client-controlled, so it must never escape the thread's own
    store: absolute paths, path separators and ``..`` are rejected outright,
    and the resolved path is confirmed to sit under ``<location>/main/`` before
    use. Returns the path only when it exists, so a bad/stale id degrades to
    "no restore" (a warning) rather than a traversal or a crewai
    ``FileNotFoundError`` that would 500 the request.
    """
    if os.path.isabs(raw) or "/" in raw or "\\" in raw or ".." in raw:
        return None
    name = raw if raw.endswith(".json") else raw + ".json"
    store = os.path.join(location, _CHECKPOINT_BRANCH_DIR)
    candidate = os.path.join(store, name)
    try:
        store_real = os.path.realpath(store)
        candidate_real = os.path.realpath(candidate)
        # A NUL byte (realpath) or a cross-drive path on Windows (commonpath)
        # raises ValueError on the client-controlled value; treat as no-match.
        if os.path.commonpath([store_real, candidate_real]) != store_real:
            return None
        return candidate if os.path.isfile(candidate) else None
    except ValueError:
        return None


def _build_config(
    settings: _CheckpointSettings, *, thread_id: Any, restore_from: str | None = None
) -> Any | None:
    """Build a per-thread ``CheckpointConfig``, or ``None`` if it cannot be built.

    Returns ``None`` (never raises) when: the config type is unavailable, the
    request has no usable ``thread_id``, no provider can be instantiated, or
    construction fails. Provider instantiation and config construction both run
    inside the try/except so a raising crewai constructor degrades to
    "no checkpointing for this run" instead of 500-ing the request.

    ``restore_from`` (already resolved to an existing checkpoint file path) is
    folded into the config to resume that point WITHIN the checkpointing
    system, never as the incompatible ``restore_from_state_id`` kwarg.
    """
    config_cls = _caps.CheckpointConfig
    if config_cls is None:
        return None
    segment = _safe_thread_segment(thread_id)
    if segment is None:
        _warn_once(
            "no-thread-id",
            "ag-ui-crewai: checkpointing is enabled but the request carries no "
            "usable thread_id; skipping persistence for this run rather than "
            "sharing one checkpoint store across sessions.",
        )
        return None
    try:
        provider = _make_provider(settings.provider)
        if provider is None:
            return None
        # Per-thread subdir under the base dir gives each thread its own store.
        location = _thread_location(settings, segment)
        kwargs: dict[str, Any] = {
            "provider": provider,
            "location": location,
            "on_events": list(settings.on_events),
        }
        if settings.max_checkpoints is not None:
            kwargs["max_checkpoints"] = settings.max_checkpoints
        if restore_from is not None:
            kwargs["restore_from"] = restore_from
        return config_cls(**kwargs)
    except Exception as exc:  # noqa: BLE001 - never let config-building break a run
        _warn_once(
            "config-build",
            "ag-ui-crewai: failed to build a CheckpointConfig (%s); continuing "
            "without checkpointing for this run." % (exc,),
        )
        return None


def _resume_reference(input_data: Any) -> str | None:
    """Extract a client-requested checkpoint id to restore, if any.

    The value is a bare checkpoint id (resolved within this thread's store by
    ``_resolve_restore_path``), NOT a ``@persist`` state id or a path. Looks at
    ``forwarded_props`` for one of ``_RESUME_KEYS``, both at the top level and
    nested under a ``crewai`` key. Returns the first non-empty string found,
    else ``None``.
    """

    def _from_mapping(mapping: Any) -> str | None:
        if not isinstance(mapping, dict):
            return None
        for key in _RESUME_KEYS:
            value = mapping.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    props = getattr(input_data, "forwarded_props", None)
    found = _from_mapping(props)
    if found:
        return found
    if isinstance(props, dict):
        found = _from_mapping(props.get("crewai"))
        if found:
            return found
    return None


def _warn_once(key: str, message: str, *args: Any) -> None:
    """Log a WARNING once per process, keyed by ``key``.

    For deploy/config-level conditions (missing capability, provider fallback)
    where repeating per request would be noise. Per-request, client-driven
    failures should use ``_warn`` instead so distinct occurrences are visible.
    """
    if key in _WARN_SEEN:
        return
    _WARN_SEEN.add(key)
    _LOGGER.warning(message, *args)


def _warn(message: str, *args: Any) -> None:
    """Log a per-occurrence WARNING (no dedupe) for client-driven failures."""
    _LOGGER.warning(message, *args)


def _warn_unsupported_once(settings: _CheckpointSettings) -> None:
    """Warn (once) that checkpointing is enabled but will not run for this flow.

    Distinguishes the two distinct causes so the operator gets a truthful
    signal instead of always being told to upgrade crewai:

    * crewai itself lacks the API (``checkpointing_available`` False): name the
      enabling version and advise an upgrade.
    * crewai IS capable but THIS flow object does not accept ``from_checkpoint``
      (a custom flow or a test double): an upgrade would not help, so say so.
    """
    caps_ = _caps.CAPABILITIES
    versions = _caps.CHECKPOINT_ENABLING_VERSIONS
    if not caps_.checkpointing_available:
        # Name the LOWEST enabling version of whichever piece is missing.
        # ``from_checkpoint`` (1.13.0) predates ``CheckpointConfig`` (1.14.0);
        # if the kwarg is absent that is the floor, otherwise the config type is.
        if not caps_.flow_from_checkpoint_supported:
            need = versions["from_checkpoint"]
        else:
            need = versions["checkpoint_config"]
        _warn_once(
            "unsupported-version",
            "ag-ui-crewai: CREWAI_CHECKPOINT is set but the installed crewai "
            "(%s) does not expose the checkpointing API the bridge needs; runs "
            "will NOT be persisted. Upgrade to crewai>=%s.",
            caps_.crewai_version,
            need,
        )
    else:
        _warn_once(
            "unsupported-flow",
            "ag-ui-crewai: CREWAI_CHECKPOINT is set and crewai %s supports "
            "checkpointing, but this flow object does not accept the "
            "from_checkpoint kwarg (e.g. a custom flow or test double); runs "
            "will NOT be persisted for it.",
            caps_.crewai_version,
        )


def build_checkpoint_kwargs(flow: Any, input_data: Any) -> dict[str, Any]:
    """Build the checkpoint kwargs to splice into a flow kickoff/astream call.

    Returns ``{}`` (i.e. "no change to the default path") unless ALL of:

    * ``CREWAI_CHECKPOINT`` is truthy,
    * the installed crewai can build a config AND drive it (capability probe),
    * this specific ``flow`` accepts ``from_checkpoint`` (per-flow probe).

    When enabled the result is always exactly ``{"from_checkpoint": config}``:
    a per-thread ``CheckpointConfig`` that persists this thread's runs and,
    when the client supplied a resolvable checkpoint reference, carries
    ``restore_from`` to resume that point. The module NEVER emits
    ``restore_from_state_id`` (the incompatible ``@persist`` kwarg, which would
    raise ``ValueError`` alongside ``from_checkpoint``). The caller still
    filters the returned dict against the exact method being invoked via
    ``_capabilities.supported_checkpoint_kwargs``.
    """
    settings = resolve_checkpoint_settings()
    if not settings.enabled:
        return {}
    if not _caps.flow_supports_checkpointing(flow):
        _warn_unsupported_once(settings)
        return {}

    thread_id = getattr(input_data, "thread_id", None)

    # Resolve a client-requested checkpoint id to a file in this thread's store,
    # if any. Any failure degrades to plain persistence (never a crash), and is
    # logged per-occurrence since it is driven by client input.
    restore_from: str | None = None
    raw_ref = _resume_reference(input_data)
    segment = _safe_thread_segment(thread_id)
    if raw_ref is not None and segment is not None:
        # Restore-by-id resolves against the json provider's on-disk layout;
        # gate on the EFFECTIVE provider (json requested AND available, i.e. no
        # fallback away from json) so a bare id is never resolved against a
        # different layout.
        if settings.provider == "json" and _caps.JsonProvider is not None:
            restore_from = _resolve_restore_path(
                _thread_location(settings, segment), raw_ref
            )
            if restore_from is None:
                _warn(
                    "ag-ui-crewai: checkpoint restore id %r could not be "
                    "resolved to a checkpoint in this thread's store (unknown "
                    "or rejected); continuing without restore (persistence "
                    "still active).",
                    raw_ref,
                )
        else:
            _warn(
                "ag-ui-crewai: a checkpoint restore id was supplied but "
                "restore-by-id is only supported for the json provider; "
                "ignoring it under provider %r (persistence still active).",
                settings.provider,
            )

    config = _build_config(settings, thread_id=thread_id, restore_from=restore_from)
    if config is None:
        # No usable per-thread store (no thread_id, build failure, or a
        # capability gap slipping past the guard). Skip checkpointing entirely.
        return {}

    return {"from_checkpoint": config}

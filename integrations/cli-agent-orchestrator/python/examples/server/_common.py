"""Shared helpers + mode selection for the keyless CAO AG-UI example server.

This server ships **two** keyless backends for the same four Dojo features:

* **projection** (default when the ``cao`` extra is installed) — each route is a
  thin call into CAO's *merged* run plane
  (``cli_agent_orchestrator.services.agui.run_plane.run_plane_stream``). The run
  plane is the single authority for frame shape and the interrupt lifecycle;
  this module only supplies the deterministic fleet fixtures a real CAO server
  would supply from live processes. This is the high-fidelity, dogfooded path.
* **mock** (zero-dependency fallback) — self-contained emitters in ``_mock.py``
  hand-roll the same AG-UI frames from ``ag_ui.core``/``ag_ui.encoder`` with no
  ``cli-agent-orchestrator`` dependency at all, so the example server (and the
  keyless CI matrix) runs even where the CAO ``[agui]`` extra is not installed.

Selection is automatic (projection if CAO is importable, else mock) and can be
forced with ``CAO_AGUI_MODE=projection|mock`` (default ``auto``).
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional

from fastapi import Request
from fastapi.responses import StreamingResponse

CANONICAL_REPO = "https://github.com/awslabs/cli-agent-orchestrator"

# --- Optional projection backend -------------------------------------------
# The projection path needs CAO's merged run plane, shipped in the
# ``cli-agent-orchestrator[agui]`` extra (pinned in pyproject.toml). It is
# optional: when absent we fall back to the self-contained mock, so a bare
# install (ag-ui-protocol + fastapi + uvicorn) still serves every feature.
try:  # pragma: no cover - import availability is environment-dependent
    from cli_agent_orchestrator.services.agui.run_plane import (  # noqa: F401
        AG_UI_AVAILABLE,
        get_run_plane_content_type,
        run_plane_stream,
    )

    CAO_PROJECTION_AVAILABLE = True
except Exception:  # ImportError (extra absent) or any load-time failure
    CAO_PROJECTION_AVAILABLE = False
    AG_UI_AVAILABLE = False
    get_run_plane_content_type = None  # type: ignore[assignment]
    run_plane_stream = None  # type: ignore[assignment]


def resolve_mode() -> str:
    """Return the effective backend for this process: ``projection`` or ``mock``.

    ``CAO_AGUI_MODE`` env: ``auto`` (default) picks projection when CAO is
    importable, otherwise mock; ``projection``/``mock`` force a backend.
    Forcing ``projection`` without the ``cao`` extra installed is an error.
    """
    requested = os.getenv("CAO_AGUI_MODE", "auto").strip().lower()
    if requested == "mock":
        return "mock"
    if requested == "projection":
        if not CAO_PROJECTION_AVAILABLE:
            raise RuntimeError(
                "CAO_AGUI_MODE=projection but cli-agent-orchestrator[agui] is not "
                "installed. Install the 'cao' extra (uv sync --extra cao) or use "
                "CAO_AGUI_MODE=mock."
            )
        return "projection"
    return "projection" if CAO_PROJECTION_AVAILABLE else "mock"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def interpret_resume(entry: Any) -> Dict[str, Any]:
    """Normalize one AG-UI resume entry into an explicit approve/deny decision.

    Two producers reach this code with two different shapes for the *same*
    decision, so neither ``status`` nor ``payload`` alone is sufficient:

    * The Dojo interrupt picker resolves through CopilotKit's ``resolve(payload)``
      (v2 ``useInterrupt``), which **always** sets ``status="resolved"`` and
      carries the user's choice in ``payload``. An approval is a chosen slot
      (``{"chosen_time": ...}``); a denial is ``{"cancelled": true}``. The Cancel
      button routes through ``resolve`` too, so a denial arrives as
      ``status="resolved"`` — which is why a status-only check reports "granted"
      for a cancel.
    * The contract tests use the ``cancel()`` shape (``status="cancelled"`` with
      no payload) for a denial and ``{"approved": true}`` for an approval.

    **Deny is the default — this fails closed.** Because the decision gates a
    permission prompt, a resume counts as an approval ONLY on an explicit
    positive signal (``payload.approved is True`` or a recognized affirmative
    slot such as ``chosen_time``). Everything else — an explicit cancel, an
    empty or malformed payload, or an unrecognized future producer shape —
    resolves as a **denial**, so an ambiguous answer can never silently grant a
    permission. Returns ``{"approved": bool, "status": str}`` where ``status``
    follows AG-UI ``ResumeEntry`` semantics (``resolved`` / ``cancelled``).
    """
    if isinstance(entry, dict):
        status = entry.get("status")
        payload = entry.get("payload")
    else:
        status = getattr(entry, "status", None)
        payload = getattr(entry, "payload", None)
    if not isinstance(payload, dict):
        payload = {}
    explicit_cancel = (
        status == "cancelled"
        or bool(payload.get("cancelled"))
        or payload.get("approved") is False
    )
    positive_signal = payload.get("approved") is True or bool(payload.get("chosen_time"))
    approved = positive_signal and not explicit_cancel
    return {"approved": approved, "status": "resolved" if approved else "cancelled"}


def rec(
    kind: str,
    *,
    terminal_id: Optional[str] = None,
    session_name: str = "cao-demo",
    detail: Optional[Dict[str, Any]] = None,
    ui: Optional[Dict[str, Any]] = None,
    record_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a CAO event record in the exact shape ``to_agui_event`` consumes.

    The six-primitive vocabulary (``launch | completion | handoff |
    a2a_delegation | file_mod | error``) plus an optional agent-authored ``ui``
    intent is all the L1 adapter reads. Message bodies are never included — the
    privacy boundary is inherited from the mapper by construction.
    """
    record: Dict[str, Any] = {
        "id": record_id or str(uuid.uuid4()),
        "kind": kind,
        "timestamp": now_iso(),
        "session_name": session_name,
        "terminal_id": terminal_id,
        "detail": detail or {},
    }
    if ui is not None:
        record["ui"] = ui
    return record


def make_bus(records: List[Dict[str, Any]]) -> Callable[[], AsyncGenerator[Dict[str, Any], None]]:
    """Return a zero-arg async-iterator factory yielding ``records`` then stopping."""

    async def _subscribe() -> AsyncGenerator[Dict[str, Any], None]:
        for record in records:
            yield record

    return _subscribe


async def run_response(
    request: Request, *, body: Optional[Dict[str, Any]] = None, **run_kwargs: Any
) -> StreamingResponse:
    """Stream ``run_plane_stream`` for one request as a stock AG-UI SSE response.

    Pass ``body`` when the caller has already parsed (and possibly normalized)
    the request body; otherwise it is read here. Only valid in projection mode;
    ``run_plane_stream`` is ``None`` otherwise.
    """
    if not CAO_PROJECTION_AVAILABLE:  # pragma: no cover - guarded by resolve_mode
        raise RuntimeError("run_response requires the CAO projection backend")
    if body is None:
        body = await request.json()
    accept = request.headers.get("accept")
    run_kwargs.setdefault("heartbeat_interval", 30.0)
    return StreamingResponse(
        run_plane_stream(body, accept=accept, **run_kwargs),
        media_type=get_run_plane_content_type(accept),
    )


def fleet_snapshot() -> Dict[str, Any]:
    """A deterministic fleet ``STATE_SNAPSHOT`` payload (metadata only)."""
    return {
        "sessions": [{"name": "cao-demo", "provider_mix": ["mock_cli"]}],
        "terminals": [
            {
                "terminal_id": "t-supervisor",
                "agent_name": "code_supervisor",
                "provider": "mock_cli",
                "status": "running",
            },
            {
                "terminal_id": "t-worker",
                "agent_name": "developer",
                "provider": "mock_cli",
                "status": "running",
            },
        ],
        "last_file_mod": None,
    }


# --- Agentic generative UI: the fleet lifecycle as a step list ---------------
# The Dojo's shared ``agentic_generative_ui`` page renders
# ``state.steps[] = {description, status}`` and nothing else. Every other
# integration fills that contract with a plan an LLM *invented* (the page's own
# suggestions are "a plan to go to mars in 5 steps"). Here each step corresponds
# 1:1 to a real CAO fleet record kind, so the progress bar tracks genuine
# orchestration work rather than a hypothetical. The mapping is the point:
#
#   step 0 -> launch      (supervisor terminal created)
#   step 1 -> handoff     (supervisor delegates to the developer worker)
#   step 2 -> file_mod    (the worker edits a file)
#   step 3 -> handoff     (developer hands off to the reviewer)
#   step 4 -> completion  (worker terminal retired)
#
# Metadata only, like every other frame this server emits: descriptions name
# agents, providers and paths, never command output or message bodies.
FLEET_STEPS: List[str] = [
    "Launching code_supervisor on mock_cli",
    "Delegating implementation to the developer worker",
    "developer editing src/config.ts",
    "Handing off to the reviewer for correctness",
    "Retiring the developer terminal",
]


def steps_state(completed: int) -> Dict[str, Any]:
    """Project the fleet lifecycle as the Dojo's ``steps`` state.

    ``completed`` is clamped to ``[0, len(FLEET_STEPS)]``. Statuses use the two
    values the shared page understands — ``completed`` and ``pending`` — so the
    page's progress bar and current-step highlight work with no frontend change.
    """
    done = max(0, min(int(completed), len(FLEET_STEPS)))
    return {
        "steps": [
            {"description": description, "status": "completed" if index < done else "pending"}
            for index, description in enumerate(FLEET_STEPS)
        ]
    }


__all__ = [
    "AG_UI_AVAILABLE",
    "CAO_PROJECTION_AVAILABLE",
    "CANONICAL_REPO",
    "FLEET_STEPS",
    "fleet_snapshot",
    "interpret_resume",
    "make_bus",
    "rec",
    "resolve_mode",
    "run_response",
    "steps_state",
]

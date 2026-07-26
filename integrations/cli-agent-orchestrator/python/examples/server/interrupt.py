"""Interrupt feature — the flagship differentiator.

Projection mode: a mock_cli worker hits a permission prompt; CAO's
``AgentHandoffWithApproval`` construct opens an ``Interrupt`` and the run plane
closes the run with ``RUN_FINISHED outcome={type:"interrupt", interrupts:[…]}``.
The client answers by re-running with ``resume:[…]``, which CAO resolves
idempotently against the waiting process — genuinely exercising CAO's interrupt
registry and run-plane code path (a no-op delivery stands in for the tmux paste,
so it stays keyless).

Mock mode: a self-contained reproduction of the same interrupt -> resume ->
success lifecycle with no CAO dependency.

Either way this is the round-trip no API-wrapper integration can do: approve or
deny a live permission prompt from the browser through AG-UI's standard
interrupt lifecycle. The raw prompt body never reaches the wire (metadata only).
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import FastAPI, Request

from . import _mock
from ._common import fleet_snapshot, interpret_resume, resolve_mode, run_response

_SESSION = "cao-interrupt"

# Lazily-built CAO construct (projection mode only) so importing this module
# never requires the cli-agent-orchestrator extra.
_construct: Any = None
_thread_interrupt: Dict[str, str] = {}
# This module runs as an always-on Render web service, so cap the per-thread
# interrupt map to keep it from growing forever.
_MAX_THREADS = 1000


def _get_construct() -> Any:
    global _construct
    if _construct is None:
        from cli_agent_orchestrator.services.agui.base import RecordingUiEmitter
        from cli_agent_orchestrator.services.agui.handoff_approval import (
            AgentHandoffWithApproval,
        )

        class _NoopDelivery:
            """Keyless stand-in for tmux answer delivery."""

            def send_input(self, terminal_id: str, text: str, **kwargs: Any) -> None:
                return None

            def send_special_key(self, terminal_id: str, key: str) -> bool:
                return True

        _construct = AgentHandoffWithApproval(RecordingUiEmitter(), answer_delivery=_NoopDelivery())
    return _construct


def _ensure_pending(thread_id: str) -> None:
    construct = _get_construct()
    existing_id = _thread_interrupt.get(thread_id)
    existing = construct.get_interrupt(existing_id) if existing_id else None
    if existing is not None and not existing.resolved:
        return
    # Evict the resolved/stale id before opening a replacement, so the map holds
    # at most one entry per thread and re-inserts this thread as most-recent.
    _thread_interrupt.pop(thread_id, None)
    interrupt = construct.on_provider_waiting(
        terminal_id=f"{thread_id}:mock",
        provider="mock_cli",
        raw_prompt="Allow mock_cli to run `rm -rf build/`? [y/n]",
        session_name=_SESSION,
    )
    _thread_interrupt[thread_id] = interrupt.id
    # Bound total growth: drop the oldest entries once over the cap (dict
    # preserves insertion order, so the first key is the oldest).
    while len(_thread_interrupt) > _MAX_THREADS:
        _thread_interrupt.pop(next(iter(_thread_interrupt)), None)


def _normalize_resume_entry(entry: Any) -> Any:
    """Rewrite a wire resume entry into the approve/deny shape CAO's run plane
    accepts.

    The Dojo picker sends an ambiguous payload (a raw ``{"chosen_time": ...}`` on
    approve, or ``status="resolved"`` + ``{"cancelled": true}`` on Cancel); the
    run plane closes such a run with ``RUN_ERROR``. The contract tests prove CAO
    resolves cleanly for ``status="resolved"`` + ``{"approved": true}`` (approve)
    and ``status="cancelled"`` (deny), so we map the picker's decision onto those
    proven shapes. ``interruptId`` (and any other keys) are preserved.
    """
    if not isinstance(entry, dict):
        return entry
    decision = interpret_resume(entry)
    normalized = {k: v for k, v in entry.items() if k not in ("status", "payload")}
    normalized["status"] = decision["status"]
    if decision["approved"]:
        normalized["payload"] = {"approved": True}
    return normalized


app = FastAPI(title="CAO — interrupt")


@app.post("/")
async def run(request: Request):
    if resolve_mode() == "mock":
        return await _mock.interrupt(request)
    body = await request.json()
    thread_id = str(body.get("threadId") or body.get("thread_id") or "default")
    resume = body.get("resume") or []
    if not resume:
        _ensure_pending(thread_id)
    else:
        # Normalize the picker payload so CAO resolves the interrupt instead of
        # erroring on an unrecognized answer shape.
        body["resume"] = [_normalize_resume_entry(entry) for entry in resume]
    return await run_response(
        request, body=body, approval_construct=_get_construct(), snapshot_fn=fleet_snapshot
    )

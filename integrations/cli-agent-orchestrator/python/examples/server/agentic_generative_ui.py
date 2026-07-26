"""Agentic Generative UI feature — the fleet's own lifecycle as the step list.

This is the Dojo building block where the frontend renders from the agent's
**evolving state** rather than per tool call. Every other integration satisfies
it with a plan an LLM invented (the shared page's suggestions are "a plan to go
to mars in 5 steps"). CAO does not have to invent one: a fleet of real OS
processes already progresses through discrete, observable steps, and the six
record primitives (``launch | handoff | a2a_delegation | file_mod | completion |
error``) already describe them. See ``_common.FLEET_STEPS`` for the 1:1 mapping.

Projection mode: the record bus drives the genuine lifecycle frames the run
plane produces from those records — ``STEP_STARTED``/``STEP_FINISHED`` for
``launch``/``completion``, ``TOOL_CALL_*`` for each ``handoff``, and an RFC-6902
``STATE_DELTA`` for the ``file_mod`` — while ``snapshot_fn`` supplies the
``steps`` projection the shared page reads.

  Known constraint, stated plainly: the run plane calls ``snapshot_fn`` **once**
  per run, so a single run carries one ``STATE_SNAPSHOT``. Step *statuses*
  therefore advance one step per turn here rather than animating inside a turn.
  A within-run progressive projection needs a generic state-delta projection in
  CAO (today only ``file_mod`` maps to ``STATE_DELTA``), which is
  awslabs/cli-agent-orchestrator#519 territory, not this PR's.

Mock mode: emits the progressive snapshot sequence the shared page was built
for, with no ``cli-agent-orchestrator`` dependency. This is the path the Dojo
launcher, the keyless CI matrix and the hosted demo all pin, so the visible
demo animates.

Metadata only in both modes — no command output, no message bodies.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import FastAPI, Request

from . import _mock
from ._common import FLEET_STEPS, fleet_snapshot, make_bus, rec, resolve_mode, run_response, steps_state

_SESSION = "cao-agentic-generative-ui"

# One record per step, in FLEET_STEPS order, so the frames the run plane emits
# and the step list the page renders describe the same work.
_RECORDS = [
    rec("launch", terminal_id="t-supervisor", session_name=_SESSION,
        detail={"agent_name": "code_supervisor", "provider": "mock_cli", "event_type": "post_create_terminal"}),
    rec("handoff", terminal_id="t-supervisor", session_name=_SESSION,
        detail={"sender": "t-supervisor", "receiver": "t-worker", "orchestration_type": "assign", "event_type": "post_send_message"}),
    rec("file_mod", terminal_id="t-worker", session_name=_SESSION,
        detail={"path": "src/config.ts", "event_type": "file_modified"}),
    rec("handoff", terminal_id="t-worker", session_name=_SESSION,
        detail={"sender": "t-worker", "receiver": "t-reviewer", "orchestration_type": "handoff", "event_type": "post_send_message"}),
    rec("completion", terminal_id="t-worker", session_name=_SESSION,
        detail={"agent_name": "developer", "event_type": "post_kill_terminal"}),
]

# Per-thread progress. This module runs as an always-on Render web service, so
# the map is bounded exactly as interrupt.py bounds its interrupt registry.
_thread_progress: Dict[str, int] = {}
_MAX_THREADS = 1000


def _advance(thread_id: str) -> int:
    """Return the completed-step count for this turn, advancing by one.

    Wraps back to a single completed step once the fleet has finished, so a
    reviewer clicking repeatedly sees the run replay rather than a stuck bar.
    """
    # Evict before re-inserting so an active thread is refreshed as most-recent
    # rather than aging out under its own updates.
    completed = _thread_progress.pop(thread_id, 0) + 1
    if completed > len(FLEET_STEPS):
        completed = 1
    _thread_progress[thread_id] = completed
    while len(_thread_progress) > _MAX_THREADS:
        _thread_progress.pop(next(iter(_thread_progress)), None)
    return completed


app = FastAPI(title="CAO — agentic_generative_ui")


@app.post("/")
async def run(request: Request):
    if resolve_mode() == "mock":
        return await _mock.agentic_generative_ui(request)
    body = await request.json()
    thread_id = str(body.get("threadId") or body.get("thread_id") or "default")
    completed = _advance(thread_id)

    def _snapshot() -> Dict[str, Any]:
        # Fleet topology and the step projection travel in the same snapshot,
        # because the run plane emits exactly one per run.
        return {**fleet_snapshot(), **steps_state(completed)}

    return await run_response(
        request, body=body, snapshot_fn=_snapshot, bus_subscribe_fn=make_bus(_RECORDS)
    )

"""Human-in-the-Loop feature — a declarative approval affordance.

Projection mode: a fleet worker authors an allow-listed ``approval_card``
generative-UI intent; the run plane projects it to a stock ``CUSTOM`` frame
(``name="cao.generative_ui"``). Mock mode: the ``generate_task_steps`` tool-call
contract for user approval. For the bidirectional round-trip against a live CLI
permission prompt, see ``interrupt.py`` (the flagship).
"""

from __future__ import annotations

from fastapi import FastAPI, Request

from . import _mock
from ._common import fleet_snapshot, make_bus, rec, resolve_mode, run_response

_SESSION = "cao-human-in-the-loop"

_RECORDS = [
    rec("launch", terminal_id="t-worker", session_name=_SESSION,
        detail={"agent_name": "developer", "provider": "mock_cli", "event_type": "post_create_terminal"}),
    rec("other", terminal_id="t-worker", session_name=_SESSION,
        ui={
            "component": "approval_card",
            "props": {
                "interrupt_id": "demo-hitl",
                "reason": "mock_cli:approval_request",
                "message": "Approve running the build step?",
                "options": ["approve", "deny", "edit"],
                "provider": "mock_cli",
                "terminal_id": "t-worker",
            },
        }),
]

app = FastAPI(title="CAO — human_in_the_loop")


@app.post("/")
async def run(request: Request):
    if resolve_mode() == "mock":
        return await _mock.human_in_the_loop(request)
    return await run_response(request, snapshot_fn=fleet_snapshot, bus_subscribe_fn=make_bus(_RECORDS))

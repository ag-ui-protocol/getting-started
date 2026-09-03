"""Agentic Chat feature — a baseline CAO run.

Projection mode: a single mock_cli worker turn through the run plane
(``RUN_STARTED -> STATE_SNAPSHOT -> STEP_* -> RUN_FINISHED(success)``).
Mock mode: a self-contained streamed assistant message. Keyless either way.
"""

from __future__ import annotations

from fastapi import FastAPI, Request

from . import _mock
from ._common import fleet_snapshot, make_bus, rec, resolve_mode, run_response

_SESSION = "cao-agentic-chat"

_RECORDS = [
    rec("launch", terminal_id="t-worker", session_name=_SESSION,
        detail={"agent_name": "assistant", "provider": "mock_cli", "event_type": "post_create_terminal"}),
    rec("handoff", terminal_id="t-worker", session_name=_SESSION,
        detail={"sender": "t-worker", "receiver": "user", "orchestration_type": "send_message", "event_type": "post_send_message"}),
    rec("completion", terminal_id="t-worker", session_name=_SESSION,
        detail={"agent_name": "assistant", "event_type": "post_kill_terminal"}),
]

app = FastAPI(title="CAO — agentic_chat")


@app.post("/")
async def run(request: Request):
    if resolve_mode() == "mock":
        return await _mock.agentic_chat(request)
    return await run_response(request, snapshot_fn=fleet_snapshot, bus_subscribe_fn=make_bus(_RECORDS))

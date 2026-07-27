"""Durability guarantee for the wire->native map.

The reconciliation design records the ``{wire_tool_call_id: native_toolUseId}``
map on the Strands agent's session state so a continuation run — even on a
different process — can find the persisted placeholder. That only works if
Strands actually persists agent state to the durable store after a run that
executed a tool. This drives a REAL ``strands.Agent`` with a REAL
``FileSessionManager`` and a stub model (no network) to prove it end to end.
"""

from __future__ import annotations

import pytest
from strands import Agent
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager
from strands.tools.tools import PythonAgentTool

from ag_ui_strands.session_reconcile import AG_UI_WIRE_MAP_STATE_KEY


class _StubModel(Model):
    """Emits a tool call on turn 1, then a final text answer on turn 2."""

    def __init__(self):
        self._turn = 0

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt, **kwargs):
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self._turn += 1
        if self._turn == 1:
            yield {"messageStart": {"role": "assistant"}}
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": "native-xyz", "name": "approveTool"}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockDelta": {"delta": {"text": "Done."}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


def _proxy_func(tool_use, **_kwargs):
    return {
        "toolUseId": tool_use["toolUseId"],
        "status": "success",
        "content": [{"text": "Forwarded to client"}],
    }


_proxy_func.__name__ = "approveTool"


@pytest.mark.asyncio
async def test_agent_state_wire_map_persists_across_a_tool_using_run(tmp_path):
    sm = FileSessionManager(session_id="s1", storage_dir=str(tmp_path))
    tool = PythonAgentTool(
        tool_name="approveTool",
        tool_spec={"name": "approveTool", "description": "x", "inputSchema": {"json": {}}},
        tool_func=_proxy_func,
    )
    agent = Agent(model=_StubModel(), tools=[tool], session_manager=sm, agent_id="default")

    agent.state.set(AG_UI_WIRE_MAP_STATE_KEY, {"wire-1": "native-xyz"})

    # Consume to completion — models the adapter's frontend-tool halt drain,
    # which lets the invocation finish so AfterInvocationEvent -> sync_agent runs.
    async for _ in agent.stream_async("please approve"):
        pass

    # Read the map back from the DURABLE store (fresh repository read).
    persisted = sm.session_repository.read_agent("s1", "default")
    assert persisted is not None
    assert persisted.state.get(AG_UI_WIRE_MAP_STATE_KEY) == {"wire-1": "native-xyz"}

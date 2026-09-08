"""Durability guarantee for the frontend-call id store.

The reconciliation design records the id of every frontend call on the Strands
agent's session state so a continuation run, even on a different process, can
tell that the returning result is the client's and correct the persisted
placeholder. That only works if Strands actually persists agent state to the
durable store after a run that executed a tool. This drives a REAL
``strands.Agent`` with a REAL ``FileSessionManager`` and a stub model (no
network) to prove it end to end.
"""

from __future__ import annotations

import pytest
from strands import Agent
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager
from strands.tools.tools import PythonAgentTool

from ag_ui_strands.client_proxy_tool import PROXY_RESULT_PLACEHOLDER
from ag_ui_strands.session_reconcile import AG_UI_FRONTEND_CALL_IDS_STATE_KEY


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


def _make_proxy_func(agent_holder):
    """Record the call id from inside the tool, the way emission does."""

    def _proxy_func(tool_use, **_kwargs):
        agent_holder["agent"].state.set(
            AG_UI_FRONTEND_CALL_IDS_STATE_KEY, [tool_use["toolUseId"]]
        )
        return {
            "toolUseId": tool_use["toolUseId"],
            "status": "success",
            "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
        }

    return _proxy_func


@pytest.mark.asyncio
async def test_recorded_call_ids_persist_across_a_tool_using_run(tmp_path):
    sm = FileSessionManager(session_id="s1", storage_dir=str(tmp_path))
    agent_holder: dict = {}
    proxy_func = _make_proxy_func(agent_holder)
    proxy_func.__name__ = "approveTool"
    tool = PythonAgentTool(
        tool_name="approveTool",
        tool_spec={"name": "approveTool", "description": "x", "inputSchema": {"json": {}}},
        tool_func=proxy_func,
    )
    agent = Agent(model=_StubModel(), tools=[tool], session_manager=sm, agent_id="default")
    agent_holder["agent"] = agent

    # Consume to completion. The adapter itself does NOT run the invocation to
    # completion on a frontend-tool halt (it stops the loop — see
    # test_frontend_tool_halt_stops_loop.py); it does not need to, because
    # MessageAddedEvent drives sync_agent as well as append_message, so agent
    # state is already durable by the time the halt latches. Consuming fully
    # here just keeps this test focused on the persistence guarantee.
    async for _ in agent.stream_async("please approve"):
        pass

    # The guarantee is about a run that USED a tool. Agent state also flushes
    # on the opening user turn, so without pinning that the tool actually ran
    # this passes for a stub that never calls one, and stops testing what it
    # is named for.
    persisted_messages = [
        message.message
        for message in sm.session_repository.list_messages("s1", "default")
    ]
    tool_results = [
        block["toolResult"]
        for message in persisted_messages
        for block in message.get("content") or []
        if isinstance(block, dict) and "toolResult" in block
    ]
    assert [result["toolUseId"] for result in tool_results] == ["native-xyz"]

    # Read the ids back from the DURABLE store (fresh repository read).
    persisted = sm.session_repository.read_agent("s1", "default")
    assert persisted is not None
    assert persisted.state.get(AG_UI_FRONTEND_CALL_IDS_STATE_KEY) == ["native-xyz"]

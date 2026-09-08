"""Regression test for issue #1582.

The client supplies a ``run_id`` on ``RunAgentInput``. The protocol
RUN_STARTED and RUN_FINISHED events must both carry that exact client
run_id so the client can correlate the run it started with the run that
finished.

Previously the streaming loop overwrote ``self.active_run["id"]`` with
LangGraph's internal chain ``run_id`` taken off each streamed event. As a
result RUN_STARTED (emitted before the loop) carried the client id while
RUN_FINISHED (emitted after the loop) carried LangGraph's chain UUID — the
two disagreed and the client id was lost.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from ag_ui.core import EventType, RunAgentInput
from ag_ui_langgraph.agent import LangGraphAgent


def _make_agent():
    from langgraph.graph.state import CompiledStateGraph

    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    graph.nodes = {}
    initial_state = MagicMock()
    initial_state.values = {"messages": [], "copilotkit": {}}
    initial_state.tasks = []
    initial_state.next = []
    initial_state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=initial_state)
    return LangGraphAgent(name="test", graph=graph)


def _event(event_type, run_id, node="model", data=None):
    return {
        "event": event_type,
        "run_id": run_id,
        "metadata": {"langgraph_node": node},
        "data": data or {},
        "name": node,
        "parent_ids": [],
        "tags": [],
    }


async def _run_stream(client_run_id, chain_run_id):
    agent = _make_agent()
    dispatched = []

    original_dispatch = agent._dispatch_event

    def capturing_dispatch(ev):
        result = original_dispatch(ev)
        dispatched.append(ev)
        return result

    agent._dispatch_event = capturing_dispatch

    events = [
        _event("on_chain_start", chain_run_id, node="model"),
        _event(
            "on_chain_end",
            chain_run_id,
            node="model",
            data={"output": {"messages": []}, "input": {}},
        ),
    ]

    async def fake_stream():
        for ev in events:
            yield ev

    final_state = MagicMock()
    final_state.values = {"messages": [], "copilotkit": {}}
    final_state.tasks = []
    final_state.next = []
    final_state.metadata = {"writes": {}}

    mock_prepared = {
        "state": {"messages": [], "copilotkit": {}},
        "stream": fake_stream(),
        "config": {"configurable": {"thread_id": "t1"}},
    }

    def fake_get_state_snapshot(state):
        if isinstance(state, dict):
            return state
        return getattr(state, "values", {}) or {}

    with patch.object(agent, "prepare_stream", AsyncMock(return_value=mock_prepared)), \
         patch.object(agent.graph, "aget_state", AsyncMock(return_value=final_state)), \
         patch.object(agent, "get_state_snapshot", side_effect=fake_get_state_snapshot):

        input_data = RunAgentInput(
            thread_id="t1",
            run_id=client_run_id,
            messages=[],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        async for _ in agent._handle_stream_events(input_data):
            pass

    return dispatched


class TestRunIdPreservation(unittest.IsolatedAsyncioTestCase):
    async def test_run_started_and_finished_carry_client_run_id(self):
        client_run_id = "client-run-1582"
        chain_run_id = "00000000-0000-4000-8000-000000000000"

        dispatched = await _run_stream(client_run_id, chain_run_id)

        started = [e for e in dispatched if getattr(e, "type", None) == EventType.RUN_STARTED]
        finished = [e for e in dispatched if getattr(e, "type", None) == EventType.RUN_FINISHED]

        self.assertEqual(len(started), 1, "expected exactly one RUN_STARTED")
        self.assertEqual(len(finished), 1, "expected exactly one RUN_FINISHED")

        self.assertEqual(started[0].run_id, client_run_id)
        self.assertEqual(
            finished[0].run_id,
            client_run_id,
            "RUN_FINISHED must carry the client run_id, not LangGraph's chain run_id",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

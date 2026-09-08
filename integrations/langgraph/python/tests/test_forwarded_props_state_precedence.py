"""Tests for forwardedProps -> graph-state precedence (CopilotKit#3168).

The bug: ``prepare_stream`` built the graph input as
``{**forwarded_props, **payload_input}``, so the client's synced state won
every collision. On the first run of a thread the client state carries no
graph keys yet, so a forwarded value landed in the input and worked. From the
second run onward the client echoes back the STATE_SNAPSHOT it received, which
carries every key the graph wrote, and that stale value silently replaced the
forwarded one. Identical ``forwardedProps`` therefore produced a different
graph input on run 1 and run 2.

The fix states one rule: forwardedProps that the adapter does not own itself
hydrate graph state and win over the synced snapshot, on every run; the
adapter-owned props never enter graph state at all.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui_langgraph.utils import ADAPTER_OWNED_FORWARDED_PROPS

from tests._helpers import make_agent


def _make_agent_state():
    """A checkpoint state with no messages and no open interrupts."""
    state = MagicMock()
    state.values = {"messages": []}
    state.tasks = []
    state.next = []
    state.metadata = {"writes": {}}
    return state


def _make_input(state, forwarded_props):
    inp = MagicMock()
    inp.thread_id = "t1"
    inp.run_id = "r1"
    inp.state = dict(state)
    inp.messages = []
    inp.tools = []
    inp.context = []
    inp.resume = None
    inp.forwarded_props = forwarded_props
    return inp


async def _stream_input_for(
    state, forwarded_props, input_schema_keys=None, mode="start", node_name=None
):
    """Drive prepare_stream and return the input handed to the graph."""
    agent = make_agent()
    agent_state = _make_agent_state()
    agent.graph.aget_state = AsyncMock(return_value=agent_state)
    agent.graph.aupdate_state = AsyncMock(return_value=None)
    agent.graph.astream_events = MagicMock(return_value=iter([]))
    agent.active_run = {
        "id": "r1",
        "thread_id": "t1",
        "mode": mode,
        "node_name": node_name,
    }
    keys = ["messages", "tools", "command", "route_cmd"]
    if input_schema_keys is not None:
        keys = input_schema_keys
    agent.get_schema_keys = lambda config: {
        "input": keys,
        "output": keys,
        "config": [],
        "context": [],
    }

    await agent.prepare_stream(
        input=_make_input(state, forwarded_props),
        agent_state=agent_state,
        config={"configurable": {}},
    )
    return agent.graph.astream_events.call_args.kwargs["input"]


class TestForwardedPropsStatePrecedence(unittest.IsolatedAsyncioTestCase):

    async def test_forwarded_prop_hydrates_state_when_client_state_is_empty(self):
        """First run of a thread: the client has no state yet, so the forwarded
        value is the only source for the key."""
        stream_input = await _stream_input_for(
            state={}, forwarded_props={"route_cmd": "run_tool_call"}
        )
        self.assertEqual(stream_input["route_cmd"], "run_tool_call")

    async def test_forwarded_prop_survives_stale_synced_state(self):
        """The #3168 regression: the client echoes back the snapshot the graph
        wrote (here the node consumed the value and cleared it). The explicit
        per-run forwarded value must still reach the graph."""
        stream_input = await _stream_input_for(
            state={"route_cmd": None}, forwarded_props={"route_cmd": "run_tool_call"}
        )
        self.assertEqual(stream_input["route_cmd"], "run_tool_call")

    async def test_run_one_and_run_two_agree(self):
        """Identical forwardedProps must produce an identical value for the
        forwarded key, whatever the client's synced state holds."""
        forwarded = {"route_cmd": "run_tool_call"}
        first = await _stream_input_for(state={}, forwarded_props=forwarded)
        second = await _stream_input_for(
            state={"route_cmd": None}, forwarded_props=forwarded
        )
        self.assertEqual(first["route_cmd"], second["route_cmd"])

    async def test_state_key_without_forwarded_prop_is_untouched(self):
        """Keys the caller did not forward keep coming from the client state."""
        stream_input = await _stream_input_for(
            state={"route_cmd": "from_state"}, forwarded_props={}
        )
        self.assertEqual(stream_input["route_cmd"], "from_state")

    async def test_adapter_owned_props_never_enter_graph_state(self):
        """``command`` is the LangGraph-private resume slot, not graph state.
        Letting it through wrote a bogus ``command`` key into every graph's
        state and was the reason #3168 looked like it worked on run 1."""
        stream_input = await _stream_input_for(
            state={}, forwarded_props={"command": {"cmd": "run_tool_call"}}
        )
        self.assertNotIn("command", stream_input)

    async def test_adapter_owned_props_do_not_override_state(self):
        """A graph that genuinely declares a state key colliding with an
        adapter-owned prop keeps its own state value."""
        stream_input = await _stream_input_for(
            state={"command": "from_state"},
            forwarded_props={"command": {"cmd": "run_tool_call"}},
        )
        self.assertEqual(stream_input["command"], "from_state")

    async def test_merge_owned_channels_are_not_replaced(self):
        """``messages``/``tools`` are built by langgraph_default_merge_state.
        A forwarded prop must never replace them."""
        stream_input = await _stream_input_for(
            state={}, forwarded_props={"messages": ["bogus"], "tools": ["bogus"]}
        )
        self.assertEqual(stream_input["messages"], [])
        self.assertNotEqual(stream_input["tools"], ["bogus"])

    async def test_continue_mode_still_sends_no_input(self):
        """A "continue" run applies its state through aupdate_state and streams
        with no input, so the graph resumes instead of restarting. A forwarded
        prop must not turn that into a fresh input."""
        stream_input = await _stream_input_for(
            state={"route_cmd": None},
            forwarded_props={"route_cmd": "run_tool_call"},
            mode="continue",
            node_name="router",
        )
        self.assertIsNone(stream_input)


class TestAdapterOwnedForwardedPropsContract(unittest.TestCase):
    """Pin the deny-list against the props the adapter actually consumes.

    ``ADAPTER_OWNED_FORWARDED_PROPS`` is hand-maintained. If a new
    adapter-control prop is added to agent.py and not listed there, it would
    silently start being written into every graph's state — the exact defect
    #3168 reported. This test reads the source and fails on that omission.
    """

    def _adapter_source(self):
        from pathlib import Path

        import ag_ui_langgraph.agent as agent_module

        return Path(agent_module.__file__).read_text(encoding="utf-8")

    def test_every_consumed_prop_is_declared(self):
        import re

        source = self._adapter_source()
        consumed = set(
            re.findall(
                r"""forwarded(?:_props)?(?:\.get\(|\[)['"]([A-Za-z_][A-Za-z0-9_]*)['"]""",
                source,
            )
        )
        consumed |= set(
            re.findall(
                r"""['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s+in\s+forwarded(?:_props)?\b""",
                source,
            )
        )
        self.assertTrue(consumed, "found no forwarded-prop reads; regex is stale")
        undeclared = consumed - set(ADAPTER_OWNED_FORWARDED_PROPS)
        self.assertEqual(
            undeclared,
            set(),
            "agent.py consumes these forwardedProps but they are missing from "
            f"ADAPTER_OWNED_FORWARDED_PROPS: {sorted(undeclared)}",
        )

    def test_merge_owned_channels_are_declared(self):
        """langgraph_default_merge_state builds these; forwardedProps must not
        be able to overwrite them."""
        for key in ("messages", "tools", "ag-ui", "copilotkit"):
            self.assertIn(key, ADAPTER_OWNED_FORWARDED_PROPS)


if __name__ == "__main__":
    unittest.main()

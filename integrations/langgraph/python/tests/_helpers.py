"""Shared test helpers for ag-ui-langgraph integration tests.

These helpers build lightweight ``LangGraphAgent`` fixtures backed by
``MagicMock``/``AsyncMock`` stand-ins so tests can exercise agent logic in
isolation, without spinning up a real graph or hitting any network.
"""

from typing import Any, Iterable, List, Optional
from unittest.mock import AsyncMock, MagicMock

from langgraph.graph.state import CompiledStateGraph

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent


def make_agent(subgraph_names: Optional[Iterable[str]] = None, **agent_kwargs) -> LangGraphAgent:
    """Return a ``LangGraphAgent`` backed by a mock graph; each name in
    ``subgraph_names`` becomes a node whose ``bound`` is a
    ``CompiledStateGraph`` mock (how the agent detects subgraphs at
    construction). Extra keyword arguments are forwarded to ``LangGraphAgent``
    (e.g. ``emit_interrupt_outcome=True``)."""
    graph = MagicMock(spec=CompiledStateGraph)
    graph.config_specs = []
    nodes = {}
    names_iter: Iterable[str] = subgraph_names if subgraph_names is not None else []
    for name in names_iter:
        node = MagicMock()
        node.bound = MagicMock(spec=CompiledStateGraph)
        nodes[name] = node
    graph.nodes = nodes
    return LangGraphAgent(name="test", graph=graph, **agent_kwargs)


def _record_dispatch(agent: LangGraphAgent):
    """Replace ``agent._dispatch_event`` with a recording function.

    The installed function appends every dispatched event to
    ``agent.dispatched`` and returns the event unchanged so the rest of
    the agent's control flow (which expects the return value) still
    works. Using a named function instead of a lambda keeps tracebacks
    readable and makes the side effect explicit."""
    agent.dispatched = []

    def _dispatch(event):
        agent.dispatched.append(event)
        return event

    agent._dispatch_event = _dispatch
    return agent


def make_configured_agent(
    checkpoint_messages: List[Any],
    subgraph_names: Optional[Iterable[str]] = None,
) -> LangGraphAgent:
    """Build an agent with a mocked checkpoint and a recording dispatcher.

    The mocked ``graph.aget_state`` returns a state whose ``.values``
    carries ``checkpoint_messages`` under the ``messages`` key."""
    agent = make_agent(list(subgraph_names) if subgraph_names else ["hotels_agent"])
    agent.active_run = {
        "id": "run-1",
    }
    _record_dispatch(agent)
    agent.get_state_snapshot = MagicMock(return_value={})
    state = MagicMock()
    state.values = {"messages": checkpoint_messages}
    agent.graph.aget_state = AsyncMock(return_value=state)
    return agent


def snapshot_event(dispatched: List[Any]):
    """Return the first ``MESSAGES_SNAPSHOT`` event in a dispatched list.

    Raises ``AssertionError`` with the sequence of actually-dispatched
    event types when no snapshot is present, so test failures point
    directly at what was emitted."""
    for ev in dispatched:
        if getattr(ev, "type", None) == EventType.MESSAGES_SNAPSHOT:
            return ev
    dispatched_types = [getattr(e, "type", None) for e in dispatched]
    raise AssertionError(
        "no MESSAGES_SNAPSHOT dispatched; got: "
        f"{dispatched_types!r}"
    )

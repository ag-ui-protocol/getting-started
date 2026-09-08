"""A run that raises must still report ``RUN_ERROR`` before it propagates.

``concepts/events.mdx``:

> The ``RunStarted`` and either ``RunFinished`` or ``RunError`` events are
> mandatory, forming the boundaries of an agent run.

``_stream_run_events`` emits ``RUN_ERROR`` for one case only: an upstream
``error`` event out of ``astream_events``. Anything *raised* inside the run
-- a provider fault, a checkpointer failure, ``GraphRecursionError`` from
Pregel, a bug in user middleware -- used to leave the generator without one.
The generator died, the caller's ``async for`` stopped, and the stream ended
with no terminal event of any kind.

A client rendering from the event stream cannot tell that apart from a
completed run: ``verifyEvents`` rejects illegal events that are *sent*, and a
stream that ends sends nothing to reject (#2300). The same defect class was
reported for the Mastra integration in #2416.

The exception is still re-raised after the event, so callers that treat a
raised failure as a failure keep working unchanged; ``TestAgetStateMidStreamError``
in ``test_subgraph_streaming.py`` pins that invariant.

``CancelledError`` is deliberately not covered: it is a ``BaseException``, so
it never reaches the handler. A caller that walked away is not owed an error
event, and reporting the cancellation as a run failure would be a lie.
"""

import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock

from ag_ui.core import EventType, RunAgentInput, UserMessage

from tests._helpers import make_agent

TERMINAL = {EventType.RUN_FINISHED, EventType.RUN_ERROR}


def _make_state(messages):
    state = MagicMock()
    state.values = {"messages": messages}
    state.tasks = []
    state.next = []
    state.metadata = {"writes": {}}
    return state


def _make_input():
    return RunAgentInput(
        thread_id="t1",
        run_id="run-1",
        messages=[UserMessage(id="u1", role="user", content="hi")],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    )


def _raising_stream(exc):
    """A stream that produces nothing and then fails, like a graph would."""

    async def stream():
        if False:  # pragma: no cover - keeps this an async generator
            yield None
        raise exc

    return stream()


class TestTerminalEventGuarantee(unittest.IsolatedAsyncioTestCase):
    async def _run(self, exc):
        """Drive a failing run; return the event types seen before it raised."""
        agent = make_agent()
        agent.graph.aget_state = AsyncMock(return_value=_make_state([]))
        agent.graph.astream_events = MagicMock(return_value=_raising_stream(exc))
        seen = []
        with self.assertRaises(type(exc)):
            async for event in agent.run(_make_input()):
                seen.append(event.type)
        return seen

    async def test_exception_inside_the_run_emits_run_error(self):
        seen = await self._run(RuntimeError("provider exploded"))

        self.assertTrue(seen, "the run produced no events at all")
        self.assertEqual(seen[-1], EventType.RUN_ERROR)

    async def test_terminal_event_is_emitted_exactly_once(self):
        seen = await self._run(RuntimeError("provider exploded"))

        self.assertEqual(len([kind for kind in seen if kind in TERMINAL]), 1)

    async def test_cancellation_gets_no_error_event(self):
        seen = await self._run(asyncio.CancelledError())

        self.assertNotIn(EventType.RUN_ERROR, seen)

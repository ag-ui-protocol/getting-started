"""Repro for OSS-28 / GitHub #1278.

Bug: "Conversation permanently broken when SSE stream drops before
MESSAGES_SNAPSHOT is emitted -- every subsequent turn raises ValueError."

Scenario from the issue:
  1. A turn completes server-side; the checkpoint now holds N messages.
  2. The SSE stream drops before MESSAGES_SNAPSHOT is delivered, so the
     client never learns the real (checkpoint) message IDs.
  3. On the next turn the client sends its known messages plus a NEW user
     message carrying a freshly generated UUID that was never persisted.
  4. ``len(checkpoint) > len(incoming)`` -> the old code routed into the
     regenerate path, which called ``get_checkpoint_before_message(fresh_uuid)``,
     walked all history, found nothing, and raised
     ``ValueError: Message ID not found in history`` -> 500 -> the client
     still never gets a MESSAGES_SNAPSHOT -> every later turn crashes the
     same way -> the thread is permanently broken.

These tests pin the post-fix behavior:

  * ``test_sse_drop_does_not_enter_regenerate_or_raise`` -- the recovery: the
    fresh-UUID count mismatch must NOT enter the regenerate path and must
    fall through to a normal continuation stream (no ValueError). This is the
    fix introduced by the regenerate guard ``last_user_id in checkpoint_ids``.

  * ``test_underlying_landmine_still_raises_for_unknown_id`` -- documents that
    the crash *site* still exists: calling regenerate with an id absent from
    history still raises. The guard is load-bearing precisely because it stops
    the SSE-drop case from ever reaching here.

  * ``test_genuine_edit_still_regenerates`` -- guard rails: a real edit (last
    user id IS in the checkpoint) must still take the regenerate path, so the
    fix did not disable legitimate regeneration.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage

from ag_ui.core import UserMessage

from tests._helpers import make_agent


def _make_state(messages):
    state = MagicMock()
    state.values = {"messages": messages}
    state.tasks = []
    state.next = []
    state.metadata = {"writes": {}}
    return state


def _make_input(messages, thread_id="t1", forwarded_props=None):
    inp = MagicMock()
    inp.thread_id = thread_id
    inp.messages = messages
    inp.state = {}
    inp.tools = []
    inp.context = []
    inp.run_id = "run-1"
    inp.forwarded_props = forwarded_props or {}
    inp.resume = None
    return inp


async def _empty_stream():
    if False:
        yield None


async def _async_iter(items):
    for item in items:
        yield item


class TestOSS28SSEDropRecovery(unittest.IsolatedAsyncioTestCase):
    async def test_sse_drop_does_not_enter_regenerate_or_raise(self):
        """The core OSS-28 repro: after an SSE drop the client resends with a
        fresh UUID the server never persisted. The checkpoint legitimately has
        more messages than the client sent, but this must be treated as a
        continuation -- NOT a regeneration -- and must not raise."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        # Server finished the previous turn: checkpoint has Human + AI.
        checkpoint_messages = [
            HumanMessage(id="h1", content="first question"),
            AIMessage(id="ai1", content="first answer"),
        ]
        state = _make_state(checkpoint_messages)

        # Client never received MESSAGES_SNAPSHOT, so on the next turn it only
        # sends the brand-new user message with a freshly generated UUID that
        # is NOT in the checkpoint. len(checkpoint)=2 > len(incoming)=1.
        frontend_messages = [
            UserMessage(id="fresh-uuid-never-persisted", role="user", content="second question"),
        ]
        inp = _make_input(frontend_messages, forwarded_props={})

        # Spy: regenerate must NOT be taken. If it raises we also catch the bug.
        agent.prepare_regenerate_stream = AsyncMock(
            side_effect=AssertionError("SSE-drop recovery must not enter regenerate")
        )
        agent.graph.astream_events.return_value = _empty_stream()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        self.assertIsNotNone(result.get("stream"))
        # The new turn must actually reach the stream, not be silently dropped:
        # the merged state carries the fresh-UUID message.
        streamed_ids = {
            getattr(m, "id", None) for m in result["state"].get("messages", [])
        }
        self.assertIn("fresh-uuid-never-persisted", streamed_ids)

    async def test_count_mismatch_all_incoming_in_checkpoint_is_continuation(self):
        """The motivating non-regeneration case: the client is behind (never
        received ai1) and resends only [h1] while the checkpoint holds
        [h1, ai1]. The count mismatches (2 > 1), but every incoming id is
        already in the checkpoint, so is_continuation short-circuits before the
        last-user-id check. A regression flipping issubset or dropping the
        truthiness precondition would wrongly regenerate here."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="first question"),
            AIMessage(id="ai1", content="first answer"),
        ]
        state = _make_state(checkpoint_messages)

        frontend_messages = [
            UserMessage(id="h1", role="user", content="first question"),
        ]
        inp = _make_input(frontend_messages, forwarded_props={})

        agent.prepare_regenerate_stream = AsyncMock(
            side_effect=AssertionError("a continuation must not enter regenerate")
        )
        agent.graph.astream_events.return_value = _empty_stream()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        self.assertIsNotNone(result.get("stream"))

    async def test_underlying_landmine_still_raises_for_unknown_id(self):
        """The crash site is unchanged: regenerating against an id absent from
        history still raises 'not found in history'. This is why the guard in
        prepare_stream (which the test above exercises) is load-bearing."""
        agent = make_agent()

        snapshot = MagicMock()
        snapshot.values = {"messages": [HumanMessage(id="h1", content="real")]}
        agent.graph.aget_state_history = lambda cfg: _async_iter([snapshot])

        with self.assertRaisesRegex(ValueError, "not found in history"):
            await agent.get_checkpoint_before_message(
                "fresh-uuid-never-persisted", "t1"
            )

    async def test_genuine_edit_still_regenerates(self):
        """Guard rail: a true edit/regenerate (last user id IS in the
        checkpoint) must still take the regenerate path. The OSS-28 fix must
        not disable legitimate regeneration."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="original"),
            AIMessage(id="ai1", content="answer"),
            HumanMessage(id="h2", content="regenerate from here"),
            AIMessage(id="ai2", content="second answer"),
        ]
        state = _make_state(checkpoint_messages)

        # Client edits an earlier turn: an incoming id (h-edited) is NOT in the
        # checkpoint (so this is not a plain continuation), while the LAST user
        # id (h2) IS in the checkpoint -- the genuine regenerate signal.
        frontend_messages = [
            UserMessage(id="h1", role="user", content="original"),
            UserMessage(id="h-edited", role="user", content="edited earlier turn"),
            UserMessage(id="h2", role="user", content="regenerate from here"),
        ]
        inp = _make_input(frontend_messages, forwarded_props={})

        prepared = {"stream": "regen", "state": {}, "config": {}}
        agent.prepare_regenerate_stream = AsyncMock(return_value=prepared)
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_awaited_once()
        self.assertIs(result, prepared)


if __name__ == "__main__":
    unittest.main()

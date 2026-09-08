"""Tests for prepare_regenerate_stream runtime-config preservation — fixes #1749.

The bug: ``prepare_regenerate_stream`` passes ``config=fork`` (the return
value of ``graph.aupdate_state``) straight into ``get_stream_kwargs`` and
on to ``astream_events``. The ``fork`` value only contains checkpoint
keys (``thread_id``, ``checkpoint_id``, ``checkpoint_ns``); runtime
settings from the caller's config -- notably ``recursion_limit`` and
``callbacks`` -- are silently discarded, and LangGraph stamps the
default ``recursion_limit=25``.

The fix merges the caller's config underneath the fork via
``merge_configs`` so checkpoint keys still win but runtime settings
survive the round trip.
"""

import unittest
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import HumanMessage

from tests._helpers import make_agent


def _make_input(thread_id="t1", forwarded_props=None):
    inp = MagicMock()
    inp.thread_id = thread_id
    inp.tools = []
    inp.forwarded_props = forwarded_props or {}
    return inp


def _fork_only_config():
    """Mirror what ``graph.aupdate_state`` actually returns: a config
    with only checkpoint-level ``configurable`` keys, no runtime keys."""
    return {
        "configurable": {
            "thread_id": "t1",
            "checkpoint_id": "cp-after-fork",
            "checkpoint_ns": "",
        }
    }


def _checkpoint_snapshot():
    snapshot = MagicMock()
    snapshot.config = {"configurable": {"thread_id": "t1", "checkpoint_id": "cp-before"}}
    snapshot.values = {"messages": [HumanMessage(id="h1", content="hi")]}
    snapshot.next = ("agent",)
    return snapshot


class TestPrepareRegenerateStreamPreservesRuntimeConfig(unittest.IsolatedAsyncioTestCase):
    """Regression tests: runtime config keys must survive regeneration."""

    async def test_recursion_limit_survives(self):
        """The caller sets ``recursion_limit=100``; after regeneration
        the value handed to ``astream_events`` must still be 100, not
        LangGraph's default of 25."""
        agent = make_agent()
        agent.get_checkpoint_before_message = AsyncMock(return_value=_checkpoint_snapshot())
        agent.graph.aupdate_state = AsyncMock(return_value=_fork_only_config())

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture
        agent.langgraph_default_merge_state = MagicMock(return_value={"messages": []})

        caller_config = {
            "recursion_limit": 100,
            "configurable": {"thread_id": "t1"},
        }
        message = HumanMessage(id="h1", content="hi")

        await agent.prepare_regenerate_stream(_make_input(), message, caller_config)

        self.assertIn("config", captured)
        self.assertEqual(captured["config"].get("recursion_limit"), 100)

    async def test_callbacks_survive(self):
        agent = make_agent()
        agent.get_checkpoint_before_message = AsyncMock(return_value=_checkpoint_snapshot())
        agent.graph.aupdate_state = AsyncMock(return_value=_fork_only_config())

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture
        agent.langgraph_default_merge_state = MagicMock(return_value={"messages": []})

        sentinel_callback = MagicMock(name="tracing-handler")
        caller_config = {
            "callbacks": [sentinel_callback],
            "configurable": {"thread_id": "t1"},
        }
        message = HumanMessage(id="h1", content="hi")

        await agent.prepare_regenerate_stream(_make_input(), message, caller_config)

        callbacks = captured["config"].get("callbacks") or []
        self.assertIn(sentinel_callback, callbacks)

    async def test_checkpoint_keys_still_win_for_thread_id(self):
        """The fork's checkpoint id must override anything the caller
        config carried under ``configurable``; otherwise the time-travel
        replay would target the wrong checkpoint."""
        agent = make_agent()
        agent.get_checkpoint_before_message = AsyncMock(return_value=_checkpoint_snapshot())
        fork = _fork_only_config()
        agent.graph.aupdate_state = AsyncMock(return_value=fork)

        captured = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        agent.graph.astream_events = _capture
        agent.langgraph_default_merge_state = MagicMock(return_value={"messages": []})

        caller_config = {
            "recursion_limit": 50,
            "configurable": {
                "thread_id": "t1",
                "checkpoint_id": "OLD-DO-NOT-USE",
            },
        }
        message = HumanMessage(id="h1", content="hi")

        await agent.prepare_regenerate_stream(_make_input(), message, caller_config)

        configurable = captured["config"]["configurable"]
        self.assertEqual(configurable["checkpoint_id"], "cp-after-fork")
        self.assertEqual(captured["config"]["recursion_limit"], 50)

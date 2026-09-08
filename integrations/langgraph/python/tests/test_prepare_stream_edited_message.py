"""Tests for prepare_stream edited-message detection — fixes #1748.

The bug: ``is_continuation`` in ``prepare_stream`` compares only message
ids, not content. When the user edits a previously-sent message and
resubmits with the same id but different content, ``is_continuation``
sees matching ids and skips regeneration — the checkpoint keeps the old
content and the edit is silently swallowed.

The fix adds ``_detect_edited_human_message``, which performs a content
comparison and routes to ``prepare_regenerate_stream`` whenever any
same-id ``HumanMessage`` was edited.
"""

import unittest
from dataclasses import dataclass, field
from typing import Any, List
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, HumanMessage

from ag_ui.core import EventType, UserMessage

from tests._helpers import make_agent


@dataclass
class FakeInterrupt:
    value: Any


@dataclass
class FakeTask:
    interrupts: List[FakeInterrupt] = field(default_factory=list)


def _make_state(messages, tasks=None):
    state = MagicMock()
    state.values = {"messages": messages}
    state.tasks = tasks or []
    return state


def _make_input(messages, thread_id="t1", forwarded_props=None):
    inp = MagicMock()
    inp.thread_id = thread_id
    inp.messages = messages
    inp.state = {}
    inp.tools = []
    inp.context = []
    inp.forwarded_props = forwarded_props or {}
    return inp


class TestDetectEditedHumanMessage(unittest.TestCase):
    """Direct tests for the ``_detect_edited_human_message`` helper."""

    def test_returns_none_for_empty_inputs(self):
        agent = make_agent()
        self.assertIsNone(agent._detect_edited_human_message([], []))

    def test_returns_none_when_content_unchanged(self):
        agent = make_agent()
        checkpoint = [HumanMessage(id="h1", content="hello")]
        incoming = [HumanMessage(id="h1", content="hello")]
        self.assertIsNone(agent._detect_edited_human_message(incoming, checkpoint))

    def test_returns_edited_message_when_content_differs(self):
        agent = make_agent()
        checkpoint = [
            HumanMessage(id="h1", content="What is 2+2?"),
            AIMessage(id="a1", content="4"),
        ]
        incoming = [HumanMessage(id="h1", content="What is 3+3?")]
        result = agent._detect_edited_human_message(incoming, checkpoint)
        self.assertIsNotNone(result)
        self.assertEqual(result.id, "h1")
        self.assertEqual(result.content, "What is 3+3?")

    def test_returns_earliest_edit_when_multiple(self):
        """The fork point must be the earliest divergence so that every
        downstream message is regenerated."""
        agent = make_agent()
        checkpoint = [
            HumanMessage(id="h1", content="first"),
            HumanMessage(id="h2", content="second"),
        ]
        incoming = [
            HumanMessage(id="h1", content="FIRST_EDITED"),
            HumanMessage(id="h2", content="SECOND_EDITED"),
        ]
        result = agent._detect_edited_human_message(incoming, checkpoint)
        self.assertIsNotNone(result)
        self.assertEqual(result.id, "h1")

    def test_ignores_messages_without_id(self):
        agent = make_agent()
        checkpoint = [HumanMessage(content="no id")]
        incoming = [HumanMessage(content="different")]
        self.assertIsNone(agent._detect_edited_human_message(incoming, checkpoint))

    def test_ignores_non_human_messages(self):
        """Same-id content changes on AI/Tool messages must not trigger a
        regenerate — only user-authored content edits do."""
        agent = make_agent()
        checkpoint = [AIMessage(id="a1", content="original")]
        incoming = [AIMessage(id="a1", content="edited")]
        self.assertIsNone(agent._detect_edited_human_message(incoming, checkpoint))

    def test_ignores_id_only_in_checkpoint(self):
        agent = make_agent()
        checkpoint = [HumanMessage(id="h1", content="original")]
        incoming = [HumanMessage(id="h2", content="brand new message")]
        self.assertIsNone(agent._detect_edited_human_message(incoming, checkpoint))


class TestPrepareStreamRoutesEditedMessage(unittest.IsolatedAsyncioTestCase):
    """Integration-level tests: ``prepare_stream`` must route a detected
    edit to ``prepare_regenerate_stream`` and skip the normal flow."""

    async def test_edited_message_routes_to_regenerate(self):
        """The core regression: same-id, different-content incoming
        message must fork through ``prepare_regenerate_stream``."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint = [
            HumanMessage(id="h1", content="What is 2+2?"),
            AIMessage(id="a1", content="4"),
        ]
        state = _make_state(messages=checkpoint, tasks=[FakeTask()])

        incoming = [UserMessage(id="h1", role="user", content="What is 3+3?")]
        inp = _make_input(messages=incoming)

        agent.prepare_regenerate_stream = AsyncMock(return_value={"stream": "regen"})
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_awaited_once()
        call_kwargs = agent.prepare_regenerate_stream.await_args.kwargs
        self.assertEqual(call_kwargs["message_checkpoint"].id, "h1")
        self.assertEqual(call_kwargs["message_checkpoint"].content, "What is 3+3?")
        self.assertEqual(result, {"stream": "regen"})

    async def test_unchanged_messages_do_not_regenerate(self):
        """Continuation (same id, same content) must NOT trigger
        regeneration — that path is reserved for true edits and rewinds."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint = [HumanMessage(id="h1", content="hello")]
        state = _make_state(messages=checkpoint, tasks=[FakeTask()])

        incoming = [
            UserMessage(id="h1", role="user", content="hello"),
            UserMessage(id="h2", role="user", content="follow up"),
        ]
        inp = _make_input(messages=incoming)

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        self.assertIsNotNone(result.get("stream"))

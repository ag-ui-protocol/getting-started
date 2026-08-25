"""Tests for prepare_stream interrupt-resume ordering -- fixes #1743.

The bug: the regenerate heuristic (message-count comparison) runs
*before* the interrupt check, so when a checkpoint contains an AI
message from the interrupt that the frontend never saw, prepare_stream
incorrectly enters the regenerate path, destroying the interrupt state.

The fix treats an explicit, non-None resume key as a resume command that
bypasses the regenerate heuristic. Active interrupts without a resume
still allow edit/regenerate detection before replaying interrupt events.
"""

import unittest
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, List
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from ag_ui.core import EventType, ToolMessage as AGUIToolMessage, UserMessage

from ag_ui_langgraph import agent as agent_module
from tests._helpers import make_agent


@dataclass
class FakeInterrupt:
    value: Any
    id: str = "fake-interrupt"


@dataclass
class FakeTask:
    interrupts: List[FakeInterrupt] = field(default_factory=list)


def _make_state(messages, tasks=None):
    """Build a mock agent_state with messages and optional tasks."""
    state = MagicMock()
    state.values = {"messages": messages}
    state.tasks = tasks or []
    state.next = []
    state.metadata = {"writes": {}}
    return state


def _make_input(
    messages,
    thread_id="t1",
    forwarded_props=None,
    resume=None,
):
    """Build a RunAgentInput-compatible mock."""
    inp = MagicMock()
    inp.thread_id = thread_id
    inp.messages = messages
    inp.state = {}
    inp.tools = []
    inp.context = []
    inp.run_id = "run-1"
    inp.forwarded_props = forwarded_props or {}
    inp.resume = resume
    return inp


async def _empty_stream():
    if False:
        yield None


def _checkpoint_signature(messages):
    """Return stable message fields so tests can assert no checkpoint mutation."""
    return [
        (
            type(message).__name__,
            getattr(message, "id", None),
            deepcopy(getattr(message, "content", None)),
            deepcopy(getattr(message, "tool_calls", None)),
            getattr(message, "tool_call_id", None),
        )
        for message in messages
    ]


def _orphan_placeholder(tool_name: str, tool_call_id: str) -> str:
    return (
        f"Tool call '{tool_name}' with id '{tool_call_id}' "
        f"was interrupted before completion."
    )


class TestPrepareStreamInterruptResumeOrdering(unittest.IsolatedAsyncioTestCase):
    """Interrupt resumes must bypass the regenerate heuristic (#1743)."""

    async def test_handle_stream_events_uses_forwarded_node_name_for_continue_mode(self):
        """A no-resume request with node_name should continue from that node."""
        agent = make_agent()

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
        ]
        initial_state = _make_state(messages=checkpoint_messages)
        agent.graph.aget_state = AsyncMock(return_value=initial_state)
        agent.graph.astream_events.return_value = _empty_stream()

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
            UserMessage(id="h2", role="user", content="follow up"),
        ]
        inp = _make_input(
            messages=frontend_messages,
            forwarded_props={"node_name": "approval_node"},
        )

        collected = []
        async for event in agent._handle_stream_events(inp):
            collected.append(event)

        agent.graph.aupdate_state.assert_awaited_once()
        self.assertEqual(
            agent.graph.aupdate_state.await_args.kwargs.get("as_node"),
            "approval_node",
        )

    async def test_interrupt_none_resume_with_node_name_does_not_emit_unmatched_step(self):
        """Short-circuit interrupt replay must not start a step it never finishes."""
        agent = make_agent()

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        initial_state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )
        agent.graph.aget_state = AsyncMock(return_value=initial_state)

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(
            messages=frontend_messages,
            forwarded_props={"node_name": "approval_node", "command": {"resume": None}},
        )

        events = []
        async for event in agent._handle_stream_events(inp):
            events.append(event)

        types = [getattr(event, "type", None) for event in events]
        self.assertNotIn(EventType.STEP_STARTED, types)
        self.assertNotIn(EventType.STEP_FINISHED, types)
        self.assertEqual(types.count(EventType.RUN_STARTED), 1)
        self.assertEqual(types.count(EventType.RUN_FINISHED), 1)

    async def test_resume_with_interrupt_does_not_regenerate(self):
        """Core regression: checkpoint has more messages than frontend
        sent (the AI tool-call from the interrupt), and a resume value is
        present. The old code would enter prepare_regenerate_stream; the
        fix must skip it and produce a Command(resume=...) stream."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value={"question": "Approve?"})])],
        )

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(
            messages=frontend_messages,
            forwarded_props={"command": {"resume": "yes"}},
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}
        before_checkpoint = _checkpoint_signature(checkpoint_messages)

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        self.assertIsNotNone(result.get("stream"))
        agent.graph.aupdate_state.assert_not_called()
        self.assertEqual(before_checkpoint, _checkpoint_signature(checkpoint_messages))

        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertIsInstance(stream_input, Command)
        self.assertEqual(stream_input.resume, "yes")

    async def test_falsy_resume_payloads_with_interrupt_are_treated_as_present(self):
        """Non-None resume payloads, not truthiness, should select Command(resume=...)."""
        falsy_payloads = [False, 0, "", {}, []]

        for payload in falsy_payloads:
            with self.subTest(payload=payload):
                agent = make_agent()
                agent.active_run = {"id": "run-1", "mode": "start"}

                checkpoint_messages = [
                    HumanMessage(id="h1", content="do something"),
                    AIMessage(
                        id="ai1",
                        content="",
                        tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
                    ),
                ]
                state = _make_state(
                    messages=checkpoint_messages,
                    tasks=[FakeTask(interrupts=[FakeInterrupt(value={"question": "Approve?"})])],
                )

                frontend_messages = [
                    UserMessage(id="h1", role="user", content="do something"),
                ]
                inp = _make_input(
                    messages=frontend_messages,
                    forwarded_props={"command": {"resume": payload}},
                )

                agent.prepare_regenerate_stream = AsyncMock()
                config = {"configurable": {"thread_id": "t1"}}
                before_checkpoint = _checkpoint_signature(checkpoint_messages)

                result = await agent.prepare_stream(inp, state, config)

                agent.prepare_regenerate_stream.assert_not_awaited()
                agent.graph.aupdate_state.assert_not_called()
                self.assertEqual(before_checkpoint, _checkpoint_signature(checkpoint_messages))
                self.assertIsNotNone(result.get("stream"))

                stream_input = agent.graph.astream_events.call_args.kwargs["input"]
                self.assertIsInstance(stream_input, Command)
                self.assertEqual(stream_input.resume, payload)

    async def test_none_resume_payload_with_interrupt_is_treated_as_absent(self):
        """resume=None follows the no-resume interrupt replay path."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(
            messages=frontend_messages,
            forwarded_props={"command": {"resume": None}},
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}
        before_checkpoint = _checkpoint_signature(checkpoint_messages)

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        agent.graph.astream_events.assert_not_called()
        agent.graph.aupdate_state.assert_not_called()
        self.assertEqual(before_checkpoint, _checkpoint_signature(checkpoint_messages))
        self.assertIsNone(result.get("stream"))

        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        self.assertIn(EventType.RUN_STARTED, types)
        self.assertIn(EventType.CUSTOM, types)
        self.assertIn(EventType.RUN_FINISHED, types)

    async def test_none_resume_interrupt_replay_does_not_mutate_string_tool_call_args(self):
        """Interrupt replay must not repair checkpoint tool_call args in place."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[
                    {
                        "id": "tc-1",
                        "name": "approval",
                        "args": {},
                    }
                ],
            ),
        ]
        checkpoint_messages[1].tool_calls[0]["args"] = '{"approved": false}'
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(
            messages=frontend_messages,
            forwarded_props={"command": {"resume": None}},
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}
        before_checkpoint = _checkpoint_signature(checkpoint_messages)

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        agent.graph.astream_events.assert_not_called()
        agent.graph.aupdate_state.assert_not_called()
        self.assertEqual(before_checkpoint, _checkpoint_signature(checkpoint_messages))
        self.assertIsNone(result.get("stream"))

        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        self.assertIn(EventType.RUN_STARTED, types)
        self.assertIn(EventType.CUSTOM, types)
        self.assertIn(EventType.RUN_FINISHED, types)

    async def test_interrupt_replay_does_not_mutate_orphan_tool_message_content(self):
        """Interrupt replay must not repair checkpoint ToolMessage content in place."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        tool_call_id = "tc-1"
        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[
                    {
                        "id": tool_call_id,
                        "name": "approval",
                        "args": {},
                    }
                ],
            ),
            ToolMessage(
                id="orphan-1",
                content=_orphan_placeholder("approval", tool_call_id),
                tool_call_id=tool_call_id,
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
            AGUIToolMessage(
                id="agui-tool-1",
                role="tool",
                content="approved",
                tool_call_id=tool_call_id,
            ),
        ]
        inp = _make_input(
            messages=frontend_messages,
            forwarded_props={"command": {"resume": None}},
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}
        before_checkpoint = _checkpoint_signature(checkpoint_messages)

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        agent.graph.astream_events.assert_not_called()
        agent.graph.aupdate_state.assert_not_called()
        self.assertEqual(before_checkpoint, _checkpoint_signature(checkpoint_messages))
        self.assertIsNone(result.get("stream"))

        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        self.assertIn(EventType.RUN_STARTED, types)
        self.assertIn(EventType.CUSTOM, types)
        self.assertIn(EventType.RUN_FINISHED, types)

    async def test_interrupt_without_resume_still_allows_regenerate_heuristic(self):
        """Active interrupts must not globally suppress the edit/regenerate path."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="original"),
            AIMessage(id="ai1", content="first answer"),
            HumanMessage(id="h2", content="regenerate from here"),
            AIMessage(
                id="ai2",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="pending approval")])],
        )

        frontend_messages = [
            UserMessage(id="h1", role="user", content="original"),
            UserMessage(id="h-edited", role="user", content="edited earlier"),
            UserMessage(id="h2", role="user", content="regenerate from here"),
        ]
        inp = _make_input(messages=frontend_messages, forwarded_props={})

        prepared_regenerate = {
            "stream": "regenerate-stream",
            "state": {"messages": checkpoint_messages},
            "config": {"configurable": {"thread_id": "t1"}},
        }
        agent.prepare_regenerate_stream = AsyncMock(return_value=prepared_regenerate)
        config = {"configurable": {"thread_id": "t1"}}
        before_checkpoint = _checkpoint_signature(checkpoint_messages)

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_awaited_once()
        self.assertIs(result, prepared_regenerate)
        agent.graph.aupdate_state.assert_not_called()
        self.assertEqual(before_checkpoint, _checkpoint_signature(checkpoint_messages))

    async def test_interrupt_without_resume_dispatches_interrupt_events(self):
        """When there's an active interrupt but no resume value, the agent
        must dispatch interrupt events (not enter regenerate)."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(messages=frontend_messages, forwarded_props={})

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}
        before_checkpoint = _checkpoint_signature(checkpoint_messages)

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        agent.graph.aupdate_state.assert_not_called()
        self.assertEqual(before_checkpoint, _checkpoint_signature(checkpoint_messages))
        self.assertIsNone(result.get("stream"))

        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        self.assertIn(EventType.RUN_STARTED, types)
        self.assertIn(EventType.CUSTOM, types)
        self.assertIn(EventType.RUN_FINISHED, types)

    async def test_no_interrupt_normal_flow_produces_stream(self):
        """Without active interrupts, the normal streaming path must
        still work — the fix must not break standard message flow."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="hello"),
        ]
        state = _make_state(messages=checkpoint_messages, tasks=[FakeTask()])

        frontend_messages = [
            UserMessage(id="h1", role="user", content="hello"),
            UserMessage(id="h2", role="user", content="follow up"),
        ]
        inp = _make_input(messages=frontend_messages, forwarded_props={})

        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        self.assertIsNotNone(result.get("stream"))

    async def test_resume_with_no_interrupt_proceeds_normally(self):
        """A resume value without active interrupts should not crash;
        the resume path at the bottom of prepare_stream handles it."""
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
        ]
        state = _make_state(messages=checkpoint_messages, tasks=[FakeTask()])

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(
            messages=frontend_messages,
            forwarded_props={"command": {"resume": "yes"}},
        )

        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        self.assertIsNotNone(result.get("stream"))


class TestResumeInputJSONParseLogging(unittest.IsolatedAsyncioTestCase):
    """Malformed JSON in a string resume payload must surface via logger.warning
    with the offending excerpt; the raw string must still be forwarded to
    Command(resume=...) so callers passing literal strings keep working."""

    async def test_malformed_resume_json_string_logs_warning_and_preserves_raw(self):
        agent = make_agent()
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value={"question": "Approve?"})])],
        )

        malformed = '{"approved: true}'
        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(
            messages=frontend_messages,
            forwarded_props={"command": {"resume": malformed}},
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        with patch.object(agent_module, "logger") as mock_logger:
            result = await agent.prepare_stream(inp, state, config)

        self.assertIsNotNone(result.get("stream"))
        agent.prepare_regenerate_stream.assert_not_awaited()

        # Raw string preserved into Command(resume=...).
        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertIsInstance(stream_input, Command)
        self.assertEqual(stream_input.resume, malformed)

        # Warning surfaced with the malformed payload excerpt.
        self.assertTrue(
            mock_logger.warning.called,
            "expected logger.warning for malformed resume_input JSON",
        )
        call_args = mock_logger.warning.call_args
        formatted = call_args[0][0] % call_args[0][1:]
        self.assertIn(malformed, formatted)


class TestInterruptShortCircuitOutcomeLegacyOff(unittest.IsolatedAsyncioTestCase):
    """When enable_legacy_on_interrupt_event=False, the short-circuit path
    must emit RUN_FINISHED(outcome=interrupt) without CustomEvent(on_interrupt)."""

    async def test_no_resume_short_circuit_no_legacy_custom_event(self):
        from ag_ui_langgraph.agent import LangGraphAgent

        agent = LangGraphAgent(
            name="test",
            graph=MagicMock(),
            enable_legacy_on_interrupt_event=False,
            emit_interrupt_outcome=True,
        )
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(messages=frontend_messages, forwarded_props={})

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        self.assertIsNone(result.get("stream"))
        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        self.assertIn(EventType.RUN_STARTED, types)
        self.assertNotIn(EventType.CUSTOM, types)
        self.assertIn(EventType.RUN_FINISHED, types)

        finished_events = [e for e in events if getattr(e, "type", None) == EventType.RUN_FINISHED]
        self.assertEqual(len(finished_events), 1)
        self.assertEqual(finished_events[0].outcome.type, "interrupt")

    async def test_no_resume_short_circuit_with_legacy_on(self):
        agent = make_agent(emit_interrupt_outcome=True)
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )

        frontend_messages = [
            UserMessage(id="h1", role="user", content="do something"),
        ]
        inp = _make_input(messages=frontend_messages, forwarded_props={})

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        self.assertIn(EventType.CUSTOM, types)
        self.assertIn(EventType.RUN_FINISHED, types)

        finished_events = [e for e in events if getattr(e, "type", None) == EventType.RUN_FINISHED]
        self.assertEqual(finished_events[0].outcome.type, "interrupt")


class TestInterruptShortCircuitDefault(unittest.IsolatedAsyncioTestCase):
    """Default config (emit_interrupt_outcome=False) must short-circuit with a
    plain RUN_FINISHED (no structured outcome) plus the legacy on_interrupt event
    — released clients that resume via command.resume break when they see the
    structured outcome. This lives in a unittest.TestCase so CI's
    `unittest discover` actually collects it (test_interrupt_handling.py's
    pytest-style classes are not collected by that runner)."""

    async def test_default_short_circuit_emits_plain_run_finished(self):
        agent = make_agent()  # emit_interrupt_outcome defaults False
        agent.active_run = {"id": "run-1", "mode": "start"}

        checkpoint_messages = [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]
        state = _make_state(
            messages=checkpoint_messages,
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )

        frontend_messages = [UserMessage(id="h1", role="user", content="do something")]
        inp = _make_input(messages=frontend_messages, forwarded_props={})

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        # Legacy on_interrupt still surfaces the interrupt by default.
        self.assertIn(EventType.CUSTOM, types)
        self.assertIn(EventType.RUN_FINISHED, types)

        finished_events = [e for e in events if getattr(e, "type", None) == EventType.RUN_FINISHED]
        self.assertEqual(len(finished_events), 1)
        self.assertIsNone(getattr(finished_events[0], "outcome", None))

    async def test_legacy_off_forces_outcome_even_when_emit_off(self):
        """With BOTH the legacy on_interrupt event and emit_interrupt_outcome
        off, the interrupt would be surfaced by neither channel — so the outcome
        is forced on to avoid a silent swallow."""
        from ag_ui_langgraph.agent import LangGraphAgent

        agent = LangGraphAgent(
            name="test",
            graph=MagicMock(),
            enable_legacy_on_interrupt_event=False,
            # emit_interrupt_outcome defaults False
        )
        agent.active_run = {"id": "run-1", "mode": "start"}

        state = _make_state(
            messages=[
                HumanMessage(id="h1", content="do something"),
                AIMessage(id="ai1", content="", tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}]),
            ],
            tasks=[FakeTask(interrupts=[FakeInterrupt(value="confirm?")])],
        )
        inp = _make_input(
            messages=[UserMessage(id="h1", role="user", content="do something")],
            forwarded_props={},
        )
        agent.prepare_regenerate_stream = AsyncMock()

        result = await agent.prepare_stream(inp, state, {"configurable": {"thread_id": "t1"}})

        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        self.assertNotIn(EventType.CUSTOM, types)
        finished_events = [e for e in events if getattr(e, "type", None) == EventType.RUN_FINISHED]
        self.assertEqual(len(finished_events), 1)
        self.assertIsNotNone(getattr(finished_events[0], "outcome", None))
        self.assertEqual(finished_events[0].outcome.type, "interrupt")


class TestCheckpointSignature(unittest.TestCase):
    """Checkpoint mutation assertions must observe in-place mutations."""

    def test_checkpoint_signature_does_not_retain_mutable_message_references(self):
        messages = [
            AIMessage(
                id="ai1",
                content=[{"type": "text", "text": "before"}],
                tool_calls=[
                    {
                        "id": "tc-1",
                        "name": "approval",
                        "args": {"approved": False},
                    }
                ],
            ),
        ]

        before = _checkpoint_signature(messages)
        messages[0].content[0]["text"] = "after"  # type: ignore[index]
        messages[0].tool_calls[0]["args"]["approved"] = True

        self.assertNotEqual(before, _checkpoint_signature(messages))

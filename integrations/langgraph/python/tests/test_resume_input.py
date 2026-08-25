"""Tests for the AG-UI standard input.resume path in prepare_stream.

These tests verify that:
1. input.resume with a single resolved ResumeEntry produces Command(resume=payload).
2. input.resume with a single cancelled ResumeEntry produces Command(resume=sentinel).
3. input.resume takes precedence over forwardedProps.command.resume with a WARN.
4. Legacy forwardedProps.command.resume still works with a deprecation WARN.
5. Active interrupts without any resume emit outcome.interrupt in the short-circuit path.
"""

import unittest
from dataclasses import dataclass, field
from typing import Any, List
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command

from ag_ui.core import EventType, ResumeEntry, UserMessage

from ag_ui_langgraph import agent as agent_module
from ag_ui_langgraph.interrupts import DEFAULT_RESUME_SENTINEL_CANCELLED
from tests._helpers import make_agent


@dataclass
class FakeInterrupt:
    value: Any
    id: str = "fake-interrupt"


@dataclass
class FakeTask:
    interrupts: List[FakeInterrupt] = field(default_factory=list)


def _make_state(messages, tasks=None):
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


class TestInputResumeResolvedSingle(unittest.IsolatedAsyncioTestCase):
    async def test_input_resume_resolved_single(self):
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
            resume=[ResumeEntry(interrupt_id="i1", status="resolved", payload={"approved": True})],
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        agent.prepare_regenerate_stream.assert_not_awaited()
        self.assertIsNotNone(result.get("stream"))

        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertIsInstance(stream_input, Command)
        self.assertEqual(stream_input.resume, {"approved": True})


class TestInputResumeCancelled(unittest.IsolatedAsyncioTestCase):
    async def test_input_resume_cancelled(self):
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
            resume=[ResumeEntry(interrupt_id="i1", status="cancelled")],
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        self.assertIsNotNone(result.get("stream"))
        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertIsInstance(stream_input, Command)
        self.assertIsInstance(stream_input.resume, dict)
        self.assertTrue(stream_input.resume.get(DEFAULT_RESUME_SENTINEL_CANCELLED))
        self.assertEqual(stream_input.resume.get("interrupt_id"), "i1")


class TestInputResumeTakesPrecedenceOverLegacy(unittest.IsolatedAsyncioTestCase):
    async def test_input_resume_takes_precedence_over_legacy(self):
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
            forwarded_props={"command": {"resume": "legacy_value"}},
            resume=[ResumeEntry(interrupt_id="i1", status="resolved", payload={"new": True})],
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        with patch.object(agent_module, "logger") as mock_logger:
            result = await agent.prepare_stream(inp, state, config)

        self.assertIsNotNone(result.get("stream"))
        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertIsInstance(stream_input, Command)
        self.assertEqual(stream_input.resume, {"new": True})

        warn_calls = [str(c) for c in mock_logger.warning.call_args_list]
        # The conflict warning is emitted in `run`, not `prepare_stream`,
        # so the unit-level prepare_stream call must stay silent. See
        # TestRunEmitsLegacyWarningOnce for end-to-end coverage.
        self.assertFalse(
            any("both input.resume and forwardedProps.command.resume" in c for c in warn_calls),
            f"prepare_stream must not log the conflict warning (run emits it once): {warn_calls}",
        )


class TestLegacyResumeStillWorks(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_resume_still_works(self):
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

        with patch.object(agent_module, "logger") as mock_logger:
            result = await agent.prepare_stream(inp, state, config)

        self.assertIsNotNone(result.get("stream"))
        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertIsInstance(stream_input, Command)
        self.assertEqual(stream_input.resume, "yes")

        warn_calls = [str(c) for c in mock_logger.warning.call_args_list]
        # Deprecation warning is owned by `run`, not `prepare_stream`.
        self.assertFalse(
            any("forwardedProps.command.resume is deprecated" in c for c in warn_calls),
            f"prepare_stream must not log the deprecation warning (run emits it once): {warn_calls}",
        )


class TestActiveInterruptsNoResumeEmitsOutcome(unittest.IsolatedAsyncioTestCase):
    async def test_active_interrupts_no_resume_emits_outcome(self):
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
            tasks=[FakeTask(interrupts=[
                FakeInterrupt(value={"reason": "confirm", "message": "ok?"}, id="int-1"),
            ])],
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
        self.assertIn(EventType.RUN_FINISHED, types)

        finished_events = [e for e in events if getattr(e, "type", None) == EventType.RUN_FINISHED]
        self.assertEqual(len(finished_events), 1)
        finished = finished_events[0]
        self.assertEqual(finished.outcome.type, "interrupt")
        self.assertEqual(len(finished.outcome.interrupts), 1)
        self.assertEqual(finished.outcome.interrupts[0].id, "int-1")
        self.assertEqual(finished.outcome.interrupts[0].reason, "confirm")
        self.assertEqual(finished.outcome.interrupts[0].message, "ok?")


class TestEmptyResumeArrayTreatedAsAbsent(unittest.IsolatedAsyncioTestCase):
    async def test_empty_resume_array_treated_as_absent(self):
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
        inp = _make_input(
            messages=frontend_messages,
            resume=[],
        )

        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}

        result = await agent.prepare_stream(inp, state, config)

        self.assertIsNone(result.get("stream"))

        events = result.get("events_to_dispatch", [])
        types = [getattr(e, "type", None) for e in events]
        self.assertIn(EventType.RUN_FINISHED, types)

        finished_events = [e for e in events if getattr(e, "type", None) == EventType.RUN_FINISHED]
        self.assertEqual(finished_events[0].outcome.type, "interrupt")


class TestRunEmitsLegacyWarningOnce(unittest.IsolatedAsyncioTestCase):
    """The deprecation / conflict warnings must be emitted exactly once per
    request (from ``run`` only), not duplicated by ``prepare_stream``."""

    async def _drive(self, agent, inp):
        # Drive ``run`` past the warning block but short-circuit before any
        # real graph work by stubbing prepare_stream to return an
        # events_to_dispatch payload — that triggers the early ``return`` at
        # the top of ``_handle_stream_events``.
        # ``run`` does ``input.model_copy(update={...})``; on a MagicMock that
        # returns a fresh mock with stringified attributes, so route the
        # copy back through the configured fixture to preserve thread_id
        # and forwarded_props.
        def _identity_copy(update=None):
            if update:
                for k, v in update.items():
                    setattr(inp, k, v)
            return inp
        # ``run`` forwards via ``input.model_copy(update={...})``; route it
        # through the fixture so forwarded_props survive onto the same mock.
        inp.copy = _identity_copy
        inp.model_copy = _identity_copy

        # ``run`` awaits ``graph.aget_state`` before the warning block; the
        # bare ``make_agent`` graph leaves it a sync MagicMock, so awaiting it
        # raises and ``run`` bails before any warning fires. Stub it async.
        agent.graph.aget_state = AsyncMock(return_value=_make_state(messages=[]))

        sentinel = MagicMock()
        agent.prepare_stream = AsyncMock(return_value={
            "stream": None,
            "state": None,
            "config": None,
            "events_to_dispatch": [sentinel],
        })
        agent._dispatch_event = MagicMock(side_effect=lambda e: e)
        async for _ in agent.run(inp):
            pass

    async def test_deprecation_warning_emitted_exactly_once(self):
        agent = make_agent()
        inp = _make_input(
            messages=[UserMessage(id="h1", role="user", content="x")],
            forwarded_props={"command": {"resume": "yes"}},
        )

        with patch.object(agent_module, "logger") as mock_logger:
            await self._drive(agent, inp)

        warn_calls = [str(c) for c in mock_logger.warning.call_args_list]
        deprecation = [c for c in warn_calls if "forwardedProps.command.resume is deprecated" in c]
        self.assertEqual(
            len(deprecation), 1,
            f"deprecation warning must fire exactly once, got {len(deprecation)}: {warn_calls}",
        )

    async def test_conflict_warning_emitted_exactly_once(self):
        agent = make_agent()
        inp = _make_input(
            messages=[UserMessage(id="h1", role="user", content="x")],
            forwarded_props={"command": {"resume": "legacy"}},
            resume=[ResumeEntry(interrupt_id="i1", status="resolved", payload={"new": True})],
        )

        with patch.object(agent_module, "logger") as mock_logger:
            await self._drive(agent, inp)

        warn_calls = [str(c) for c in mock_logger.warning.call_args_list]
        conflict = [c for c in warn_calls if "both input.resume and forwardedProps.command.resume" in c]
        self.assertEqual(
            len(conflict), 1,
            f"conflict warning must fire exactly once, got {len(conflict)}: {warn_calls}",
        )


class TestInterruptOutcomeResumeRoundTrip(unittest.IsolatedAsyncioTestCase):
    """End-to-end mirror of the TypeScript
    ``interrupt-outcome-resume-roundtrip`` integration test.

    The Python suite already covers the structured outcome emission
    (``TestActiveInterruptsNoResumeEmitsOutcome``) and the canonical
    ``input.resume[]`` translation (``TestInputResumeResolvedSingle``) as
    separate units, but never as one sequential flow on the same agent. This
    drives both phases against the same ``emit_interrupt_outcome=True`` agent:

      phase 1 (no resume)  -> prepare_stream short-circuits with a
                              RUN_FINISHED whose outcome.type == "interrupt".
      phase 2 (resume[])   -> prepare_stream forwards Command(resume=payload)
                              to the graph and does NOT re-emit the interrupt
                              outcome, i.e. the run actually resumes.

    Fails if the opt-in emission regresses (phase 1) or if the resume[]
    translation regresses (phase 2)."""

    def _checkpoint(self):
        return [
            HumanMessage(id="h1", content="do something"),
            AIMessage(
                id="ai1",
                content="",
                tool_calls=[{"id": "tc-1", "name": "approval", "args": {}}],
            ),
        ]

    async def test_interrupt_outcome_then_resume_round_trip(self):
        agent = make_agent(emit_interrupt_outcome=True)
        agent.active_run = {"id": "run-1", "mode": "start"}
        agent.prepare_regenerate_stream = AsyncMock()
        config = {"configurable": {"thread_id": "t1"}}
        frontend_messages = [UserMessage(id="h1", role="user", content="do something")]

        # The platform reports an open interrupt on the thread.
        interrupt_state = _make_state(
            messages=self._checkpoint(),
            tasks=[FakeTask(interrupts=[
                FakeInterrupt(value={"reason": "confirm", "message": "ok?"}, id="int-1"),
            ])],
        )

        # ── Phase 1: no resume -> structured interrupt outcome ──────────────
        run1 = _make_input(messages=frontend_messages, forwarded_props={})
        result1 = await agent.prepare_stream(run1, interrupt_state, config)

        # The run short-circuits (no graph stream) and surfaces the interrupt.
        self.assertIsNone(result1.get("stream"))
        finished1 = [
            e for e in result1.get("events_to_dispatch", [])
            if getattr(e, "type", None) == EventType.RUN_FINISHED
        ]
        self.assertEqual(len(finished1), 1)
        self.assertEqual(finished1[0].outcome.type, "interrupt")
        self.assertEqual(finished1[0].outcome.interrupts[0].id, "int-1")
        self.assertEqual(finished1[0].outcome.interrupts[0].reason, "confirm")

        # ── Phase 2: resume via canonical input.resume[] -> run resumes ─────
        run2 = _make_input(
            messages=frontend_messages,
            resume=[ResumeEntry(interrupt_id="int-1", status="resolved", payload={"approved": True})],
        )
        result2 = await agent.prepare_stream(run2, interrupt_state, config)

        # The resume actually streams to the graph (no short-circuit) ...
        self.assertIsNotNone(result2.get("stream"))
        # ... carrying the canonical Command(resume=payload) verbatim.
        stream_input = agent.graph.astream_events.call_args.kwargs["input"]
        self.assertIsInstance(stream_input, Command)
        self.assertEqual(stream_input.resume, {"approved": True})

        # The resume run must NOT re-emit the interrupt outcome.
        finished2 = [
            e for e in result2.get("events_to_dispatch", [])
            if getattr(e, "type", None) == EventType.RUN_FINISHED
            and getattr(getattr(e, "outcome", None), "type", None) == "interrupt"
        ]
        self.assertEqual(finished2, [])

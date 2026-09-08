"""Tests for interrupt detection across parallel tasks — fixes #1409,
and tests for _emit_interrupt_finish producing correct AG-UI protocol events.

The bug is that interrupt checking only looks at tasks[0], so if a parallel
tool call has the interrupt on tasks[1] or later, it's silently missed.

These tests call the actual LangGraphAgent._collect_interrupts() method
so that reverting the fix in agent.py will cause test failures.
"""
import unittest
import pytest
from unittest.mock import MagicMock
from dataclasses import dataclass, field
from typing import List, Any

from ag_ui.core import (
    EventType,
    CustomEvent,
    RunFinishedEvent,
)

from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui_langgraph.types import LangGraphEventTypes


@dataclass
class FakeInterrupt:
    value: Any
    id: Any = None


@dataclass
class FakeTask:
    interrupts: List[FakeInterrupt] = field(default_factory=list)


def make_agent(**agent_kwargs):
    """Create a LangGraphAgent with a mock graph. Extra keyword arguments are
    forwarded to ``LangGraphAgent`` (e.g. ``emit_interrupt_outcome=True``)."""
    mock_graph = MagicMock()
    return LangGraphAgent(name="test", graph=mock_graph, **agent_kwargs)


class TestCollectInterrupts(unittest.TestCase):
    """Test LangGraphAgent._collect_interrupts() across all tasks."""

    def test_single_task_with_interrupt(self):
        agent = make_agent()
        tasks = [FakeTask(interrupts=[FakeInterrupt(value="please confirm")])]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1
        assert interrupts[0].value == "please confirm"

    def test_single_task_without_interrupt(self):
        agent = make_agent()
        tasks = [FakeTask(interrupts=[])]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 0

    def test_multiple_tasks_interrupt_on_second(self):
        """Bug #1409: interrupt on tasks[1] must be detected."""
        agent = make_agent()
        tasks = [
            FakeTask(interrupts=[]),
            FakeTask(interrupts=[FakeInterrupt(value="confirm action B")]),
        ]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1, "Interrupt on tasks[1] must be detected (issue #1409)"
        assert interrupts[0].value == "confirm action B"

    def test_multiple_tasks_interrupt_on_third(self):
        agent = make_agent()
        tasks = [
            FakeTask(interrupts=[]),
            FakeTask(interrupts=[]),
            FakeTask(interrupts=[FakeInterrupt(value="confirm C")]),
        ]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1

    def test_multiple_tasks_multiple_interrupts(self):
        """Interrupts on multiple tasks should all be collected."""
        agent = make_agent()
        tasks = [
            FakeTask(interrupts=[FakeInterrupt(value="A")]),
            FakeTask(interrupts=[FakeInterrupt(value="B")]),
        ]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 2
        values = [i.value for i in interrupts]
        assert "A" in values
        assert "B" in values

    def test_empty_tasks(self):
        """Empty tasks list should return empty without crashing."""
        agent = make_agent()
        interrupts = agent._collect_interrupts([])
        assert len(interrupts) == 0

    def test_none_tasks(self):
        """None tasks should return empty without crashing."""
        agent = make_agent()
        interrupts = agent._collect_interrupts(None)
        assert len(interrupts) == 0

    def test_all_tasks_without_interrupts(self):
        agent = make_agent()
        tasks = [FakeTask(interrupts=[]), FakeTask(interrupts=[])]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 0

    def test_task_with_none_interrupts(self):
        """A task whose interrupts field is None should be safely skipped."""
        @dataclass
        class TaskWithNoneInterrupts:
            interrupts: Any = None

        agent = make_agent()
        tasks = [TaskWithNoneInterrupts(), FakeTask(interrupts=[FakeInterrupt(value="ok")])]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1
        assert interrupts[0].value == "ok"

    def test_task_missing_interrupts_attribute(self):
        """A task object with no interrupts attribute at all should be safely skipped."""
        class BareTask:
            pass

        agent = make_agent()
        tasks = [BareTask(), FakeTask(interrupts=[FakeInterrupt(value="found")])]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1
        assert interrupts[0].value == "found"

    def test_malformed_tasks_mixed_with_valid(self):
        """Non-task objects mixed in should not raise — only valid interrupts collected."""
        agent = make_agent()
        valid_task = FakeTask(interrupts=[FakeInterrupt(value="valid")])
        malformed = {}
        tasks = [valid_task, malformed]
        interrupts = agent._collect_interrupts(tasks)
        assert len(interrupts) == 1


class TestEmitInterruptFinish:
    """Test _emit_interrupt_finish produces correct AG-UI protocol events."""

    def test_interrupt_finish_emits_outcome_with_legacy_on(self):
        agent = make_agent(emit_interrupt_outcome=True)
        agent.active_run = {"id": "run-1", "thread_id": "t1"}

        lg_interrupts = [
            FakeInterrupt(value={"reason": "confirm", "message": "ok?"}, id="int-1"),
        ]

        events = agent._emit_interrupt_finish(
            thread_id="t1",
            run_id="run-1",
            lg_interrupts=lg_interrupts,
        )

        assert len(events) == 2

        custom = events[0]
        assert isinstance(custom, CustomEvent)
        assert custom.type == EventType.CUSTOM
        assert custom.name == LangGraphEventTypes.OnInterrupt.value

        finished = events[1]
        assert isinstance(finished, RunFinishedEvent)
        assert finished.type == EventType.RUN_FINISHED
        assert finished.outcome.type == "interrupt"
        assert len(finished.outcome.interrupts) == 1
        assert finished.outcome.interrupts[0].reason == "confirm"
        assert finished.outcome.interrupts[0].message == "ok?"
        assert finished.outcome.interrupts[0].id == "int-1"

    def test_interrupt_finish_emits_outcome_with_legacy_off(self):
        agent = LangGraphAgent(
            name="test",
            graph=MagicMock(),
            enable_legacy_on_interrupt_event=False,
            emit_interrupt_outcome=True,
        )
        agent.active_run = {"id": "run-1", "thread_id": "t1"}

        lg_interrupts = [
            FakeInterrupt(value="simple string interrupt", id="int-2"),
        ]

        events = agent._emit_interrupt_finish(
            thread_id="t1",
            run_id="run-1",
            lg_interrupts=lg_interrupts,
        )

        assert len(events) == 1

        custom_events = [e for e in events if isinstance(e, CustomEvent)]
        assert len(custom_events) == 0, "No CustomEvent(on_interrupt) when legacy off"

        finished = events[0]
        assert isinstance(finished, RunFinishedEvent)
        assert finished.outcome.type == "interrupt"
        assert len(finished.outcome.interrupts) == 1
        assert finished.outcome.interrupts[0].reason == "langgraph:interrupt"
        assert finished.outcome.interrupts[0].message == "simple string interrupt"

    def test_interrupt_finish_with_default_reason(self):
        agent = LangGraphAgent(
            name="test",
            graph=MagicMock(),
            enable_legacy_on_interrupt_event=False,
            emit_interrupt_outcome=True,
        )
        agent.active_run = {"id": "run-1", "thread_id": "t1"}

        lg_interrupts = [FakeInterrupt(value={"foo": "bar"}, id="int-3")]

        events = agent._emit_interrupt_finish(
            thread_id="t1",
            run_id="run-1",
            lg_interrupts=lg_interrupts,
        )

        finished = events[0]
        assert finished.outcome.interrupts[0].reason == "langgraph:interrupt"

    def test_interrupt_finish_metadata_langgraph_raw(self):
        agent = LangGraphAgent(
            name="test",
            graph=MagicMock(),
            enable_legacy_on_interrupt_event=False,
            emit_interrupt_outcome=True,
        )
        agent.active_run = {"id": "run-1", "thread_id": "t1"}

        lg_interrupts = [FakeInterrupt(value={"reason": "r"}, id="int-4")]

        events = agent._emit_interrupt_finish(
            thread_id="t1",
            run_id="run-1",
            lg_interrupts=lg_interrupts,
        )

        finished = events[0]
        metadata = finished.outcome.interrupts[0].metadata
        assert "langgraph" in metadata
        assert metadata["langgraph"]["raw"] == {"reason": "r"}

    def test_default_emits_plain_run_finished_without_outcome(self):
        """Default (emit_interrupt_outcome=False) must terminate with a plain
        RUN_FINISHED and NO structured outcome — released clients that resume via
        the legacy command.resume channel break when they see the outcome."""
        agent = make_agent()  # emit_interrupt_outcome defaults False
        agent.active_run = {"id": "run-1", "thread_id": "t1"}

        events = agent._emit_interrupt_finish(
            thread_id="t1",
            run_id="run-1",
            lg_interrupts=[FakeInterrupt(value={"reason": "confirm"}, id="int-1")],
        )

        finished = [e for e in events if isinstance(e, RunFinishedEvent)]
        assert len(finished) == 1
        assert getattr(finished[0], "outcome", None) is None
        # The interrupt is still surfaced via the legacy on_interrupt event.
        custom_events = [e for e in events if isinstance(e, CustomEvent)]
        assert len(custom_events) == 1


class TestInterruptMappingHardening:
    """Tests covering the four review hardenings on the mapping layer."""

    def test_missing_lg_id_raises_rather_than_synthesises(self):
        """Without a real LangGraph id we can't round-trip a resume answer
        back to the originating step, so refuse the mapping outright."""
        from ag_ui_langgraph.interrupts import lg_interrupt_to_agui

        lg = FakeInterrupt(value="confirm", id=None)

        with pytest.raises(ValueError, match="missing `id`"):
            lg_interrupt_to_agui(lg)

    def test_real_lg_id_is_used_verbatim(self):
        from ag_ui_langgraph.interrupts import lg_interrupt_to_agui

        result = lg_interrupt_to_agui(FakeInterrupt(value="x", id="lg-real-42"))
        assert result.id == "lg-real-42"

    def test_empty_string_reason_is_preserved(self):
        """An explicit reason="" must be kept (matching the TS `??`), not
        replaced by the "langgraph:interrupt" default that `or` would force."""
        from ag_ui_langgraph.interrupts import lg_interrupt_to_agui

        result = lg_interrupt_to_agui(FakeInterrupt(value={"reason": ""}, id="int-1"))
        assert result.reason == ""

    def test_missing_reason_falls_back_to_default(self):
        """When reason is absent (None), the default still applies."""
        from ag_ui_langgraph.interrupts import lg_interrupt_to_agui

        result = lg_interrupt_to_agui(FakeInterrupt(value={"message": "hi"}, id="int-1"))
        assert result.reason == "langgraph:interrupt"

    def test_empty_string_tool_call_id_is_preserved(self):
        """`or` would drop "" → fallback; `??`-equivalent keeps it."""
        from ag_ui_langgraph.interrupts import lg_interrupt_to_agui

        result = lg_interrupt_to_agui(
            FakeInterrupt(value={"tool_call_id": ""}, id="int-1")
        )
        assert result.tool_call_id == ""

    def test_empty_dict_response_schema_is_preserved(self):
        from ag_ui_langgraph.interrupts import lg_interrupt_to_agui

        result = lg_interrupt_to_agui(
            FakeInterrupt(value={"response_schema": {}}, id="int-1")
        )
        assert result.response_schema == {}

    def test_camel_case_wins_over_snake_case_for_tool_call_id(self):
        from ag_ui_langgraph.interrupts import lg_interrupt_to_agui

        result = lg_interrupt_to_agui(
            FakeInterrupt(
                value={"toolCallId": "camel", "tool_call_id": "snake"},
                id="int-1",
            )
        )
        assert result.tool_call_id == "camel"

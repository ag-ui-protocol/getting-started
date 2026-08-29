#!/usr/bin/env python
"""Tests for AG-UI STEP_STARTED/STEP_FINISHED emission on ADK workflow runs.

The AG-UI spec recommends STEP events for multi-stage runs ("the stepName could
be the name of a node"). ``EventTranslator`` emits a step per ADK node/sub-agent
boundary (author transition) when ``emit_workflow_steps`` is enabled, and
``ADKAgent`` only enables it for workflow / multi-agent topologies so a plain
single LlmAgent run is unchanged.

These are pure-sync unit tests over the translator's step helpers and the
topology gate — no LLM or runner needed.
"""

from unittest.mock import MagicMock

from ag_ui.core import EventType
from ag_ui_adk.event_translator import EventTranslator
from ag_ui_adk.adk_agent import ADKAgent


def _event(author, branch=None):
    """Minimal fake ADK event; step detection reads ``author`` and ``branch``."""
    e = MagicMock()
    e.author = author
    e.branch = branch
    return e


def _steps(translator, authors):
    """Feed a sequence of authors through the translator and finalize.

    Returns the list of (type, step_name) tuples emitted.
    """
    out = []
    for author in authors:
        for ev in translator.step_boundary_events(_event(author)):
            out.append((ev.type, ev.step_name))
    for ev in translator.finalize_step_events():
        out.append((ev.type, ev.step_name))
    return out


def _assert_well_formed(pairs):
    """Every STEP_FINISHED must match the immediately-open STEP_STARTED (spec rule)."""
    open_name = None
    for etype, name in pairs:
        if etype == EventType.STEP_STARTED:
            assert open_name is None, f"STEP_STARTED {name} while {open_name} still open"
            open_name = name
        elif etype == EventType.STEP_FINISHED:
            assert open_name == name, f"STEP_FINISHED {name} does not match open {open_name}"
            open_name = None
    assert open_name is None, f"step {open_name} left open (missing STEP_FINISHED)"


# ---------------------------------------------------------------------------
# EventTranslator step emission
# ---------------------------------------------------------------------------

def test_disabled_by_default_emits_no_steps():
    translator = EventTranslator()  # emit_workflow_steps defaults to False
    assert _steps(translator, ["a", "a", "b", "c"]) == []


def test_sequential_agents_emit_ordered_matched_steps():
    translator = EventTranslator(emit_workflow_steps=True)
    pairs = _steps(translator, ["a", "a", "b", "c"])  # SequentialAgent[a, b, c]
    assert pairs == [
        (EventType.STEP_STARTED, "a"),
        (EventType.STEP_FINISHED, "a"),
        (EventType.STEP_STARTED, "b"),
        (EventType.STEP_FINISHED, "b"),
        (EventType.STEP_STARTED, "c"),
        (EventType.STEP_FINISHED, "c"),
    ]
    _assert_well_formed(pairs)


def test_streaming_chunks_from_same_node_do_not_re_emit():
    translator = EventTranslator(emit_workflow_steps=True)
    # Many partial chunks from the same author must yield a single step pair.
    pairs = _steps(translator, ["a"] * 5)
    assert pairs == [
        (EventType.STEP_STARTED, "a"),
        (EventType.STEP_FINISHED, "a"),
    ]


def test_loop_repeats_steps_with_matched_pairs():
    translator = EventTranslator(emit_workflow_steps=True)
    pairs = _steps(translator, ["a", "b", "a", "b"])  # LoopAgent[a, b] x2
    assert pairs == [
        (EventType.STEP_STARTED, "a"),
        (EventType.STEP_FINISHED, "a"),
        (EventType.STEP_STARTED, "b"),
        (EventType.STEP_FINISHED, "b"),
        (EventType.STEP_STARTED, "a"),
        (EventType.STEP_FINISHED, "a"),
        (EventType.STEP_STARTED, "b"),
        (EventType.STEP_FINISHED, "b"),
    ]
    # A repeated step name across the run is spec-valid as long as each
    # STEP_FINISHED matches its immediately-preceding STEP_STARTED.
    _assert_well_formed(pairs)


def test_dynamic_transfer_between_agents_emits_steps():
    translator = EventTranslator(emit_workflow_steps=True)
    # coordinator -> specialist -> coordinator (LLM-driven transfer_to_agent)
    pairs = _steps(translator, ["coordinator", "specialist", "coordinator"])
    assert [name for _t, name in pairs if _t == EventType.STEP_STARTED] == [
        "coordinator", "specialist", "coordinator",
    ]
    _assert_well_formed(pairs)


def _branched(translator, pairs):
    """Feed (author, branch) events through the translator and finalize."""
    out = []
    for author, branch in pairs:
        for ev in translator.step_boundary_events(_event(author, branch)):
            out.append((ev.type, ev.step_name))
    for ev in translator.finalize_step_events():
        out.append((ev.type, ev.step_name))
    return out


def test_parallel_branches_open_together_and_close_once():
    # Distinct ADK branches (ParallelAgent sets "par.p"/"par.q") → concurrent,
    # overlapping steps: each opens exactly once and closes at finalize (LIFO).
    translator = EventTranslator(emit_workflow_steps=True)
    out = _branched(translator, [("p", "par.p"), ("q", "par.q"), ("p", "par.p"), ("q", "par.q")])
    assert out == [
        (EventType.STEP_STARTED, "p"), (EventType.STEP_STARTED, "q"),
        (EventType.STEP_FINISHED, "q"), (EventType.STEP_FINISHED, "p"),
    ]


def test_return_to_ancestor_branch_closes_parallel_children():
    # After a parallel block, an event on the ancestor (root) branch closes the
    # still-open parallel children before opening the next node.
    translator = EventTranslator(emit_workflow_steps=True)
    out = _branched(translator, [("p", "par.p"), ("q", "par.q"), ("c", None)])
    assert out == [
        (EventType.STEP_STARTED, "p"), (EventType.STEP_STARTED, "q"),
        (EventType.STEP_FINISHED, "q"), (EventType.STEP_FINISHED, "p"),
        (EventType.STEP_STARTED, "c"), (EventType.STEP_FINISHED, "c"),
    ]


def test_single_author_yields_exactly_one_pair():
    # At the translator level a single author still produces one pair; the
    # single-LlmAgent suppression lives in ADKAgent._agent_has_workflow.
    translator = EventTranslator(emit_workflow_steps=True)
    pairs = _steps(translator, ["solo", "solo", "solo"])
    assert pairs == [
        (EventType.STEP_STARTED, "solo"),
        (EventType.STEP_FINISHED, "solo"),
    ]


def test_user_and_empty_authors_are_ignored():
    translator = EventTranslator(emit_workflow_steps=True)
    pairs = _steps(translator, ["user", "", None, "a", "user"])
    assert pairs == [
        (EventType.STEP_STARTED, "a"),
        (EventType.STEP_FINISHED, "a"),
    ]


def test_finalize_is_idempotent():
    translator = EventTranslator(emit_workflow_steps=True)
    list(translator.step_boundary_events(_event("a")))
    assert [ev.type for ev in translator.finalize_step_events()] == [EventType.STEP_FINISHED]
    # Second finalize is a no-op.
    assert list(translator.finalize_step_events()) == []


def test_reset_clears_open_steps():
    # reset() promises clean state between runs — open workflow steps must not leak.
    translator = EventTranslator(emit_workflow_steps=True)
    list(translator.step_boundary_events(_event("a")))  # opens step "a"
    translator.reset()
    assert list(translator.finalize_step_events()) == []  # nothing left open
    # A fresh run opens cleanly, with no stale STEP_FINISHED for "a".
    assert [ev.type for ev in translator.step_boundary_events(_event("b"))] == [EventType.STEP_STARTED]


# ---------------------------------------------------------------------------
# ADKAgent topology gate
# ---------------------------------------------------------------------------

def test_workflow_orchestrators_are_workflows():
    from google.adk.agents import SequentialAgent, ParallelAgent, LoopAgent
    for cls in (SequentialAgent, ParallelAgent, LoopAgent):
        agent = MagicMock(spec=cls)
        agent.sub_agents = []
        assert ADKAgent._agent_has_workflow(agent) is True


def test_adk_2_0_workflow_graph_is_workflow():
    try:
        from google.adk.workflow import Workflow
    except ImportError:
        import pytest
        pytest.skip("ADK 2.0 Workflow graph engine not available on this ADK version")
    assert ADKAgent._agent_has_workflow(Workflow(name="wf_root")) is True


def test_llm_agent_with_sub_agents_is_workflow():
    from google.adk.agents import LlmAgent
    agent = MagicMock(spec=LlmAgent)
    agent.sub_agents = [MagicMock(spec=LlmAgent)]
    assert ADKAgent._agent_has_workflow(agent) is True


def test_plain_llm_agent_is_not_workflow():
    from google.adk.agents import LlmAgent
    agent = MagicMock(spec=LlmAgent)
    agent.sub_agents = []
    assert ADKAgent._agent_has_workflow(agent) is False
    assert ADKAgent._agent_has_workflow(None) is False

#!/usr/bin/env python
"""End-to-end workflow-step tests over REAL ADK orchestrators (no LLM).

These drive the full ADKAgent producer/consumer with `emit_workflow_steps=True`
using real `SequentialAgent` / `ParallelAgent` / `LoopAgent` / custom-agent /
ADK 2.0 `Workflow` graph topologies. Every leaf is a **rich** node: it emits a
thought (REASONING_*), text (TEXT_MESSAGE_*), a tool call (TOOL_CALL_*), a tool
result (TOOL_CALL_RESULT) and a state delta (STATE_DELTA) — so the tests verify
that STEP_STARTED/STEP_FINISHED correctly brackets the full variety of AG-UI
events for every topology, not just plain text.
"""

import asyncio

import pytest

from google.adk.agents import BaseAgent, SequentialAgent, ParallelAgent, LoopAgent
from google.adk.events import Event, EventActions
from google.genai import types
from ag_ui.core import RunAgentInput, UserMessage, EventType
from ag_ui_adk import ADKAgent

_STEP = (EventType.STEP_STARTED, EventType.STEP_FINISHED)


def _rich_events(name, branch=None, escalate=False):
    """The full event variety a realistic node produces, all authored by ``name``
    and stamped with the context ``branch`` (as real ADK agents do — this is what
    distinguishes concurrent ParallelAgent branches)."""
    fid = f"fc-{name}"
    def ev(**kw):
        return Event(author=name, branch=branch, **kw)
    yield ev(content=types.Content(role="model", parts=[types.Part(text=f"{name} is thinking", thought=True)]))
    yield ev(content=types.Content(role="model", parts=[types.Part(text=f"{name} says hi")]))
    yield ev(content=types.Content(role="model",
             parts=[types.Part(function_call=types.FunctionCall(id=fid, name="calc", args={"x": 1}))]))
    yield ev(content=types.Content(role="user",
             parts=[types.Part(function_response=types.FunctionResponse(id=fid, name="calc", response={"r": 2}))]))
    yield ev(actions=EventActions(state_delta={f"{name}_done": True}, escalate=escalate))


class RichAgent(BaseAgent):
    """A node that reasons, talks, calls a tool, returns the result and writes
    state. Sleeps between events so ParallelAgent branches actually interleave."""

    async def _run_async_impl(self, ctx):
        for e in _rich_events(self.name, branch=ctx.branch):
            await asyncio.sleep(0)
            yield e


class RichStopAgent(BaseAgent):
    """Like RichAgent, but escalates on its last event (terminates a LoopAgent)."""

    async def _run_async_impl(self, ctx):
        for e in _rich_events(self.name, branch=ctx.branch, escalate=True):
            yield e


class CustomFlow(BaseAgent):
    """An ADK *custom agent* (https://adk.dev/agents/custom-agents/): a BaseAgent
    that orchestrates its sub-agents with code-based control flow in
    `_run_async_impl`, instead of using SequentialAgent/ParallelAgent/LoopAgent."""

    def __init__(self, name, a, b, c):
        super().__init__(name=name, sub_agents=[a, b, c])

    async def _run_async_impl(self, ctx):
        async for e in self.sub_agents[0].run_async(ctx):
            yield e
        # code-based decision branching (the "dynamic" style done by hand)
        if True:
            async for e in self.sub_agents[1].run_async(ctx):
                yield e
        async for e in self.sub_agents[2].run_async(ctx):
            yield e


async def _run_steps(agent_obj, emit=True):
    """Run agent_obj through ADKAgent; return (full_stream, steps_only) as
    lists of (event_type, step_name)."""
    agent = ADKAgent(adk_agent=agent_obj, app_name="demo", user_id="u",
                     use_in_memory_services=True, emit_workflow_steps=emit)
    inp = RunAgentInput(thread_id="t", run_id="r", state={},
                        messages=[UserMessage(id="u1", role="user", content="go")],
                        tools=[], context=[], forwarded_props={})
    full = []
    async for ev in agent.run(inp):
        full.append((ev.type, getattr(ev, "step_name", None)))
    steps = [(t, n) for t, n in full if t in _STEP]
    return full, steps


def _well_formed(step_seq):
    """Mirror the AG-UI client verifier (verify.ts): active steps are tracked by
    name — a name can't be started while already active, can't be finished unless
    active, and none may be left open. Overlapping steps with distinct names (as
    ParallelAgent produces) are valid."""
    active = set()
    for t, n in step_seq:
        if t == EventType.STEP_STARTED:
            if n in active:
                return False
            active.add(n)
        else:
            if n not in active:
                return False
            active.discard(n)
    return not active


def _rich_types(seg):
    """The rich event types expected from a node, honoring thought-support."""
    from ag_ui_adk.event_translator import _check_thought_support
    expected = {
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_RESULT,
        EventType.STATE_DELTA,
    }
    if _check_thought_support():
        expected.add(EventType.REASONING_MESSAGE_CONTENT)
    return expected


def _assert_bracketed(full, names):
    """Each named node's STEP bracket wraps that node's full event variety
    (reasoning/text/tool call/result/state) with no other node's steps inside.
    Only valid for serial topologies (a node's events are contiguous)."""
    for name in names:
        i = full.index((EventType.STEP_STARTED, name))
        j = full.index((EventType.STEP_FINISHED, name))
        assert i < j, f"{name}: STEP_STARTED must precede STEP_FINISHED"
        seg = [t for t, _ in full[i + 1:j]]
        assert (EventType.STEP_STARTED not in seg) and (EventType.STEP_FINISHED not in seg), \
            f"{name}: another node's step leaked inside the bracket"
        assert _rich_types(seg).issubset(set(seg)), f"{name}: step did not bracket the full event variety"


def _assert_rich_present(full):
    """The run carried the full rich event variety somewhere (used for
    interleaved ParallelAgent, where per-bracket containment doesn't apply)."""
    seen = {t for t, _ in full}
    assert _rich_types(seen).issubset(seen), "rich event variety missing from the run"


# ---------------------------------------------------------------------------
# Serial topologies — each node's step brackets its full event variety
# ---------------------------------------------------------------------------

async def test_sequential_agent_brackets_each_rich_sub_agent():
    full, steps = await _run_steps(
        SequentialAgent(name="seq", sub_agents=[RichAgent(name="a"), RichAgent(name="b"), RichAgent(name="c")])
    )
    assert steps == [
        (EventType.STEP_STARTED, "a"), (EventType.STEP_FINISHED, "a"),
        (EventType.STEP_STARTED, "b"), (EventType.STEP_FINISHED, "b"),
        (EventType.STEP_STARTED, "c"), (EventType.STEP_FINISHED, "c"),
    ]
    assert full[0][0] == EventType.RUN_STARTED and full[-1][0] == EventType.RUN_FINISHED
    _assert_bracketed(full, ["a", "b", "c"])


async def test_loop_agent_re_emits_rich_steps_per_iteration():
    full, steps = await _run_steps(
        LoopAgent(name="loop", max_iterations=2, sub_agents=[RichAgent(name="x"), RichAgent(name="y")])
    )
    assert [n for t, n in steps if t == EventType.STEP_STARTED] == ["x", "y", "x", "y"]
    assert _well_formed(steps)
    _assert_bracketed(full, ["x", "y"])  # first iteration's brackets


async def test_loop_agent_escalate_stops_early_rich():
    full, steps = await _run_steps(
        LoopAgent(name="loop2", max_iterations=5, sub_agents=[RichAgent(name="w"), RichStopAgent(name="stopper")])
    )
    assert [n for t, n in steps if t == EventType.STEP_STARTED] == ["w", "stopper"]
    assert _well_formed(steps)
    _assert_bracketed(full, ["w", "stopper"])


async def test_custom_agent_brackets_each_rich_sub_agent():
    flow = CustomFlow("custom_flow", RichAgent(name="alpha"), RichAgent(name="beta"), RichAgent(name="gamma"))
    full, steps = await _run_steps(flow)
    assert steps == [
        (EventType.STEP_STARTED, "alpha"), (EventType.STEP_FINISHED, "alpha"),
        (EventType.STEP_STARTED, "beta"), (EventType.STEP_FINISHED, "beta"),
        (EventType.STEP_STARTED, "gamma"), (EventType.STEP_FINISHED, "gamma"),
    ]
    _assert_bracketed(full, ["alpha", "beta", "gamma"])


async def test_adk_2_0_workflow_graph_brackets_each_rich_node():
    """ADK 2.0 Workflow graph engine (START -> na -> nb) with rich nodes."""
    try:
        from google.adk.workflow import Workflow, Edge, START, node
    except ImportError:
        pytest.skip("ADK 2.0 Workflow graph engine not available on this ADK version")

    na = node(RichAgent(name="na"))
    nb = node(RichAgent(name="nb"))
    wf = Workflow(name="graph", edges=[
        Edge(from_node=START, to_node=na),
        Edge(from_node=na, to_node=nb),
    ])
    full, steps = await _run_steps(wf)
    assert steps == [
        (EventType.STEP_STARTED, "na"), (EventType.STEP_FINISHED, "na"),
        (EventType.STEP_STARTED, "nb"), (EventType.STEP_FINISHED, "nb"),
    ]
    _assert_bracketed(full, ["na", "nb"])


# ---------------------------------------------------------------------------
# Parallel / nested — one step per concurrent branch (kept open via ADK branch)
# ---------------------------------------------------------------------------

async def test_parallel_agent_emits_one_step_per_branch():
    """ParallelAgent: each concurrent branch gets exactly one step. ADK assigns a
    distinct branch per sub-agent (e.g. "par.p"), so the sibling steps stay open
    together and each opens/closes exactly once — no thrashing — while the rich
    content flows. Overlapping distinct-named steps are valid per the verifier."""
    full, steps = await _run_steps(
        ParallelAgent(name="par", sub_agents=[RichAgent(name="p"), RichAgent(name="q")])
    )
    assert _well_formed(steps)
    starts = sorted(n for t, n in steps if t == EventType.STEP_STARTED)
    finishes = sorted(n for t, n in steps if t == EventType.STEP_FINISHED)
    assert starts == ["p", "q"] and finishes == ["p", "q"]  # each branch exactly once
    _assert_rich_present(full)


async def test_nested_parallel_closes_before_next_sequential_node():
    nested = SequentialAgent(name="root", sub_agents=[
        ParallelAgent(name="par", sub_agents=[RichAgent(name="p"), RichAgent(name="q")]),
        RichAgent(name="c"),
    ])
    full, steps = await _run_steps(nested)
    assert _well_formed(steps)
    assert sorted(n for t, n in steps if t == EventType.STEP_STARTED) == ["c", "p", "q"]
    # Both parallel branches finish before the next sequential node opens.
    c_start = steps.index((EventType.STEP_STARTED, "c"))
    finished_before_c = {n for t, n in steps[:c_start] if t == EventType.STEP_FINISHED}
    assert {"p", "q"}.issubset(finished_before_c)
    assert steps[-2:] == [(EventType.STEP_STARTED, "c"), (EventType.STEP_FINISHED, "c")]
    _assert_bracketed(full, ["c"])   # the trailing serial node brackets cleanly
    _assert_rich_present(full)


async def test_nested_parallel_all_branches_concurrent():
    """ParallelAgent of a ParallelAgent + a leaf: every leaf is a concurrent
    branch, so all their steps open together and the stream stays well-formed."""
    wf = ParallelAgent(name="outer", sub_agents=[
        ParallelAgent(name="inner", sub_agents=[RichAgent(name="x"), RichAgent(name="y")]),
        RichAgent(name="z"),
    ])
    full, steps = await _run_steps(wf)
    assert _well_formed(steps)
    assert sorted(n for t, n in steps if t == EventType.STEP_STARTED) == ["x", "y", "z"]
    _assert_rich_present(full)


async def test_loop_of_parallel_merges_across_iterations():
    """Documented behavior: a ParallelAgent inside a LoopAgent yields ONE step per
    branch spanning the whole loop, not one per iteration. The concurrent branches
    keep the same ADK `branch` (e.g. `par.p`) across iterations and the flat event
    stream has no iteration-boundary signal, so there is nothing to close/reopen on
    — unlike a *serial* loop body, where the author changes each iteration. Still
    spec-valid (well-formed)."""
    wf = LoopAgent(name="loop", max_iterations=2, sub_agents=[
        ParallelAgent(name="par", sub_agents=[RichAgent(name="p"), RichAgent(name="q")]),
    ])
    _full, steps = await _run_steps(wf)
    assert _well_formed(steps)
    # one step per branch for the whole loop (not per iteration)
    assert sorted(n for t, n in steps if t == EventType.STEP_STARTED) == ["p", "q"]


async def test_steps_close_before_run_level_snapshots():
    """The final STEP_FINISHED must precede the run-level STATE_SNAPSHOT and
    MESSAGES_SNAPSHOT, so those run-level events are not nested inside the last
    node's step bracket."""
    agent = ADKAgent(
        adk_agent=SequentialAgent(name="seq", sub_agents=[RichAgent(name="a"), RichAgent(name="b")]),
        app_name="demo", user_id="u", use_in_memory_services=True,
        emit_workflow_steps=True, emit_messages_snapshot=True,
    )
    inp = RunAgentInput(thread_id="t", run_id="r", state={},
                        messages=[UserMessage(id="u1", role="user", content="go")],
                        tools=[], context=[], forwarded_props={})
    types_seq = [ev.type async for ev in agent.run(inp)]

    finished = [i for i, t in enumerate(types_seq) if t == EventType.STEP_FINISHED]
    snapshots = [i for i, t in enumerate(types_seq)
                 if t in (EventType.STATE_SNAPSHOT, EventType.MESSAGES_SNAPSHOT)]
    assert finished and snapshots
    assert max(finished) < min(snapshots)  # every step closes before any run-level snapshot
    assert types_seq[-1] == EventType.RUN_FINISHED


# ---------------------------------------------------------------------------
# Backward-compat — no steps
# ---------------------------------------------------------------------------

async def test_single_agent_emits_no_steps():
    # A lone BaseAgent (no sub_agents) is not a workflow -> no steps even with flag on.
    _full, steps = await _run_steps(RichAgent(name="solo"))
    assert steps == []


async def test_flag_off_emits_no_steps_for_workflow():
    _full, steps = await _run_steps(
        SequentialAgent(name="seq", sub_agents=[RichAgent(name="a"), RichAgent(name="b")]),
        emit=False,
    )
    assert steps == []

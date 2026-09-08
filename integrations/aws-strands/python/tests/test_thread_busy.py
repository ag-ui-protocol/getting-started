"""A second run on a conversation already streaming must be refused.

Strands cannot multiplex one ``Agent`` across invocations, and both bridges
cache one agent per conversation, so two overlapping runs would drive the same
instance. The collision is refused up front with a protocol-shaped
``RUN_ERROR``.

The damage the refusal prevents is demonstrated, not inferred:
``test_an_accepted_overlap_corrupts_the_shared_history`` drives two overlapping
runs through a real ``strands.Agent`` over a real ``Model`` and reads the
wreckage out of the shared message list. That demo needs the collision to land
silently, so it skips on Strands 1.22.0 and above, where ``stream_async`` takes
its own non-blocking lock and raises ``ConcurrencyException`` instead. The guard
still earns its place there: this adapter replays history into the shared agent
BEFORE the SDK reaches that lock, so the history is corrupted either way and
only the silence goes away.

The disconnect path is pinned against the real SDK too: a retry must not inherit
the abandoned run's in-flight mutations, which holds only if the run tears down
before the slot is freed.

A resume of a paused run is not a second concurrent run: the pause ends the run,
and the slot is freed when that run's generator finishes tearing down, which is
a step later than the ``RUN_FINISHED`` the client sees. The real-SDK
pause-then-resume flows in ``test_interrupt.py`` cover that end to end.
"""

from __future__ import annotations

import asyncio
import copy
from contextlib import asynccontextmanager
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from ag_ui.core import (
    AssistantMessage,
    Context,
    EventType,
    ResumeEntry,
    RunAgentInput,
    UserMessage,
)
from ag_ui_strands import agent as agent_module
from ag_ui_strands.agent import StrandsAgent
from strands import Agent
from strands.agent.state import AgentState
from strands.models.model import Model
from strands.tools.registry import ToolRegistry

def _busy_message(thread_id: str) -> str:
    """The refusal text, spelled out here so a reworded source string fails."""
    return (
        f'Another run is already in progress on thread "{thread_id}". Wait for '
        "RUN_FINISHED before starting another."
    )


BUSY_MESSAGE = _busy_message("thread-a")


def _mock_model():
    model = MagicMock()
    model.stateful = False
    return model


def _run_input(
    thread_id: str, *, resume=None, run_id=None, messages=None, context=None
) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id or f"run-{thread_id}",
        state={},
        messages=messages or [UserMessage(id=f"user-{thread_id}", content="hello")],
        tools=[],
        context=context or [],
        forwarded_props={},
        resume=resume,
    )


def _second_turn(thread_id: str) -> list:
    """A follow-up request, longer than the first so a replay of it is visible."""
    return [
        UserMessage(id=f"user-{thread_id}", content="hello"),
        AssistantMessage(id=f"assistant-{thread_id}", content="hi"),
        UserMessage(id=f"user-{thread_id}-2", content="again"),
    ]


class _GatedCore:
    """A Strands core that parks the FIRST instance inside ``stream_async``.

    Parking only the first instance is what makes a cross-thread overlap real:
    thread-a's core holds its slot while thread-b's core streams to completion
    on the same event loop.
    """

    entered: ClassVar[asyncio.Event]
    release: ClassVar[asyncio.Event]
    instances: ClassVar[list]
    streaming: ClassVar[list]
    peak_streaming: ClassVar[int]

    def __init__(self, **_kwargs):
        self.tool_registry = ToolRegistry()
        self.state = AgentState()
        self.messages = []
        self.index = len(type(self).instances)
        type(self).instances.append(self)

    async def stream_async(self, prompt, **kwargs):
        cls = type(self)
        cls.streaming.append(self.index)
        cls.peak_streaming = max(cls.peak_streaming, len(cls.streaming))
        try:
            # Yield before parking so a consumer can reach a suspended-at-yield
            # run generator, which is the state a disconnect abandons.
            yield {"data": "streaming"}
            if self.index == 0:
                cls.entered.set()
                await cls.release.wait()
        finally:
            cls.streaming.remove(self.index)


def _gate() -> None:
    _GatedCore.entered = asyncio.Event()
    _GatedCore.release = asyncio.Event()
    _GatedCore.instances = []
    _GatedCore.streaming = []
    _GatedCore.peak_streaming = 0


def _adapter() -> StrandsAgent:
    return StrandsAgent(Agent(model=_mock_model()), name="test")


async def _drain(stream) -> list:
    return [event async for event in stream]


async def _pump_to_content(stream) -> list:
    """Consume ``stream`` up to its first text delta, then leave it suspended."""
    seen = []
    # Bounded on both axes: a run that never reaches content fails here rather
    # than hanging a suite with no timeout plugin configured.
    for _ in range(20):
        event = await asyncio.wait_for(stream.__anext__(), timeout=5)
        seen.append(event.type)
        if event.type == EventType.TEXT_MESSAGE_CONTENT:
            return seen
    pytest.fail(f"run never reached TEXT_MESSAGE_CONTENT: {seen}")


@asynccontextmanager
async def _parked(adapter: StrandsAgent, run_input: RunAgentInput):
    """Run ``run_input`` until it parks inside the core, then always clean up.

    The gate is class state a later test replaces, so a body that fails must
    not leave this task waiting on an Event nobody will set again.
    """
    task = asyncio.create_task(_drain(adapter.run(run_input)))
    try:
        await asyncio.wait_for(_GatedCore.entered.wait(), timeout=5)
        yield task
        _GatedCore.release.set()
        await asyncio.wait_for(task, timeout=5)
    finally:
        _GatedCore.release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_a_second_concurrent_run_on_the_same_thread_is_refused():
    _gate()
    adapter = _adapter()

    with patch("ag_ui_strands.agent.StrandsAgentCore", _GatedCore):
        async with _parked(adapter, _run_input("thread-a")):
            # The guard's value is returning BEFORE the body touches the cached
            # core, so the refusal has to be side-effect free: no second core,
            # and the in-flight run's replayed history left exactly as it is.
            core = adapter._agents_by_thread["thread-a"]
            history = core.messages
            length = len(history)
            instances = len(_GatedCore.instances)

            # Bounded: an absent guard makes this a second real invocation
            # rather than a refusal, and the suite fails instead of hanging.
            second = await asyncio.wait_for(
                _drain(
                    adapter.run(
                        _run_input(
                            "thread-a",
                            run_id="run-second",
                            messages=_second_turn("thread-a"),
                        )
                    )
                ),
                timeout=5,
            )

            assert adapter._agents_by_thread["thread-a"] is core
            assert core.messages is history
            assert len(core.messages) == length
            assert len(_GatedCore.instances) == instances

    assert [e.type for e in second] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert second[-1].code == "THREAD_BUSY"
    assert second[-1].message == BUSY_MESSAGE
    # Correlation ids belong to the REFUSED request, not to the run holding the
    # thread: a client can only match the error to what it just sent.
    assert second[0].thread_id == "thread-a"
    assert second[0].run_id == "run-second"


@pytest.mark.asyncio
async def test_a_resume_is_not_an_exemption_while_the_thread_is_busy():
    """A resume answers a run that has already ended, never one still streaming."""
    _gate()
    adapter = _adapter()

    with patch("ag_ui_strands.agent.StrandsAgentCore", _GatedCore):
        async with _parked(adapter, _run_input("thread-a")):
            second = await asyncio.wait_for(
                _drain(
                    adapter.run(
                        _run_input(
                            "thread-a",
                            run_id="run-resume",
                            resume=[
                                ResumeEntry(
                                    interrupt_id="int-1",
                                    status="resolved",
                                    payload="yes",
                                )
                            ],
                        )
                    )
                ),
                timeout=5,
            )

    assert [e.type for e in second] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert second[-1].code == "THREAD_BUSY"
    assert second[-1].message == BUSY_MESSAGE
    assert second[0].run_id == "run-resume"


@pytest.mark.asyncio
async def test_separate_threads_run_concurrently():
    _gate()
    adapter = _adapter()

    with patch("ag_ui_strands.agent.StrandsAgentCore", _GatedCore):
        async with _parked(adapter, _run_input("thread-a")) as first:
            # thread-a is parked inside its core right now, so driving thread-b
            # to RUN_FINISHED here is a genuine overlap. A guard keyed on one
            # process-wide flag instead of per thread refuses this.
            other = await asyncio.wait_for(
                _drain(adapter.run(_run_input("thread-b"))), timeout=5
            )
            assert EventType.RUN_ERROR not in [e.type for e in other]
            assert other[-1].type == EventType.RUN_FINISHED
            assert not first.done()
            assert _GatedCore.peak_streaming == 2

        parked = first.result()

    assert EventType.RUN_ERROR not in [e.type for e in parked]
    assert parked[-1].type == EventType.RUN_FINISHED


@pytest.mark.asyncio
async def test_the_slot_is_released_for_the_next_run_on_the_thread():
    _gate()
    adapter = _adapter()
    _GatedCore.release.set()

    with patch("ag_ui_strands.agent.StrandsAgentCore", _GatedCore):
        await _drain(adapter.run(_run_input("thread-a")))
        second = await _drain(adapter.run(_run_input("thread-a")))

    assert EventType.RUN_ERROR not in [e.type for e in second]
    assert second[-1].type == EventType.RUN_FINISHED


@pytest.mark.asyncio
async def test_the_slot_is_released_when_the_consumer_disconnects():
    """A client that drops mid-run must not wedge the thread against its retry."""
    _gate()
    adapter = _adapter()

    with patch("ag_ui_strands.agent.StrandsAgentCore", _GatedCore):
        abandoned = adapter.run(_run_input("thread-a"))
        try:
            # The run holds the thread once it reaches content: its core
            # invocation is under way.
            await _pump_to_content(abandoned)
        finally:
            # Abandoning the generator is what the endpoint does on disconnect.
            await abandoned.aclose()

        _GatedCore.release.set()
        retry = await asyncio.wait_for(
            _drain(adapter.run(_run_input("thread-a"))), timeout=5
        )

    assert EventType.RUN_ERROR not in [e.type for e in retry]
    assert retry[-1].type == EventType.RUN_FINISHED


def _sdk_refuses_overlap() -> bool:
    """Whether the installed Strands refuses an overlapping ``stream_async``.

    Strands 1.22.0 added a non-blocking invocation lock and the exception it
    raises when the lock is already held, so the presence of that exception is
    the capability probe. 1.27.0 made the behaviour configurable via
    ``concurrent_invocation_mode``, which still defaults to raising.
    """
    try:
        from strands.types.exceptions import ConcurrencyException  # noqa: F401
    except ImportError:
        return False
    return True


_SDK_REFUSES_OVERLAP = _sdk_refuses_overlap()


class _ParkingModel(Model):
    """A real Strands model whose FIRST call parks mid-stream until released.

    It parks AFTER a text delta, so a consumer can reach real content while the
    model call is still open. That is the state a disconnect abandons.
    """

    def __init__(self):
        self.parked = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0
        self.seen: list = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        self.seen.append(copy.deepcopy(messages))
        text = f"answer-{self.calls}"
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": text}}}
        if self.calls == 1:
            self.parked.set()
            await self.release.wait()
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def _real_adapter() -> tuple:
    model = _ParkingModel()
    return StrandsAgent(Agent(model=model, callback_handler=None), name="test"), model


def _turn(n: int, *, context=None) -> RunAgentInput:
    return _run_input(
        "t",
        run_id=f"run-{n}",
        messages=[UserMessage(id=f"user-{n}", content=f"q{n}")],
        context=context,
    )


def _context_hits(messages, needle: str) -> int:
    return sum(
        needle in block.get("text", "")
        for message in messages or []
        for block in (message.get("content") or [])
        if isinstance(block, dict)
    )


def _shape(core) -> tuple:
    roles = [message.get("role") for message in core.messages]
    texts = [
        block["text"]
        for message in core.messages
        for block in (message.get("content") or [])
        if isinstance(block, dict) and "text" in block
    ]
    return roles, texts


@pytest.mark.skipif(
    _SDK_REFUSES_OVERLAP,
    reason=(
        "Strands >= 1.22.0 raises ConcurrencyException on an overlapping "
        "stream_async, so the collision cannot be staged silently. The history "
        "is still corrupted there: replay runs before the SDK takes its lock."
    ),
)
@pytest.mark.asyncio
async def test_an_accepted_overlap_corrupts_the_shared_history():
    """What the guard prevents, shown against the real SDK.

    Both halves drive the same two overlapping runs over a real
    ``strands.Agent``. The first calls ``_run_raw`` DELIBERATELY, to bypass the
    guard and let the collision land; the second goes through the public ``run``
    and is refused.
    """
    adapter, model = _real_adapter()

    first = asyncio.create_task(_drain(adapter._run_raw(_turn(1))))
    try:
        await asyncio.wait_for(model.parked.wait(), timeout=5)
        second = await asyncio.wait_for(_drain(adapter._run_raw(_turn(2))), timeout=5)
        assert second[-1].type == EventType.RUN_FINISHED
        model.release.set()
        await asyncio.wait_for(first, timeout=5)
    finally:
        model.release.set()
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)

    # The second run replayed its own history over the shared list, so the first
    # run's question is gone and its answer landed on the wrong conversation.
    roles, texts = _shape(adapter._agents_by_thread["t"])
    assert roles == ["user", "assistant", "assistant"]
    assert texts == ["q2", "answer-2", "answer-1"]


@pytest.mark.asyncio
async def test_the_guard_keeps_the_shared_history_clean_under_the_same_overlap():
    """The other half of the demonstration, and it needs no particular SDK.

    Refusing the overlap is what keeps the history intact, so this asserts the
    refusal and the clean history together against a real agent. Unlike the
    corruption above it stages nothing silently, so it runs on every SDK this
    package accepts.
    """
    guarded, model = _real_adapter()

    task = asyncio.create_task(_drain(guarded.run(_turn(1))))
    try:
        await asyncio.wait_for(model.parked.wait(), timeout=5)
        refused = await asyncio.wait_for(_drain(guarded.run(_turn(2))), timeout=5)
        model.release.set()
        held = await asyncio.wait_for(task, timeout=5)
    finally:
        model.release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    assert [e.type for e in refused] == [EventType.RUN_STARTED, EventType.RUN_ERROR]
    assert refused[-1].code == "THREAD_BUSY"
    assert refused[-1].message == _busy_message("t")
    assert held[-1].type == EventType.RUN_FINISHED
    # The refused run never reached the model, so the shared history carries one
    # exchange rather than two runs' turns interleaved.
    assert model.calls == 1
    assert _shape(guarded._agents_by_thread["t"]) == (
        ["user", "assistant"],
        ["q1", "answer-1"],
    )


@pytest.mark.asyncio
async def test_a_disconnect_tears_the_run_down_before_the_thread_is_free():
    """The retry must not inherit the abandoned run's in-flight mutations.

    Live request context is spliced into the shared message list for the
    duration of one model call and taken back out after it, so a client that
    drops mid-call leaves that splice standing. Releasing the slot before the
    abandoned run's teardown has run hands the thread to a retry that starts
    from a half-mutated agent.
    """
    adapter, model = _real_adapter()
    context = [Context(description="live", value="ctx-block")]
    # The run undoes its context splice as part of teardown, so sampling the
    # busy set from inside that step is what distinguishes "torn down, then
    # freed" from "freed, then torn down". Read afterwards the two are
    # indistinguishable.
    held_during_teardown: list = []
    real_restore = agent_module._restore_transient_model_context

    def _watching_restore(agent):
        held_during_teardown.append("t" in adapter._active_runs_by_thread)
        return real_restore(agent)

    with patch.object(
        agent_module, "_restore_transient_model_context", _watching_restore
    ):
        abandoned = adapter.run(_turn(1, context=context))
        try:
            await _pump_to_content(abandoned)
            core = adapter._agents_by_thread["t"]
            # Mid-model-call: the context splice is standing right now.
            assert _context_hits(core.messages, "ctx-block") == 1
        finally:
            await abandoned.aclose()

    # Asserted with no intervening await: the run undoes this itself while
    # closing. A teardown left to the garbage collector instead only gets its
    # turn on some later loop iteration, by which point the retry is under way.
    assert _context_hits(core.messages, "ctx-block") == 0
    assert "t" not in adapter._active_runs_by_thread
    assert held_during_teardown and all(held_during_teardown)

    model.release.set()
    retry = await asyncio.wait_for(
        _drain(adapter.run(_turn(2, context=context))), timeout=5
    )

    assert EventType.RUN_ERROR not in [e.type for e in retry]
    assert retry[-1].type == EventType.RUN_FINISHED
    # The retry's model call saw its own splice once, not stacked on the
    # abandoned run's leftovers.
    assert _context_hits(model.seen[-1], "ctx-block") == 1

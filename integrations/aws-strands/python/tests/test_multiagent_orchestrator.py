"""Multi-agent orchestrator (Graph / Swarm) support in StrandsAgent.

Two layers of coverage:

* Translation, driven by a fake orchestrator that replays a scripted event
  list, so the exact ORDER and PAYLOAD of the emitted AG-UI events is pinned.
* Runtime, driven by a real ``strands.multiagent`` Graph over a scripted
  model, so support is gated on the SDK actually emitting these events rather
  than on the symbols merely existing.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import pytest
from ag_ui.core import EventType
from strands.models.model import Model

from ag_ui_strands.agent import StrandsAgent


class FakeOrchestrator:
    """Graph/Swarm stand-in with the shape the adapter detects.

    A real Graph or Swarm has no ``model``, owns a ``nodes`` collection, and
    streams through ``stream_async``. All three are reproduced here, because
    all three are what routes StrandsAgent down the orchestrator path.
    """

    def __init__(self, events: list, raises: BaseException | None = None):
        self.id = "test-graph"
        self.nodes = {}
        self.events = events
        self.raises = raises
        self.prompts: list[Any] = []
        self.closed = False

    async def stream_async(self, task, invocation_state=None, **kwargs):
        self.prompts.append(task)
        try:
            for event in self.events:
                yield event
            if self.raises is not None:
                raise self.raises
        finally:
            self.closed = True


@dataclass
class FakeMessage:
    role: str
    content: Any


class FakeInput:
    def __init__(self, messages=None, state=None, forwarded_props=None):
        self.thread_id = "test-thread"
        self.run_id = "test-run"
        self.state = state
        self.messages = messages or []
        self.tools = []
        self.context = []
        self.forwarded_props = forwarded_props or {}


def node_stream(node_id: str, inner: dict) -> dict:
    return {"type": "multiagent_node_stream", "node_id": node_id, "event": inner}


async def collect(agent: StrandsAgent, input_data=None) -> list:
    return [e async for e in agent.run(input_data or FakeInput())]


async def _drain(stream) -> list:
    return [e async for e in stream]


def shape(events: list) -> list:
    """Ordered (type, salient payload) view used for exact-sequence asserts."""
    out = []
    for e in events:
        t = e.type
        if t in (EventType.STEP_STARTED, EventType.STEP_FINISHED):
            out.append((t, e.step_name))
        elif t == EventType.TEXT_MESSAGE_CONTENT:
            out.append((t, e.delta))
        elif t == EventType.REASONING_MESSAGE_CONTENT:
            out.append((t, e.delta))
        elif t == EventType.CUSTOM:
            out.append((t, e.name, e.value))
        else:
            out.append((t,))
    return out


def make_agent(orchestrator: FakeOrchestrator) -> StrandsAgent:
    return StrandsAgent(orchestrator, name="test", description="test")


# ---------------------------------------------------------------------------
# Orchestrator detection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_orchestrator_path_chosen_when_agent_has_no_model():
    orchestrator = FakeOrchestrator([])
    agent = make_agent(orchestrator)

    assert agent._orchestrator is orchestrator

    events = await collect(agent)
    types = [e.type for e in events]

    # An empty orchestrator run is still a well-formed run: no attempt is made
    # to clone a template agent (which would fail on the missing model/tools).
    assert types[0] == EventType.RUN_STARTED
    assert types[-1] == EventType.RUN_FINISHED
    assert EventType.RUN_ERROR not in types


@pytest.mark.asyncio
async def test_real_agent_still_takes_the_single_agent_path():
    from unittest.mock import MagicMock

    class MockAgent:
        def __init__(self):
            self.model = MagicMock()
            self.system_prompt = "test"
            self.tool_registry = MagicMock()
            self.tool_registry.registry = {}

        async def stream_async(self, message):
            yield {"data": "hi"}

    agent = StrandsAgent(MockAgent(), name="test")
    assert agent._orchestrator is None


# ---------------------------------------------------------------------------
# Translation: order and payload
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_graph_run_emits_exact_event_sequence():
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "researcher", "node_type": "agent"},
            node_stream("researcher", {"data": "Found it."}),
            {"type": "multiagent_node_stop", "node_id": "researcher"},
            {
                "type": "multiagent_handoff",
                "from_node_ids": ["researcher"],
                "to_node_ids": ["writer"],
            },
            {"type": "multiagent_node_start", "node_id": "writer", "node_type": "agent"},
            node_stream("writer", {"data": "Final answer."}),
            {"type": "multiagent_node_stop", "node_id": "writer"},
        ]
    )

    events = await collect(make_agent(orchestrator))

    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "agent:researcher"),
        (EventType.TEXT_MESSAGE_START,),
        (EventType.TEXT_MESSAGE_CONTENT, "Found it."),
        (EventType.TEXT_MESSAGE_END,),
        (EventType.STEP_FINISHED, "agent:researcher"),
        (
            EventType.CUSTOM,
            "MultiAgentHandoff",
            {"from_nodes": ["researcher"], "to_nodes": ["writer"], "message": None},
        ),
        (EventType.STEP_STARTED, "agent:writer"),
        (EventType.TEXT_MESSAGE_START,),
        (EventType.TEXT_MESSAGE_CONTENT, "Final answer."),
        (EventType.TEXT_MESSAGE_END,),
        (EventType.STEP_FINISHED, "agent:writer"),
        (EventType.RUN_FINISHED,),
    ]


@pytest.mark.asyncio
async def test_each_node_gets_its_own_message_id():
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            node_stream("a", {"data": "one"}),
            {"type": "multiagent_node_stop", "node_id": "a"},
            {"type": "multiagent_node_start", "node_id": "b", "node_type": "agent"},
            node_stream("b", {"data": "two"}),
            {"type": "multiagent_node_stop", "node_id": "b"},
        ]
    )

    events = await collect(make_agent(orchestrator))
    starts = [e.message_id for e in events if e.type == EventType.TEXT_MESSAGE_START]

    assert len(starts) == 2
    assert starts[0] != starts[1]


@pytest.mark.asyncio
async def test_step_finished_reuses_node_type_from_start():
    # The SDK's stop event carries only node_id. Rebuilding the name from the
    # stop event alone would yield "agent:planner" and break the pairing that
    # frontends rely on to close the step.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "planner", "node_type": "swarm"},
            {"type": "multiagent_node_stop", "node_id": "planner"},
        ]
    )

    events = await collect(make_agent(orchestrator))
    starts = [e.step_name for e in events if e.type == EventType.STEP_STARTED]
    stops = [e.step_name for e in events if e.type == EventType.STEP_FINISHED]

    assert starts == ["swarm:planner"]
    assert stops == ["swarm:planner"]


@pytest.mark.asyncio
async def test_handoff_forwards_swarm_message():
    orchestrator = FakeOrchestrator(
        [
            {
                "type": "multiagent_handoff",
                "from_node_ids": ["a"],
                "to_node_ids": ["b"],
                "message": "passing the baton",
            }
        ]
    )

    events = await collect(make_agent(orchestrator))
    customs = [e for e in events if e.type == EventType.CUSTOM]

    assert [e.name for e in customs] == ["MultiAgentHandoff"]
    assert customs[0].value == {
        "from_nodes": ["a"],
        "to_nodes": ["b"],
        "message": "passing the baton",
    }


@pytest.mark.asyncio
async def test_reasoning_stream_is_translated_and_closed_on_node_stop():
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "thinker", "node_type": "agent"},
            node_stream("thinker", {"reasoningText": "Let me think", "reasoning": True}),
            node_stream("thinker", {"reasoningText": " harder.", "reasoning": True}),
            {"type": "multiagent_node_stop", "node_id": "thinker"},
        ]
    )

    events = await collect(make_agent(orchestrator))

    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "agent:thinker"),
        (EventType.REASONING_START,),
        (EventType.REASONING_MESSAGE_START,),
        (EventType.REASONING_MESSAGE_CONTENT, "Let me think"),
        (EventType.REASONING_MESSAGE_CONTENT, " harder."),
        (EventType.REASONING_MESSAGE_END,),
        (EventType.REASONING_END,),
        (EventType.STEP_FINISHED, "agent:thinker"),
        (EventType.RUN_FINISHED,),
    ]


# ---------------------------------------------------------------------------
# Concurrency, ordering and failure surfacing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_interleaved_nodes_keep_separate_message_envelopes():
    # A Graph runs a batch of nodes as concurrent tasks multiplexed into one
    # queue, so their stream events arrive interleaved. Each node's text must
    # stay in its own envelope, and one node stopping must not close another's.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            {"type": "multiagent_node_start", "node_id": "b", "node_type": "agent"},
            node_stream("a", {"data": "alpha-one "}),
            node_stream("b", {"data": "beta-one "}),
            node_stream("a", {"data": "alpha-two"}),
            {"type": "multiagent_node_stop", "node_id": "a"},
            node_stream("b", {"data": "beta-two"}),
            {"type": "multiagent_node_stop", "node_id": "b"},
        ]
    )

    events = await collect(make_agent(orchestrator))

    by_id: dict[str, str] = {}
    for e in events:
        if e.type == EventType.TEXT_MESSAGE_CONTENT:
            by_id[e.message_id] = by_id.get(e.message_id, "") + e.delta

    # Two distinct envelopes, neither carrying the other node's text.
    assert sorted(by_id.values()) == ["alpha-one alpha-two", "beta-one beta-two"]

    # `b` kept streaming after `a` stopped, so its END must come after that
    # content rather than being closed early by a's stop.
    order = [
        (e.type, getattr(e, "message_id", None))
        for e in events
        if e.type
        in (
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
        )
    ]
    b_id = next(mid for mid, text in by_id.items() if text.startswith("beta"))
    b_positions = [i for i, (_, mid) in enumerate(order) if mid == b_id]
    assert order[b_positions[0]][0] == EventType.TEXT_MESSAGE_START
    assert order[b_positions[-1]][0] == EventType.TEXT_MESSAGE_END
    assert sum(1 for t, mid in order if mid == b_id and t == EventType.TEXT_MESSAGE_END) == 1


@pytest.mark.asyncio
async def test_failure_mid_stream_closes_the_open_message_and_step():
    # A Graph fails fast: the first node exception cancels its siblings and
    # re-raises, so a raise landing while a node is mid-text is routine.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            node_stream("a", {"data": "half a sen"}),
        ],
        raises=RuntimeError("node exploded"),
    )

    events = await collect(make_agent(orchestrator))

    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "agent:a"),
        (EventType.TEXT_MESSAGE_START,),
        (EventType.TEXT_MESSAGE_CONTENT, "half a sen"),
        (EventType.TEXT_MESSAGE_END,),
        # The node never finished, so its step closing must not read as success.
        (
            EventType.CUSTOM,
            "MultiAgentNodeStatus",
            {"node_id": "a", "status": "failed"},
        ),
        (EventType.STEP_FINISHED, "agent:a"),
        (EventType.RUN_ERROR,),
    ]


@pytest.mark.asyncio
async def test_failure_mid_reasoning_closes_the_reasoning_envelope():
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            node_stream("a", {"reasoningText": "thinking", "reasoning": True}),
        ],
        raises=RuntimeError("boom"),
    )

    events = await collect(make_agent(orchestrator))

    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "agent:a"),
        (EventType.REASONING_START,),
        (EventType.REASONING_MESSAGE_START,),
        (EventType.REASONING_MESSAGE_CONTENT, "thinking"),
        (EventType.REASONING_MESSAGE_END,),
        (EventType.REASONING_END,),
        (
            EventType.CUSTOM,
            "MultiAgentNodeStatus",
            {"node_id": "a", "status": "failed"},
        ),
        (EventType.STEP_FINISHED, "agent:a"),
        (EventType.RUN_ERROR,),
    ]


@pytest.mark.asyncio
async def test_reasoning_closes_before_the_answer_it_precedes():
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            node_stream("a", {"reasoningText": "let me think", "reasoning": True}),
            node_stream("a", {"data": "the answer"}),
            {"type": "multiagent_node_stop", "node_id": "a"},
        ]
    )

    events = await collect(make_agent(orchestrator))

    # The reasoning envelope closes before the text envelope opens; the two
    # never overlap.
    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "agent:a"),
        (EventType.REASONING_START,),
        (EventType.REASONING_MESSAGE_START,),
        (EventType.REASONING_MESSAGE_CONTENT, "let me think"),
        (EventType.REASONING_MESSAGE_END,),
        (EventType.REASONING_END,),
        (EventType.TEXT_MESSAGE_START,),
        (EventType.TEXT_MESSAGE_CONTENT, "the answer"),
        (EventType.TEXT_MESSAGE_END,),
        (EventType.STEP_FINISHED, "agent:a"),
        (EventType.RUN_FINISHED,),
    ]


@pytest.mark.asyncio
async def test_failed_node_reports_its_status():
    # A node can stop FAILED without the stream raising (a cancelling hook, a
    # node timeout, an execution limit). STEP_FINISHED alone reads as success.
    class Status:
        value = "failed"

    class NodeResult:
        status = Status()

    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            {
                "type": "multiagent_node_stop",
                "node_id": "a",
                "node_result": NodeResult(),
            },
        ]
    )

    events = await collect(make_agent(orchestrator))

    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "agent:a"),
        (
            EventType.CUSTOM,
            "MultiAgentNodeStatus",
            {"node_id": "a", "status": "failed"},
        ),
        (EventType.STEP_FINISHED, "agent:a"),
        (EventType.RUN_FINISHED,),
    ]


@pytest.mark.asyncio
async def test_completed_node_reports_no_status():
    class Status:
        value = "completed"

    class NodeResult:
        status = Status()

    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            {
                "type": "multiagent_node_stop",
                "node_id": "a",
                "node_result": NodeResult(),
            },
        ]
    )

    events = await collect(make_agent(orchestrator))
    customs = [e for e in events if e.type == EventType.CUSTOM]

    assert customs == []


@pytest.mark.asyncio
async def test_second_run_on_a_busy_thread_is_rejected():
    # An orchestrator's node agents reject overlapping invocations, so the
    # collision is refused up front instead of surfacing as a raw SDK error.
    started = asyncio.Event()
    release = asyncio.Event()

    class ParkedOrchestrator:
        id = "parked"
        nodes: dict = {}

        async def stream_async(self, task, invocation_state=None, **kwargs):
            started.set()
            await release.wait()
            yield {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"}

    agent = StrandsAgent(ParkedOrchestrator(), name="test")

    async def first():
        return [e async for e in agent.run(FakeInput())]

    task = asyncio.create_task(first())
    await asyncio.wait_for(started.wait(), timeout=5)

    # Bounded: if the guard regresses, the second run blocks on the parked
    # orchestrator, and this fails rather than hanging the suite.
    second = await asyncio.wait_for(
        _drain(agent.run(FakeInput())), timeout=5
    )
    release.set()
    await asyncio.wait_for(task, timeout=5)

    assert [e.type for e in second] == [
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
    ]
    assert second[-1].code == "THREAD_BUSY"


@pytest.mark.asyncio
async def test_busy_thread_is_released_for_the_next_run():
    orchestrator = FakeOrchestrator([])
    agent = make_agent(orchestrator)

    await collect(agent)
    second = await collect(agent)

    assert [e.type for e in second][-1] == EventType.RUN_FINISHED
    assert EventType.RUN_ERROR not in [e.type for e in second]


@pytest.mark.asyncio
async def test_list_content_is_flattened_not_repr_ed():
    # Orchestrators take a task string, so a block-list message has to be
    # flattened; str() on the list would send a Python repr to the model.
    orchestrator = FakeOrchestrator([])

    await collect(
        make_agent(orchestrator),
        FakeInput(
            messages=[
                FakeMessage(
                    "user",
                    # Neither block ends in whitespace, so a missing separator
                    # would show up as "summarisethis".
                    [{"type": "text", "text": "summarise"}, {"type": "text", "text": "this"}],
                )
            ]
        ),
    )

    assert orchestrator.prompts == ["summarise this"]


class _ResumeEntry:
    """Resolved resume for the interrupt the fake orchestrators raise."""

    interrupt_id = "i1"
    status = "resolved"
    payload = {"approved": True}


@pytest.mark.asyncio
async def test_node_cancel_emits_custom_event_with_reason():
    # Strands emits cancel, then a FAILED stop, then raises. The cancel event
    # is the only carrier of the reason.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "blocked", "node_type": "agent"},
            {"type": "multiagent_node_cancel", "node_id": "blocked", "message": "policy says no"},
            {"type": "multiagent_node_stop", "node_id": "blocked"},
        ],
        raises=RuntimeError("policy says no"),
    )

    events = await collect(make_agent(orchestrator))

    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "agent:blocked"),
        (
            EventType.CUSTOM,
            "MultiAgentNodeCancel",
            {"node_id": "blocked", "message": "policy says no"},
        ),
        (EventType.STEP_FINISHED, "agent:blocked"),
        (EventType.RUN_ERROR,),
    ]
    assert events[-1].code == "STRANDS_ERROR"
    assert events[-1].message == "policy says no"


@pytest.mark.asyncio
async def test_node_interrupt_emits_custom_event_and_closes_the_open_step():
    class NativeInterrupt:
        def __init__(self):
            self.id = "v1:before_tool_call:t1:abc"
            self.name = "confirm_delete"
            self.reason = "APPROVAL"
            self.response = None

    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "approver", "node_type": "agent"},
            {
                "type": "multiagent_node_interrupt",
                "node_id": "approver",
                "interrupts": [NativeInterrupt()],
            },
        ]
    )

    events = await collect(make_agent(orchestrator))

    # An interrupted node never emits a stop event, so the step is closed by
    # the end-of-stream sweep rather than left running in the UI.
    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "agent:approver"),
        (
            EventType.CUSTOM,
            "MultiAgentNodeInterrupt",
            {
                "node_id": "approver",
                "interrupts": [
                    {
                        "id": "v1:before_tool_call:t1:abc",
                        "name": "confirm_delete",
                        "reason": "APPROVAL",
                    }
                ],
            },
        ),
        (EventType.STEP_FINISHED, "agent:approver"),
        (EventType.RUN_FINISHED,),
    ]


@pytest.mark.asyncio
async def test_interrupt_payload_is_json_serializable():
    class UnserializableReason:
        def __repr__(self):
            return "<opaque>"

    class NativeInterrupt:
        id = "i1"
        name = "custom"
        reason = UnserializableReason()

    orchestrator = FakeOrchestrator(
        [
            {
                "type": "multiagent_node_interrupt",
                "node_id": "n",
                "interrupts": [NativeInterrupt()],
            }
        ]
    )

    events = await collect(make_agent(orchestrator))
    custom = next(e for e in events if e.type == EventType.CUSTOM)

    # Native Interrupt objects never reach the wire.
    json.dumps(custom.value)
    assert custom.value["interrupts"][0]["reason"] == "<opaque>"


# ---------------------------------------------------------------------------
# Run shape: prompt, state, errors, teardown
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prompt_is_the_last_user_turn():
    orchestrator = FakeOrchestrator([])
    agent = make_agent(orchestrator)

    await collect(
        agent,
        FakeInput(
            messages=[
                FakeMessage("user", "first"),
                FakeMessage("assistant", "ignored"),
                FakeMessage("user", "actual task"),
            ]
        ),
    )

    assert orchestrator.prompts == ["actual task"]


@pytest.mark.asyncio
async def test_prompt_defaults_when_there_is_no_user_turn():
    orchestrator = FakeOrchestrator([])
    await collect(make_agent(orchestrator), FakeInput(messages=[]))
    assert orchestrator.prompts == ["Hello"]


@pytest.mark.asyncio
async def test_incoming_state_is_snapshotted_without_messages():
    orchestrator = FakeOrchestrator([])
    events = await collect(
        make_agent(orchestrator),
        FakeInput(state={"topic": "bridges", "messages": ["should be dropped"]}),
    )
    snapshots = [e.snapshot for e in events if e.type == EventType.STATE_SNAPSHOT]

    # Exactly one snapshot: a terminal empty one would wipe what this published.
    assert snapshots == [{"topic": "bridges"}]


@pytest.mark.asyncio
async def test_orchestrator_failure_becomes_run_error():
    orchestrator = FakeOrchestrator([], raises=RuntimeError("graph exploded"))
    events = await collect(make_agent(orchestrator))

    assert events[-1].type == EventType.RUN_ERROR
    assert events[-1].code == "STRANDS_ERROR"
    assert events[-1].message == "graph exploded"


@pytest.mark.asyncio
async def test_adapter_bug_is_reported_separately_from_orchestrator_failure():
    orchestrator = FakeOrchestrator([], raises=AttributeError("no such attr"))
    events = await collect(make_agent(orchestrator))

    assert events[-1].type == EventType.RUN_ERROR
    assert events[-1].code == "ADAPTER_BUG"


@pytest.mark.asyncio
async def test_orchestrator_stream_is_closed_when_the_consumer_bails():
    # Orchestrator streams take no cancel signal, so closing the iterator is
    # the only way to stop one on client disconnect.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            node_stream("a", {"data": "hi"}),
        ]
    )
    agent = make_agent(orchestrator)

    stream = agent.run(FakeInput())
    async for event in stream:
        if event.type == EventType.TEXT_MESSAGE_CONTENT:
            break
    await stream.aclose()

    assert orchestrator.closed is True


@pytest.mark.asyncio
async def test_unknown_and_non_dict_events_are_ignored():
    orchestrator = FakeOrchestrator(
        [
            "not a dict",
            {"type": "multiagent_span", "span": object()},
            {"type": "multiagent_result", "result": object()},
        ]
    )

    events = await collect(make_agent(orchestrator))
    types = [e.type for e in events]

    assert EventType.RUN_ERROR not in types
    assert types[-1] == EventType.RUN_FINISHED


# ---------------------------------------------------------------------------
# Single-agent loop: the same event dicts must not crash it
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_single_agent_loop_handles_cancel_without_crashing():
    # `multiagent_node_cancel` carries `message` as a plain string. The
    # user-message branch further down calls `.get("role")` on `message`, so
    # without a dedicated branch this raised AttributeError.
    from unittest.mock import MagicMock

    class MockAgent:
        def __init__(self, events):
            self.events = events
            self.model = MagicMock()
            self.system_prompt = "test"
            self.tool_registry = MagicMock()
            self.tool_registry.registry = {}

        async def stream_async(self, message):
            for event in self.events:
                yield event

    events_in = [
        {"type": "multiagent_node_cancel", "node_id": "n1", "message": "cancelled"},
        {"complete": True},
    ]
    agent = StrandsAgent(MockAgent(events_in), name="test")
    agent._agents_by_thread["test-thread"] = MockAgent(events_in)

    events = [e async for e in agent.run(FakeInput())]
    customs = [e for e in events if e.type == EventType.CUSTOM]

    assert EventType.RUN_ERROR not in [e.type for e in events]
    assert [e.name for e in customs] == ["MultiAgentNodeCancel"]
    assert customs[0].value == {"node_id": "n1", "message": "cancelled"}


# ---------------------------------------------------------------------------
# Real SDK: support is gated on the runtime actually emitting these events
# ---------------------------------------------------------------------------


class ScriptedModel(Model):
    """Minimal Strands model that streams one fixed assistant turn."""

    def __init__(self, text: str):
        self._text = text

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": self._text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                "metrics": {"latencyMs": 1},
            }
        }


@pytest.mark.asyncio
async def test_real_graph_streams_through_the_adapter():
    from strands import Agent
    from strands.multiagent import GraphBuilder

    builder = GraphBuilder()
    builder.add_node(
        Agent(model=ScriptedModel("Found it."), name="researcher", callback_handler=None),
        "researcher",
    )
    builder.add_node(
        Agent(model=ScriptedModel("Final answer."), name="writer", callback_handler=None),
        "writer",
    )
    builder.add_edge("researcher", "writer")
    builder.set_entry_point("researcher")

    agent = StrandsAgent(builder.build(), name="multi_agent")
    events = await collect(agent, FakeInput(messages=[FakeMessage("user", "go")]))
    types = [e.type for e in events]

    assert types[0] == EventType.RUN_STARTED
    assert types[-1] == EventType.RUN_FINISHED
    assert EventType.RUN_ERROR not in types

    steps_started = [e.step_name for e in events if e.type == EventType.STEP_STARTED]
    steps_finished = [e.step_name for e in events if e.type == EventType.STEP_FINISHED]
    assert steps_started == ["agent:researcher", "agent:writer"]
    assert steps_finished == steps_started

    handoffs = [
        e.value for e in events if e.type == EventType.CUSTOM and e.name == "MultiAgentHandoff"
    ]
    assert handoffs == [
        {"from_nodes": ["researcher"], "to_nodes": ["writer"], "message": None}
    ]

    text = "".join(
        e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT
    )
    assert "Found it." in text
    assert "Final answer." in text


@pytest.mark.asyncio
async def test_orchestrator_run_never_injects_the_a2ui_tool():
    # A2UI auto-injection needs a model to build its sub-agent, and an
    # orchestrator has none. plan_a2ui_injection has its own unit test for the
    # skip; this pins the same outcome for a whole run now that an orchestrator
    # can actually be constructed and reach this path.
    from strands import Agent
    from strands.multiagent import GraphBuilder

    node = Agent(model=ScriptedModel("Done."), name="solo", callback_handler=None)
    builder = GraphBuilder()
    builder.add_node(node, "solo")
    builder.set_entry_point("solo")

    tools_before = set(node.tool_registry.registry)

    agent = StrandsAgent(builder.build(), name="multi_agent")
    events = await collect(
        agent,
        FakeInput(
            messages=[FakeMessage("user", "go")],
            forwarded_props={"injectA2UITool": True},
        ),
    )
    types = [e.type for e in events]

    # The claim under test is that nothing was injected, so assert on the
    # agent's own tools. Asserting on emitted events could not fail here: the
    # orchestrator path emits no tool events at all.
    assert set(node.tool_registry.registry) == tools_before
    assert "generate_a2ui" not in node.tool_registry.registry
    assert EventType.RUN_ERROR not in types
    assert types[-1] == EventType.RUN_FINISHED


@pytest.mark.asyncio
async def test_real_swarm_streams_through_the_adapter():
    from strands import Agent
    from strands.multiagent import Swarm

    swarm = Swarm(
        [
            Agent(model=ScriptedModel("Only node speaks."), name="solo", callback_handler=None),
        ]
    )

    agent = StrandsAgent(swarm, name="multi_agent_swarm")
    events = await collect(agent, FakeInput(messages=[FakeMessage("user", "go")]))
    types = [e.type for e in events]

    assert types[0] == EventType.RUN_STARTED
    assert types[-1] == EventType.RUN_FINISHED
    assert EventType.RUN_ERROR not in types

    steps_started = [e.step_name for e in events if e.type == EventType.STEP_STARTED]
    assert steps_started == ["agent:solo"]

    text = "".join(
        e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT
    )
    assert "Only node speaks." in text


# ---------------------------------------------------------------------------
# Per-run isolation of a caller-supplied orchestrator
# ---------------------------------------------------------------------------


def _real_two_node_graph():
    from strands import Agent
    from strands.multiagent import GraphBuilder

    first = Agent(model=ScriptedModel("A."), name="first", callback_handler=None)
    second = Agent(model=ScriptedModel("B."), name="second", callback_handler=None)
    builder = GraphBuilder()
    builder.add_node(first, "first")
    builder.add_node(second, "second")
    builder.add_edge("first", "second")
    builder.set_entry_point("first")
    return builder.build(), first


def _texts_seen_by(agent) -> list:
    return [
        block["text"]
        for message in agent.messages
        for block in (message.get("content") or [])
        if isinstance(block, dict) and "text" in block
    ]


@pytest.mark.asyncio
async def test_directly_wrapped_graph_does_not_leak_between_threads():
    # A Python Graph does not snapshot its node agents around an execution, so
    # a reused instance would carry one thread's turns into the next one's
    # model input. The adapter has to undo each run itself.
    graph, first = _real_two_node_graph()
    agent = StrandsAgent(graph, name="multi_agent")

    for thread, message in (("thread-a", "SECRET_ALPHA"), ("thread-b", "PUBLIC_BETA")):
        run_input = FakeInput(messages=[FakeMessage("user", message)])
        run_input.thread_id = thread
        await collect(agent, run_input)

    assert "SECRET_ALPHA" not in _texts_seen_by(first)
    assert _texts_seen_by(first) == []


@pytest.mark.asyncio
async def test_shared_orchestrator_refuses_overlap_on_any_thread():
    # One instance cannot be multiplexed, so a second concurrent run is
    # refused even when it belongs to a different thread.
    started = asyncio.Event()
    release = asyncio.Event()

    class ParkedGraph:
        nodes: dict = {}

        async def stream_async(self, task, invocation_state=None, **kwargs):
            started.set()
            await release.wait()
            yield {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"}

    agent = StrandsAgent(ParkedGraph(), name="test")

    first_input = FakeInput()
    first_input.thread_id = "thread-a"
    task = asyncio.create_task(_drain(agent.run(first_input)))
    await asyncio.wait_for(started.wait(), timeout=5)

    other_input = FakeInput()
    other_input.thread_id = "thread-b"
    second = await asyncio.wait_for(_drain(agent.run(other_input)), timeout=5)
    release.set()
    await asyncio.wait_for(task, timeout=5)

    assert [e.type for e in second] == [
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
    ]
    assert second[-1].code == "THREAD_BUSY"


@pytest.mark.asyncio
async def test_a_factory_builds_a_fresh_orchestrator_per_run():
    built = []

    def build():
        orchestrator = FakeOrchestrator(
            [{"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
             {"type": "multiagent_node_stop", "node_id": "a"}]
        )
        built.append(orchestrator)
        return orchestrator

    agent = StrandsAgent(build, name="multi_agent")
    await collect(agent)
    await collect(agent)

    # One at construction to validate the factory, then one per run.
    assert len(built) == 3
    assert built[1] is not built[2]


@pytest.mark.asyncio
async def test_a_factory_returning_the_wrong_thing_fails_at_construction():
    with pytest.raises(TypeError, match="did not return a Strands orchestrator"):
        StrandsAgent(lambda: object(), name="multi_agent")


@pytest.mark.asyncio
async def test_concurrent_runs_are_allowed_when_each_builds_its_own_graph():
    def build():
        return FakeOrchestrator(
            [{"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
             {"type": "multiagent_node_stop", "node_id": "a"}]
        )

    agent = StrandsAgent(build, name="multi_agent")

    first_input = FakeInput()
    first_input.thread_id = "thread-a"
    other_input = FakeInput()
    other_input.thread_id = "thread-b"
    both = await asyncio.gather(
        _drain(agent.run(first_input)), _drain(agent.run(other_input))
    )

    for events in both:
        assert [e.type for e in events][-1] == EventType.RUN_FINISHED
        assert EventType.RUN_ERROR not in [e.type for e in events]


# ---------------------------------------------------------------------------
# Nested orchestrators
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_nested_orchestrator_node_still_streams_its_text():
    # A Graph or Swarm can be a graph node, in which case its events arrive
    # wrapped twice. Reading only one level emitted a successful empty run.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "outer", "node_type": "multiagent"},
            node_stream("outer", node_stream("inner", {"data": "NESTED_OUTPUT"})),
            {"type": "multiagent_node_stop", "node_id": "outer"},
        ]
    )

    events = await collect(make_agent(orchestrator))

    # Attributed to the outer node, which is the one holding the open step, so
    # the envelope closes with its step rather than being swept at the end.
    assert shape(events) == [
        (EventType.RUN_STARTED,),
        (EventType.STEP_STARTED, "multiagent:outer"),
        (EventType.TEXT_MESSAGE_START,),
        (EventType.TEXT_MESSAGE_CONTENT, "NESTED_OUTPUT"),
        (EventType.TEXT_MESSAGE_END,),
        (EventType.STEP_FINISHED, "multiagent:outer"),
        (EventType.RUN_FINISHED,),
    ]


@pytest.mark.asyncio
async def test_pathologically_nested_node_stream_is_dropped_not_looped():
    deep: dict = {"data": "buried"}
    for _ in range(30):
        deep = node_stream("n", deep)
    orchestrator = FakeOrchestrator([deep])

    events = await collect(make_agent(orchestrator))
    types = [e.type for e in events]

    assert EventType.TEXT_MESSAGE_CONTENT not in types
    assert types[-1] == EventType.RUN_FINISHED


# ---------------------------------------------------------------------------
# Interrupt outcome and resume
# ---------------------------------------------------------------------------


class NativeInterrupt:
    def __init__(self, interrupt_id="i1", name="confirm", reason="APPROVAL"):
        self.id = interrupt_id
        self.name = name
        self.reason = reason
        self.response = None


@pytest.mark.asyncio
async def test_interrupt_is_reported_as_the_run_outcome():
    # A run that paused must not report plain success, or the client has no way
    # to know an answer is owed.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            {
                "type": "multiagent_node_interrupt",
                "node_id": "a",
                "interrupts": [NativeInterrupt()],
            },
        ]
    )

    events = await collect(make_agent(orchestrator))
    finished = events[-1]

    assert finished.type == EventType.RUN_FINISHED
    assert finished.outcome is not None
    assert finished.outcome.type == "interrupt"
    assert [i.id for i in finished.outcome.interrupts] == ["i1"]


@pytest.mark.asyncio
async def test_resume_sends_interrupt_responses_not_a_task_string():
    # Strands rejects a string once a node is parked at a checkpoint, and the
    # orchestrator then stays interrupted for every later run.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            {
                "type": "multiagent_node_interrupt",
                "node_id": "a",
                "interrupts": [NativeInterrupt()],
            },
        ]
    )
    agent = make_agent(orchestrator)
    await collect(agent)

    class Entry:
        interrupt_id = "i1"
        status = "resolved"
        payload = {"approved": True}

    resume_input = FakeInput(messages=[FakeMessage("user", "ignored on resume")])
    resume_input.resume = [Entry()]
    await collect(agent, resume_input)

    assert orchestrator.prompts[1] == [
        {"interruptResponse": {"interruptId": "i1", "response": {"response": {"approved": True}}}}
    ]


@pytest.mark.asyncio
async def test_resume_for_an_unknown_interrupt_falls_back_to_a_task_string():
    # A stale or invented id must not be handed to an orchestrator that is not
    # waiting for it.
    orchestrator = FakeOrchestrator([])
    agent = make_agent(orchestrator)

    class Entry:
        interrupt_id = "never-raised"
        status = "resolved"
        payload = {"approved": True}

    resume_input = FakeInput(messages=[FakeMessage("user", "carry on")])
    resume_input.resume = [Entry()]
    await collect(agent, resume_input)

    assert orchestrator.prompts == ["carry on"]


@pytest.mark.asyncio
async def test_a_completed_run_clears_the_pending_interrupt():
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            {
                "type": "multiagent_node_interrupt",
                "node_id": "a",
                "interrupts": [NativeInterrupt()],
            },
        ]
    )
    agent = make_agent(orchestrator)
    await collect(agent)
    assert agent._pending_interrupts_by_thread.get("test-thread")

    orchestrator.events = [
        {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
        {"type": "multiagent_node_stop", "node_id": "a"},
    ]
    # A resume, because a parked orchestrator refuses an unrelated run.
    resume_input = FakeInput()
    resume_input.resume = [_ResumeEntry()]
    events = await collect(agent, resume_input)

    assert events[-1].outcome is None
    assert not agent._pending_interrupts_by_thread.get("test-thread")


# ---------------------------------------------------------------------------
# Nested orchestrators: isolation and reuse safety
# ---------------------------------------------------------------------------


def _nested_real_graph():
    from strands import Agent
    from strands.multiagent import GraphBuilder

    leaf = Agent(model=ScriptedModel("LEAF."), name="leaf", callback_handler=None)
    inner = GraphBuilder()
    inner.add_node(leaf, "leaf")
    inner.set_entry_point("leaf")
    outer = GraphBuilder()
    outer.add_node(inner.build(), "nested")
    outer.set_entry_point("nested")
    return outer.build(), leaf


@pytest.mark.asyncio
async def test_nested_graph_leaves_are_isolated_between_threads():
    # A nested orchestrator holds no conversation of its own, so isolating only
    # the top level left the leaf agent accumulating every thread's turns.
    outer, leaf = _nested_real_graph()
    agent = StrandsAgent(outer, name="multi_agent")

    for thread, message in (("thread-a", "SECRET_ALPHA"), ("thread-b", "PUBLIC_BETA")):
        run_input = FakeInput(messages=[FakeMessage("user", message)])
        run_input.thread_id = thread
        await collect(agent, run_input)

    assert "SECRET_ALPHA" not in _texts_seen_by(leaf)
    assert _texts_seen_by(leaf) == []


@pytest.mark.asyncio
async def test_an_orchestrator_that_cannot_be_isolated_is_refused():
    # Warning and continuing would still ship one thread's turns to the next.
    class OpaqueNode:
        executor = object()

    class OpaqueGraph:
        nodes = {"a": OpaqueNode()}

        async def stream_async(self, task, invocation_state=None, **kwargs):
            yield {}

    with pytest.raises(TypeError, match="cannot be isolated between runs"):
        StrandsAgent(OpaqueGraph(), name="multi_agent")

    # The same orchestrator is fine behind a factory: each run builds its own.
    agent = StrandsAgent(lambda: OpaqueGraph(), name="multi_agent")
    assert agent._orchestrator_factory is not None


# ---------------------------------------------------------------------------
# Resume against a factory
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_reaches_the_orchestrator_that_paused():
    # An interrupt lives on the instance that raised it. Building a fresh one
    # for the resume sends the response to a graph that was never interrupted.
    built = []

    def build():
        orchestrator = FakeOrchestrator(
            [
                {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
                {
                    "type": "multiagent_node_interrupt",
                    "node_id": "a",
                    "interrupts": [NativeInterrupt()],
                },
            ]
        )
        built.append(orchestrator)
        return orchestrator

    agent = StrandsAgent(build, name="multi_agent")
    await collect(agent)
    paused = built[-1]

    class Entry:
        interrupt_id = "i1"
        status = "resolved"
        payload = {"approved": True}

    resume_input = FakeInput(messages=[FakeMessage("user", "ignored")])
    resume_input.resume = [Entry()]
    await collect(agent, resume_input)

    # The resume went to the paused instance, not a newly built one.
    assert built[-1] is paused
    assert paused.prompts[-1] == [
        {"interruptResponse": {"interruptId": "i1", "response": {"response": {"approved": True}}}}
    ]


@pytest.mark.asyncio
async def test_the_paused_orchestrator_is_released_once_the_run_completes():
    built = []

    def build():
        orchestrator = FakeOrchestrator(
            [
                {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
                {
                    "type": "multiagent_node_interrupt",
                    "node_id": "a",
                    "interrupts": [NativeInterrupt()],
                },
            ]
        )
        built.append(orchestrator)
        return orchestrator

    agent = StrandsAgent(build, name="multi_agent")
    await collect(agent)
    assert agent._parked_orchestrators_by_thread["test-thread"].orchestrator is built[-1]

    # The resume run completes, so nothing stays parked and the next ordinary
    # run gets a fresh orchestrator again.
    built[-1].events = [
        {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
        {"type": "multiagent_node_stop", "node_id": "a"},
    ]

    class Entry:
        interrupt_id = "i1"
        status = "resolved"
        payload = {"approved": True}

    resume_input = FakeInput()
    resume_input.resume = [Entry()]
    await collect(agent, resume_input)

    assert not agent._parked_orchestrators_by_thread.get("test-thread")

    before = len(built)
    await collect(agent)
    assert len(built) == before + 1


@pytest.mark.asyncio
async def test_an_interrupted_run_does_not_rewind_the_conversation():
    # Rewinding a paused instance would discard the state its resume needs.
    from strands import Agent
    from strands.multiagent import GraphBuilder

    node = Agent(model=ScriptedModel("A."), name="solo", callback_handler=None)
    builder = GraphBuilder()
    builder.add_node(node, "solo")
    builder.set_entry_point("solo")

    agent = StrandsAgent(builder.build(), name="multi_agent")
    agent._orchestrator.stream_async = FakeOrchestrator(  # type: ignore[method-assign]
        [
            {"type": "multiagent_node_start", "node_id": "solo", "node_type": "agent"},
            {
                "type": "multiagent_node_interrupt",
                "node_id": "solo",
                "interrupts": [NativeInterrupt()],
            },
        ]
    ).stream_async
    node.messages.append({"role": "user", "content": [{"text": "mid-interrupt"}]})

    await collect(agent, FakeInput(messages=[FakeMessage("user", "go")]))

    assert _texts_seen_by(node) == ["mid-interrupt"]


# ---------------------------------------------------------------------------
# Shared-instance isolation across the whole run lifecycle
# ---------------------------------------------------------------------------


def _interrupting_graph(script):
    """Direct Graph whose single node interrupts, then answers on resume."""
    from strands import Agent
    from strands.multiagent import GraphBuilder

    node = Agent(model=ScriptedModel("unused"), name="solo", callback_handler=None)
    builder = GraphBuilder()
    builder.add_node(node, "solo")
    builder.set_entry_point("solo")
    graph = builder.build()
    replay = FakeOrchestrator([])
    replay.events = script
    graph.stream_async = replay.stream_async  # type: ignore[method-assign]
    return graph, node, replay


def _interrupt_then(*, after):
    return [
        {"type": "multiagent_node_start", "node_id": "solo", "node_type": "agent"},
        {
            "type": "multiagent_node_interrupt",
            "node_id": "solo",
            "interrupts": [NativeInterrupt()],
        },
    ] if after is None else [
        {"type": "multiagent_node_start", "node_id": "solo", "node_type": "agent"},
        node_stream("solo", {"data": after}),
        {"type": "multiagent_node_stop", "node_id": "solo"},
    ]


@pytest.mark.asyncio
async def test_completing_a_resume_rewinds_to_before_the_run_that_paused():
    # The rewind target is the state from before the FIRST run, not the paused
    # state a resume run starts from. Snapshotting again on resume left the
    # interrupted turns on the shared instance for the next thread.
    graph, node, replay = _interrupting_graph(_interrupt_then(after=None))
    agent = StrandsAgent(graph, name="multi_agent")

    first = FakeInput(messages=[FakeMessage("user", "SECRET_ALPHA")])
    first.thread_id = "thread-a"
    await collect(agent, first)
    # The pause leaves its turns in place, which is what the resume needs.
    node.messages.append({"role": "user", "content": [{"text": "SECRET_ALPHA"}]})

    replay.events = _interrupt_then(after="answered")
    resume = FakeInput(messages=[FakeMessage("user", "ignored")])
    resume.thread_id = "thread-a"
    resume.resume = [_ResumeEntry()]
    await collect(agent, resume)

    assert _texts_seen_by(node) == []
    assert not agent._parked_orchestrators_by_thread


@pytest.mark.asyncio
async def test_abandoning_the_stream_still_rewinds_the_shared_instance():
    # Closing the AG-UI generator (an HTTP client disconnecting) exits through
    # GeneratorExit. Cleanup placed after the stream loop never runs on that
    # path, which left the instance carrying the abandoned run's turns.
    graph, node, _ = _interrupting_graph(
        [
            {"type": "multiagent_node_start", "node_id": "solo", "node_type": "agent"},
            node_stream("solo", {"data": "partial"}),
            {"type": "multiagent_node_stop", "node_id": "solo"},
        ]
    )
    agent = StrandsAgent(graph, name="multi_agent")

    first = FakeInput(messages=[FakeMessage("user", "SECRET_ALPHA")])
    first.thread_id = "thread-a"
    stream = agent.run(first)
    async for event in stream:
        if event.type == EventType.TEXT_MESSAGE_CONTENT:
            # Simulate the node having written its turns before the disconnect.
            node.messages.append(
                {"role": "user", "content": [{"text": "SECRET_ALPHA"}]}
            )
            break
    await stream.aclose()

    assert _texts_seen_by(node) == []
    assert not agent._parked_orchestrators_by_thread
    assert not agent._active_orchestrator_runs


@pytest.mark.asyncio
async def test_a_second_interrupt_keeps_the_original_baseline():
    # A resume that interrupts again must not overwrite the baseline with the
    # conversation it started from, or the final completion rewinds to a paused
    # state instead of a clean one.
    graph, node, replay = _interrupting_graph(_interrupt_then(after=None))
    agent = StrandsAgent(graph, name="multi_agent")

    run_input = FakeInput(messages=[FakeMessage("user", "SECRET_ALPHA")])
    run_input.thread_id = "thread-a"
    await collect(agent, run_input)
    node.messages.append({"role": "user", "content": [{"text": "turn-one"}]})
    first_baseline = agent._parked_orchestrators_by_thread["thread-a"].baseline

    # Resume, and interrupt a second time.
    resume = FakeInput()
    resume.thread_id = "thread-a"
    resume.resume = [_ResumeEntry()]
    await collect(agent, resume)
    node.messages.append({"role": "user", "content": [{"text": "turn-two"}]})

    assert agent._parked_orchestrators_by_thread["thread-a"].baseline is first_baseline

    # Final resume completes, and the rewind goes all the way back.
    replay.events = _interrupt_then(after="done")
    final = FakeInput()
    final.thread_id = "thread-a"
    final.resume = [_ResumeEntry()]
    await collect(agent, final)

    assert _texts_seen_by(node) == []
    assert not agent._parked_orchestrators_by_thread


@pytest.mark.asyncio
async def test_a_parked_shared_instance_refuses_an_unrelated_run():
    # While one thread's interrupt is outstanding, the shared graph is still
    # parked mid-execution, so another thread must not be handed it.
    graph, _, _ = _interrupting_graph(_interrupt_then(after=None))
    agent = StrandsAgent(graph, name="multi_agent")

    first = FakeInput(messages=[FakeMessage("user", "first")])
    first.thread_id = "thread-a"
    await collect(agent, first)

    other = FakeInput(messages=[FakeMessage("user", "second")])
    other.thread_id = "thread-b"
    events = await collect(agent, other)

    assert [e.type for e in events] == [
        EventType.RUN_STARTED,
        EventType.RUN_ERROR,
    ]
    assert events[-1].code == "THREAD_BUSY"

    # A non-resume run on the parked thread is refused for the same reason.
    same_thread = FakeInput(messages=[FakeMessage("user", "third")])
    same_thread.thread_id = "thread-a"
    again = await collect(agent, same_thread)
    assert again[-1].code == "THREAD_BUSY"


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_after", ["RUN_STARTED", "STATE_SNAPSHOT"])
async def test_closing_the_stream_early_tears_down_cleanly(stop_after):
    # Cleanup runs however far the generator got. It previously referenced a
    # name bound further down the body, so closing before that point raised
    # from teardown instead of cleaning up.
    orchestrator = FakeOrchestrator(
        [
            {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"},
            {"type": "multiagent_node_stop", "node_id": "a"},
        ]
    )
    agent = make_agent(orchestrator)

    stream = agent.run(FakeInput(messages=[FakeMessage("user", "go")], state={"topic": "x"}))
    async for event in stream:
        if event.type.value == stop_after:
            break

    # No exception, and the thread is left usable rather than wedged.
    await stream.aclose()

    assert not agent._active_orchestrator_runs
    assert not agent._parked_orchestrators_by_thread
    assert not agent._pending_interrupts_by_thread

    later = await collect(agent, FakeInput(messages=[FakeMessage("user", "again")]))
    assert later[-1].type == EventType.RUN_FINISHED

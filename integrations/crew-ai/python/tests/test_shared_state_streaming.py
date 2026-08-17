"""Tests for shared-state streaming (parity with LangGraph).

Two concerns are covered:

* the SDK coordination layer that records predicted tools / manual emits on
  the running flow and decides whether a node-exit STATE_SNAPSHOT should be
  suppressed (:mod:`ag_ui_crewai.sdk`); and
* the endpoint listener that honours that decision when
  ``MethodExecutionFinished`` fires (:mod:`ag_ui_crewai.endpoint`).

The mechanism mirrors LangGraph: a node that streams a predicted tool call
(``copilotkit_predict_state`` + the streamed tool) or emits a manual snapshot
(``copilotkit_emit_state``) already gave the client the authoritative state,
so the snapshot rebuilt from ``flow.state`` at node exit must not clobber it.
"""

import asyncio
import concurrent.futures

import pytest
from pydantic import BaseModel

# Resolve the bus and lifecycle events through the version-agnostic shim
# (crewai 1.x moved them off ``crewai.utilities.events``).
from ag_ui_crewai._capabilities import (
    FlowFinishedEvent,
    MethodExecutionFinishedEvent,
    MethodExecutionStartedEvent,
    crewai_event_bus,
)

from ag_ui_crewai import endpoint as ep
from ag_ui_crewai.context import flow_context
from ag_ui_crewai.sdk import (
    StateItem,
    consume_node_exit_snapshot_suppression,
    copilotkit_emit_state,
    copilotkit_predict_state,
    _mark_predicted_tool_streamed,
    _normalize_predict_state,
)


class _FakeFlow:
    """Minimal stand-in for a CrewAI Flow instance used as the event source."""

    def __init__(self, state=None):
        self.state = {} if state is None else state


@pytest.fixture
def flow_in_context():
    """Set a fake flow as the active ``flow_context`` value for a test."""
    flow = _FakeFlow()
    token = flow_context.set(flow)
    try:
        yield flow
    finally:
        flow_context.reset(token)


# --------------------------------------------------------------------------
# _normalize_predict_state
# --------------------------------------------------------------------------

def test_normalize_predict_state_mapping_form():
    result = _normalize_predict_state(
        {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
    )
    assert result == [
        {"state_key": "recipe", "tool": "generate_recipe", "tool_argument": "recipe"}
    ]


def test_normalize_predict_state_mapping_without_tool_argument():
    # tool_argument is optional; a mapping that omits it must not KeyError.
    result = _normalize_predict_state({"steps": {"tool_name": "make_steps"}})
    assert result == [
        {"state_key": "steps", "tool": "make_steps", "tool_argument": None}
    ]


def test_normalize_predict_state_stateitem_sequence():
    result = _normalize_predict_state(
        [StateItem(state_key="doc", tool="write_document", tool_argument="document")]
    )
    assert result == [
        {"state_key": "doc", "tool": "write_document", "tool_argument": "document"}
    ]


def test_stateitem_defaults_tool_argument_to_none():
    item = StateItem(state_key="s", tool="t")
    assert item.tool_argument is None


# --------------------------------------------------------------------------
# copilotkit_predict_state -> suppression on a streamed predicted tool
# --------------------------------------------------------------------------

async def test_predicted_tool_streamed_triggers_suppression(flow_in_context):
    await copilotkit_predict_state(
        {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
    )
    # The predicted tool actually starts streaming.
    _mark_predicted_tool_streamed(flow_in_context, "generate_recipe")

    assert consume_node_exit_snapshot_suppression(flow_in_context) is True


async def test_predict_state_accepts_stateitem_list(flow_in_context):
    await copilotkit_predict_state(
        [StateItem(state_key="recipe", tool="generate_recipe", tool_argument="recipe")]
    )
    _mark_predicted_tool_streamed(flow_in_context, "generate_recipe")

    assert consume_node_exit_snapshot_suppression(flow_in_context) is True


async def test_two_predict_state_calls_in_one_node_both_suppress(flow_in_context):
    # Two predict_state calls in one node must union their tool bindings; the
    # second call must not drop the first's (so streaming either predicted
    # tool suppresses the node-exit snapshot).
    await copilotkit_predict_state(
        {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
    )
    await copilotkit_predict_state(
        {"doc": {"tool_name": "write_document", "tool_argument": "document"}}
    )
    # The first call's tool streams.
    _mark_predicted_tool_streamed(flow_in_context, "generate_recipe")
    assert consume_node_exit_snapshot_suppression(flow_in_context) is True


async def test_declared_but_unstreamed_predict_state_does_not_suppress(flow_in_context):
    # A node may declare predict_state but take a branch that never calls the
    # tool. Suppressing there would silently drop a real state update.
    await copilotkit_predict_state(
        {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
    )
    assert consume_node_exit_snapshot_suppression(flow_in_context) is False


async def test_unrelated_tool_stream_does_not_suppress(flow_in_context):
    await copilotkit_predict_state(
        {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
    )
    # A different tool streams; it is not the predicted one.
    _mark_predicted_tool_streamed(flow_in_context, "some_other_tool")
    assert consume_node_exit_snapshot_suppression(flow_in_context) is False


# --------------------------------------------------------------------------
# copilotkit_emit_state -> suppression on a manual snapshot
# --------------------------------------------------------------------------

async def test_manual_emit_triggers_suppression(flow_in_context):
    await copilotkit_emit_state({"progress": 3})
    assert consume_node_exit_snapshot_suppression(flow_in_context) is True


# --------------------------------------------------------------------------
# consume semantics
# --------------------------------------------------------------------------

async def test_consume_resets_flags_so_next_node_is_clean(flow_in_context):
    await copilotkit_emit_state({"progress": 1})
    assert consume_node_exit_snapshot_suppression(flow_in_context) is True
    # Second read (the following node) sees a clean slate.
    assert consume_node_exit_snapshot_suppression(flow_in_context) is False


def test_no_activity_does_not_suppress():
    assert consume_node_exit_snapshot_suppression(_FakeFlow()) is False


def test_consume_on_none_flow_is_safe():
    assert consume_node_exit_snapshot_suppression(None) is False


# --------------------------------------------------------------------------
# endpoint listener honours the suppression decision (driven over the real bus,
# listener registered before the node body so bridged events reach the queue)
# --------------------------------------------------------------------------

def _drain(queue):
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


def _names(events):
    return [type(e).__name__ for e in events]


async def _await_future(fut):
    """Await whatever crewai 1.x's bus.emit returns.

    A ``concurrent.futures.Future`` for sync handlers, an asyncio future for
    async ones, or ``None`` when there are no handlers. Awaiting it ensures the
    handler ran before we inspect the queue.
    """
    if fut is None:
        return
    if isinstance(fut, concurrent.futures.Future):
        await asyncio.wrap_future(fut)
    else:
        await fut


async def _settle():
    """Flush off-thread handlers, then tick so their queue puts run."""
    crewai_event_bus.flush()
    for _ in range(3):
        await asyncio.sleep(0)


async def _emit(source, event):
    """Emit one event and wait for its handler to finish (keeps put order)."""
    await _await_future(crewai_event_bus.emit(source, event))
    await asyncio.sleep(0)


async def _run_node(source, *, method_name="chat", body=None, flow_finished=False):
    """Drive one flow node over the real bus; return the drained queue events.

    Fires Started, runs ``body`` (flow_context set so the SDK hooks target
    ``source``), then Finished and optionally FlowFinished, flushing the
    off-thread bus between steps so the drained stream is settled and ordered.
    """
    queue = ep.get_queue(source) or await ep.create_queue(source)
    with crewai_event_bus.scoped_handlers():
        ep.FastAPICrewFlowEventListener()
        await _emit(
            source,
            MethodExecutionStartedEvent(
                flow_name="TestFlow", method_name=method_name, state=source.state
            ),
        )
        token = flow_context.set(source)
        try:
            if body is not None:
                await body()
        finally:
            flow_context.reset(token)
        # Flush the body's bridged predict/emit events onto the queue before the
        # node-exit events so the stream stays ordered.
        await _settle()
        await _emit(
            source,
            MethodExecutionFinishedEvent(
                flow_name="TestFlow", method_name=method_name, state=source.state
            ),
        )
        if flow_finished:
            await _emit(
                source, FlowFinishedEvent(flow_name="TestFlow", state=source.state)
            )
        await _settle()
    return _drain(queue)


async def test_node_exit_emits_state_snapshot_without_suppression():
    source = _FakeFlow(state={"messages": [], "recipe": None})
    events = await _run_node(source)

    assert _names(events) == [
        "StepStartedEvent",
        "MessagesSnapshotEvent",
        "StateSnapshotEvent",
        "StepFinishedEvent",
    ]


async def test_node_exit_suppresses_state_snapshot_after_predicted_tool():
    source = _FakeFlow(state={"messages": [], "recipe": None})

    async def body():
        await copilotkit_predict_state(
            {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
        )
        _mark_predicted_tool_streamed(source, "generate_recipe")

    events = await _run_node(source, body=body)

    names = _names(events)
    # The node-exit STATE_SNAPSHOT is suppressed...
    assert names == [
        "StepStartedEvent",
        "CustomEvent",  # PredictState, from copilotkit_predict_state
        "MessagesSnapshotEvent",
        "StepFinishedEvent",
    ]
    # ...and the PredictState custom event genuinely reached the client.
    custom = next(e for e in events if type(e).__name__ == "CustomEvent")
    assert custom.name == "PredictState"


async def test_manual_emit_snapshot_reaches_client_while_node_exit_suppressed():
    source = _FakeFlow(state={"messages": [], "steps": []})

    async def body():
        await copilotkit_emit_state(
            {"steps": [{"description": "x", "status": "completed"}]}
        )

    events = await _run_node(source, body=body)

    names = _names(events)
    # Exactly one STATE_SNAPSHOT: the manual emit. The node-exit snapshot is
    # suppressed, but the authoritative manual snapshot still reaches the client.
    assert names == [
        "StepStartedEvent",
        "StateSnapshotEvent",  # the manual emit_state snapshot
        "MessagesSnapshotEvent",
        "StepFinishedEvent",
    ]
    snapshot = next(e for e in events if type(e).__name__ == "StateSnapshotEvent")
    assert snapshot.snapshot == {"steps": [{"description": "x", "status": "completed"}]}


async def test_flow_finished_emits_terminal_state_snapshot():
    # A single terminal node that streamed a predicted tool: its node-exit
    # snapshot is suppressed, so the terminal FlowFinished snapshot is the only
    # thing that can deliver the authoritative flow.state to the client.
    source = _FakeFlow(state={"messages": [], "recipe": {"title": "Pasta"}})

    async def body():
        await copilotkit_predict_state(
            {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
        )
        _mark_predicted_tool_streamed(source, "generate_recipe")

    events = await _run_node(source, body=body, flow_finished=True)

    names = _names(events)
    assert "StateSnapshotEvent" in names  # terminal snapshot present
    # Tail is terminal snapshot, RUN_FINISHED, then the None stream sentinel.
    assert names[-3:] == ["StateSnapshotEvent", "RunFinishedEvent", "NoneType"]
    # The terminal snapshot carries the real final flow.state.
    terminal = events[-3]
    assert terminal.snapshot == {"messages": [], "recipe": {"title": "Pasta"}}
    assert events[-1] is None  # sentinel closes the stream


async def test_no_duplicate_terminal_snapshot_when_last_node_emitted():
    # A node that did NOT suppress already delivered its snapshot, so the
    # terminal FlowFinished snapshot must be skipped (no duplicate/re-render).
    source = _FakeFlow(state={"messages": [], "value": 1})
    events = await _run_node(source, flow_finished=True)
    names = _names(events)
    # One node-exit StateSnapshot, then RUN_FINISHED + sentinel; NOT two snapshots.
    assert names == [
        "StepStartedEvent",
        "MessagesSnapshotEvent",
        "StateSnapshotEvent",
        "StepFinishedEvent",
        "RunFinishedEvent",
        "NoneType",
    ]
    assert names.count("StateSnapshotEvent") == 1


async def test_suppression_does_not_leak_to_following_node():
    source = _FakeFlow(state={"messages": [], "recipe": None})

    async def body():
        await copilotkit_predict_state(
            {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
        )
        _mark_predicted_tool_streamed(source, "generate_recipe")

    # First node: predicted tool streamed -> node-exit snapshot suppressed.
    first = _names(await _run_node(source, body=body))
    assert "StateSnapshotEvent" not in first

    # A following node with no prediction must emit the confirming snapshot.
    second = _names(await _run_node(source))
    assert second == [
        "StepStartedEvent",
        "MessagesSnapshotEvent",
        "StateSnapshotEvent",
        "StepFinishedEvent",
    ]


async def test_manual_emit_then_flow_finished_delivers_terminal_snapshot():
    # emit_state suppresses the node-exit snapshot; if that node is the last,
    # the terminal FlowFinished snapshot must still deliver the real flow.state
    # (the client would otherwise be left on the ephemeral emit payload).
    source = _FakeFlow(state={"messages": [], "steps": ["done"]})

    async def body():
        await copilotkit_emit_state({"progress": "9/10"})

    events = await _run_node(source, body=body, flow_finished=True)
    names = _names(events)
    # The manual emit snapshot (mid-run) AND the terminal snapshot both appear.
    assert names.count("StateSnapshotEvent") == 2
    # Last snapshot is the terminal one carrying the authoritative flow.state.
    terminal = events[-3]
    assert type(terminal).__name__ == "StateSnapshotEvent"
    assert terminal.snapshot == {"messages": [], "steps": ["done"]}


async def test_manual_emit_snapshot_is_isolated_from_later_mutation():
    # emit_state must snapshot a point-in-time copy: a progress loop that emits
    # the live state and then mutates it (the shipped agentic_generative_ui
    # pattern) must not have its already-queued snapshot corrupted.
    source = _FakeFlow(state={"messages": [], "steps": [{"status": "pending"}]})

    async def body():
        live = source.state
        await copilotkit_emit_state(live)
        # Mutate the same object after emitting (as the next loop step would).
        live["steps"][0]["status"] = "completed"

    events = await _run_node(source, body=body)
    snapshot = next(e for e in events if type(e).__name__ == "StateSnapshotEvent")
    # The captured snapshot reflects the state AT emit time, not the mutation.
    assert snapshot.snapshot == {"messages": [], "steps": [{"status": "pending"}]}


async def test_manual_emit_flag_does_not_leak_to_following_node():
    # Symmetric to the predicted-tool leak test: a manual emit in one node
    # must not suppress a later node's snapshot.
    source = _FakeFlow(state={"messages": [], "value": 1})

    async def body():
        await copilotkit_emit_state({"value": 1})

    first = _names(await _run_node(source, body=body))
    # emit node: manual snapshot present, node-exit suppressed.
    assert first.count("StateSnapshotEvent") == 1  # only the manual emit

    second = _names(await _run_node(source))
    assert second == [
        "StepStartedEvent",
        "MessagesSnapshotEvent",
        "StateSnapshotEvent",  # NOT suppressed: manual flag did not leak
        "StepFinishedEvent",
    ]


async def test_node_entry_reset_clears_stale_predicted_tools():
    # A node declares predict_state but "raises" before MethodExecutionFinished
    # (simulated by never firing it). The stale predicted-tool set must not
    # cause the NEXT node to suppress its snapshot.
    source = _FakeFlow(state={"messages": [], "recipe": None})
    queue = await ep.create_queue(source)

    with crewai_event_bus.scoped_handlers():
        ep.FastAPICrewFlowEventListener()
        # Node A: entry, declare predict_state + stream, then "crash" (no finish).
        await _emit(
            source,
            MethodExecutionStartedEvent(
                flow_name="TestFlow", method_name="a", state=source.state
            ),
        )
        token = flow_context.set(source)
        try:
            await copilotkit_predict_state(
                {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
            )
            _mark_predicted_tool_streamed(source, "generate_recipe")
        finally:
            flow_context.reset(token)

        await _settle()
        _drain(queue)  # discard node A's partial output

        # Node B: entry resets stale flags, exit emits the snapshot.
        await _emit(
            source,
            MethodExecutionStartedEvent(
                flow_name="TestFlow", method_name="b", state=source.state
            ),
        )
        await _emit(
            source,
            MethodExecutionFinishedEvent(
                flow_name="TestFlow", method_name="b", state=source.state
            ),
        )
        await _settle()
        events = _drain(queue)

    assert _names(events) == [
        "StepStartedEvent",
        "MessagesSnapshotEvent",
        "StateSnapshotEvent",  # NOT suppressed: entry reset cleared the stale flag
        "StepFinishedEvent",
    ]


# --------------------------------------------------------------------------
# real streaming-detection path: copilotkit_stream must flag a predicted tool
# --------------------------------------------------------------------------

class _FakeToolCall:
    def __init__(self, tool_id, name, arguments):
        self.id = tool_id
        self.function = {"name": name, "arguments": arguments}


def _chunk(*, chunk_id="msg-1", content=None, tool_calls=None, finish_reason=None):
    return {
        "id": chunk_id,
        "created": 0,
        "model": "test",
        "system_fingerprint": "",
        "choices": [
            {
                "delta": {"content": content, "tool_calls": tool_calls},
                "finish_reason": finish_reason,
            }
        ],
    }


async def _achunks(chunks):
    for c in chunks:
        yield c


async def test_stream_detection_flags_predicted_tool():
    from ag_ui_crewai.sdk import _copilotkit_stream_custom_stream_wrapper

    source = _FakeFlow(state={"messages": []})
    with crewai_event_bus.scoped_handlers():
        ep.FastAPICrewFlowEventListener()
        await ep.create_queue(source)
        token = flow_context.set(source)
        try:
            await copilotkit_predict_state(
                {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
            )
            stream = _achunks([
                _chunk(tool_calls=[_FakeToolCall("call-1", "generate_recipe", "")]),
                _chunk(tool_calls=[_FakeToolCall(None, None, '{"recipe":')]),
                _chunk(finish_reason="tool_calls"),
            ])
            await _copilotkit_stream_custom_stream_wrapper(stream)
        finally:
            flow_context.reset(token)

    # The production streaming loop set the suppression flag via the real
    # _mark_predicted_tool_streamed call, not a manual injection.
    assert consume_node_exit_snapshot_suppression(source) is True


async def test_stream_detection_handles_split_id_and_name():
    # Some providers stream the tool id and the function name in separate
    # deltas. Suppression must still trip: the name is checked on whichever
    # chunk carries it, not only the id-bearing chunk.
    from ag_ui_crewai.sdk import _copilotkit_stream_custom_stream_wrapper

    source = _FakeFlow(state={"messages": []})
    with crewai_event_bus.scoped_handlers():
        ep.FastAPICrewFlowEventListener()
        await ep.create_queue(source)
        token = flow_context.set(source)
        try:
            await copilotkit_predict_state(
                {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
            )
            stream = _achunks([
                _chunk(tool_calls=[_FakeToolCall("call-1", None, "")]),  # id, no name
                _chunk(tool_calls=[_FakeToolCall(None, "generate_recipe", None)]),  # name later
                _chunk(finish_reason="tool_calls"),
            ])
            await _copilotkit_stream_custom_stream_wrapper(stream)
        finally:
            flow_context.reset(token)

    assert consume_node_exit_snapshot_suppression(source) is True


async def test_stream_detection_ignores_non_predicted_tool():
    from ag_ui_crewai.sdk import _copilotkit_stream_custom_stream_wrapper

    source = _FakeFlow(state={"messages": []})
    with crewai_event_bus.scoped_handlers():
        ep.FastAPICrewFlowEventListener()
        await ep.create_queue(source)
        token = flow_context.set(source)
        try:
            await copilotkit_predict_state(
                {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
            )
            stream = _achunks([
                _chunk(tool_calls=[_FakeToolCall("call-1", "some_other_tool", "")]),
                _chunk(finish_reason="tool_calls"),
            ])
            await _copilotkit_stream_custom_stream_wrapper(stream)
        finally:
            flow_context.reset(token)

    assert consume_node_exit_snapshot_suppression(source) is False


# --------------------------------------------------------------------------
# _flow_state_snapshot: both flow-state shapes (dict and Pydantic model)
#
# Production shared-state flows use a Pydantic state (CopilotKitState /
# AgentState), so the model_dump() branch is the real serialization path and
# must be covered, not just the plain-dict path.
# --------------------------------------------------------------------------

class _PydanticState(BaseModel):
    messages: list = []
    recipe: dict | None = None


def test_flow_state_snapshot_pydantic_model_dumps():
    state = _PydanticState(messages=[], recipe={"title": "Pasta"})
    snapshot = ep._flow_state_snapshot(state)
    assert snapshot == {"messages": [], "recipe": {"title": "Pasta"}}
    assert isinstance(snapshot, dict)


def test_flow_state_snapshot_dict_passthrough():
    state = {"messages": [], "value": 1}
    assert ep._flow_state_snapshot(state) == {"messages": [], "value": 1}


def test_flow_state_snapshot_dict_is_isolated_from_later_mutation():
    # The snapshot is a point-in-time copy: mutating the source dict (as a
    # later node would) after taking the snapshot must not change it.
    state = {"messages": [], "recipe": {"title": "Pasta"}}
    snapshot = ep._flow_state_snapshot(state)
    state["recipe"]["title"] = "CHANGED"
    state["messages"].append("late")
    assert snapshot == {"messages": [], "recipe": {"title": "Pasta"}}


def test_flow_state_snapshot_none_returns_empty():
    assert ep._flow_state_snapshot(None) == {}


def test_flow_state_snapshot_pydantic_isolated_from_later_mutation():
    # The production shared-state path is Pydantic; model_dump() must yield a
    # snapshot isolated from later in-place mutation of nested containers.
    state = _PydanticState(messages=[{"role": "user", "content": "hi"}], recipe=None)
    snapshot = ep._flow_state_snapshot(state)
    state.messages[0]["content"] = "CHANGED"
    assert snapshot == {"messages": [{"role": "user", "content": "hi"}], "recipe": None}


async def test_terminal_snapshot_serializes_pydantic_state():
    # End-to-end over the listener: a suppressed terminal node with Pydantic
    # state must yield a terminal snapshot serialized via model_dump().
    source = _FakeFlow(state=_PydanticState(messages=[], recipe={"title": "Soup"}))

    async def body():
        await copilotkit_predict_state(
            {"recipe": {"tool_name": "generate_recipe", "tool_argument": "recipe"}}
        )
        _mark_predicted_tool_streamed(source, "generate_recipe")

    events = await _run_node(source, body=body, flow_finished=True)
    # Tail is terminal snapshot, RUN_FINISHED, then the None stream sentinel.
    terminal = events[-3]
    assert type(terminal).__name__ == "StateSnapshotEvent"
    assert terminal.snapshot == {"messages": [], "recipe": {"title": "Soup"}}


# --------------------------------------------------------------------------
# StreamFrame path (crewai >= 1.6): the translator must honour the SAME
# emit_state/predict_state suppression the legacy listener does, and owe the
# terminal snapshot correctly across the method-failed / finalize edges.
# Driven by feeding the translator raw lifecycle events directly (as
# ``endpoint._run_flow_frame_stream`` does); direct-translate uses the live
# suppression-flag fallback (the flags are set synchronously in the body here).
# --------------------------------------------------------------------------

from types import SimpleNamespace  # noqa: E402
from ag_ui_crewai._frames import StreamFrameTranslator  # noqa: E402


def _fe(type_, **attrs):  # noqa: A002 - mirror event.type
    return SimpleNamespace(type=type_, **attrs)


def _frame_translator(flow):
    return StreamFrameTranslator(
        thread_id="t-1",
        run_id="r-1",
        state_provider=lambda: getattr(flow, "state", {}),
        flow_provider=lambda: flow,
    )


async def test_frame_method_finished_after_emit_suppresses_node_exit():
    # A method that emit_state's then finishes must have its node-exit
    # STATE_SNAPSHOT SUPPRESSED (only MESSAGES + STEP_FINISHED), so the rebuild
    # does not clobber the progressive emit. Direct-translate exercises the live
    # suppression fallback (no sink stamp).
    flow = _FakeFlow(state={"messages": [], "v": "real"})
    tr = _frame_translator(flow)
    tr.translate(_fe("flow_started"))
    tr.translate(_fe("method_execution_started", method_name="chat"))
    token = flow_context.set(flow)
    try:
        await copilotkit_emit_state({"v": "emit"})
    finally:
        flow_context.reset(token)
    finished = tr.translate(_fe("method_execution_finished", method_name="chat"))
    assert _names(finished) == ["MessagesSnapshotEvent", "StepFinishedEvent"]


async def test_frame_method_failed_after_emit_owes_terminal_snapshot():
    # A method emit_state's then FAILS while the flow continues to flow_finished.
    # The failed method emits no node-exit snapshot, so the terminal snapshot is
    # the only carrier of the authoritative flow.state, so the fail path must
    # record the owed terminal, not drop it.
    flow = _FakeFlow(state={"messages": [], "recipe": {"title": "Pho"}})
    tr = _frame_translator(flow)
    tr.translate(_fe("flow_started"))
    tr.translate(_fe("method_execution_started", method_name="chat"))
    token = flow_context.set(flow)
    try:
        await copilotkit_emit_state({"recipe": "ephemeral"})
    finally:
        flow_context.reset(token)
    tr.translate(_fe("method_execution_failed", method_name="chat"))
    tail = tr.translate(_fe("flow_finished"))
    assert _names(tail)[-2:] == ["StateSnapshotEvent", "RunFinishedEvent"]
    snap = next(e for e in tail if type(e).__name__ == "StateSnapshotEvent")
    assert snap.snapshot == {"messages": [], "recipe": {"title": "Pho"}}


async def test_frame_prior_suppressed_then_later_method_fails_keeps_terminal():
    # Node A emit_state's and finishes (owed terminal = True). Node B then FAILS
    # without emitting. B's fail path must NOT clobber A's owed-terminal flag (it
    # emits no snapshot of its own): OR, not overwrite.
    flow = _FakeFlow(state={"messages": [], "recipe": {"title": "Laksa"}})
    tr = _frame_translator(flow)
    tr.translate(_fe("flow_started"))
    tr.translate(_fe("method_execution_started", method_name="a"))
    token = flow_context.set(flow)
    try:
        await copilotkit_emit_state({"recipe": "ephemeral"})
    finally:
        flow_context.reset(token)
    tr.translate(_fe("method_execution_finished", method_name="a"))
    tr.translate(_fe("method_execution_started", method_name="b"))
    tr.translate(_fe("method_execution_failed", method_name="b"))
    tail = tr.translate(_fe("flow_finished"))
    assert _names(tail)[-2:] == ["StateSnapshotEvent", "RunFinishedEvent"]
    snap = next(e for e in tail if type(e).__name__ == "StateSnapshotEvent")
    assert snap.snapshot == {"messages": [], "recipe": {"title": "Laksa"}}


async def test_frame_finalize_redelivers_state_when_suppressed_without_finish():
    # A method emit_state's then the stream exhausts via finalize WITHOUT a
    # method_execution_finished (e.g. an async HITL suspend): the terminal must
    # still redeliver the authoritative flow.state, else the client is left on
    # the ephemeral emit payload.
    flow = _FakeFlow(state={"messages": [], "recipe": {"title": "Ragu"}})
    tr = _frame_translator(flow)
    tr.translate(_fe("flow_started"))
    tr.translate(_fe("method_execution_started", method_name="chat"))
    token = flow_context.set(flow)
    try:
        await copilotkit_emit_state({"recipe": "ephemeral"})
    finally:
        flow_context.reset(token)
    tail = tr.finalize()
    names = _names(tail)
    assert "StateSnapshotEvent" in names
    assert names[-1] == "RunFinishedEvent"
    snap = next(e for e in tail if type(e).__name__ == "StateSnapshotEvent")
    assert snap.snapshot == {"messages": [], "recipe": {"title": "Ragu"}}

"""Tests for the RAW fallback and agent-as-tool inner-event forwarding.

Covers two halves of the same structural gap in the Strands adapter:

Issue #2291 — the main stream loop's ``if/elif`` chain has no terminal
``else``, so any event the adapter does not recognise is dropped silently.
Bedrock citation events are one such event, and Strands surfaces them in two
different envelopes depending on version: ``{"callback": {"citation": ...,
"delta": ...}}`` on 1.15.0-1.20.0, and ``{"citation": ..., "delta": ...}`` from
1.21.0 onward. Neither matches a branch. The declared floor is
``strands-agents>=1.15.0`` and the lockfile pins 1.18.0, so the tests here
accept both shapes.

The fallback that fixes it may only forward what will actually encode.
``ModelStreamEvent.prepare()`` merges ``invocation_state`` into any event
carrying a ``delta`` — including the live ``Agent`` — and ``stream_async``
always ends with an unserializable ``AgentResultEvent``. Both must be filtered
out, and every test here asserts the whole stream survives ``EventEncoder``.

Issue #2304 — a Strands generator tool that wraps another ``Agent``
(agent-as-tool) surfaces the inner agent's whole event stream as
``tool_stream_event`` payloads. The only branch reading those handles
``state`` snapshots and A2UI progress, so the inner agent's tool calls never
reach the frontend.

Both suites drive a REAL ``strands.Agent`` (parent and inner) over a scripted
model provider that replays Bedrock-shaped stream chunks. Nothing here
hand-builds the adapter's input events — they come out of Strands' own event
loop, so the assertions hold against real framework behaviour.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterable, Optional
from unittest.mock import MagicMock

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from ag_ui.encoder import EventEncoder
from strands import Agent as StrandsAgentCore
from strands import tool
from strands.models.model import Model

from ag_ui_strands.agent import StrandsAgent, _sanitize_raw_event
from ag_ui_strands.config import StrandsAgentConfig


# ---------------------------------------------------------------------------
# Scripted model provider
# ---------------------------------------------------------------------------


class ScriptedModel(Model):
    """Replays canned Bedrock-shaped stream turns, one turn per invocation."""

    def __init__(self, turns: list[list[dict]]) -> None:
        self._turns = list(turns)
        self.calls = 0

    def update_config(self, **model_config: Any) -> None:  # pragma: no cover
        pass

    def get_config(self) -> Any:  # pragma: no cover
        return {}

    def structured_output(self, *args: Any, **kwargs: Any):  # pragma: no cover
        raise NotImplementedError

    async def stream(
        self,
        messages: Any,
        tool_specs: Optional[list] = None,
        system_prompt: Optional[str] = None,
        **kwargs: Any,
    ) -> AsyncIterable[dict]:
        turn = self._turns[min(self.calls, len(self._turns) - 1)]
        self.calls += 1
        for event in turn:
            yield event


def _text_turn(text: str, citation: dict | None = None) -> list[dict]:
    events: list[dict] = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": text}}},
    ]
    if citation is not None:
        events.append({"contentBlockDelta": {"delta": {"citation": citation}}})
    events += [
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    return events


def _tool_turn(tool_use_id: str, name: str, input_json: str) -> list[dict]:
    return [
        {"messageStart": {"role": "assistant"}},
        {
            "contentBlockStart": {
                "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": input_json}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]


CITATION = {
    "title": "quarterly-report.pdf",
    "sourceContent": [{"text": "revenue grew 12%"}],
    "location": {"documentChar": {"documentIndex": 0, "start": 10, "end": 26}},
}


def _find_citation_payload(event: Any) -> Optional[dict]:
    """Locate the citation payload in a RAW event, whatever shape it arrives in.

    Strands changed ``CitationStreamEvent``'s envelope mid-1.x: releases
    1.15.0–1.20.0 emit ``{"callback": {"citation": ..., "delta": ...}}`` while
    1.21.0 and later emit ``{"citation": ..., "delta": ...}``. This package
    declares ``strands-agents>=1.15.0``, so both are in range and a test that
    pins one of them is version-fragile rather than behavioural. Searching
    recursively asserts what actually matters — the citation reached the wire
    instead of being dropped — without coupling to the envelope.
    """
    if not isinstance(event, dict):
        return None
    citation = event.get("citation")
    if isinstance(citation, dict):
        return citation
    for value in event.values():
        found = _find_citation_payload(value)
        if found is not None:
            return found
    return None


# ---------------------------------------------------------------------------
# Adapter wiring
# ---------------------------------------------------------------------------


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _wrap(strands_agent: StrandsAgentCore, thread_id: str = "t1") -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=StrandsAgentConfig()
    )
    agent._agents_by_thread[thread_id] = strands_agent
    return agent


def _run_input(thread_id: str = "t1") -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r1",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _collect(agent: StrandsAgent, thread_id: str = "t1") -> list:
    return [event async for event in agent.run(_run_input(thread_id))]


def _assert_stream_encodes(events: list) -> None:
    """Every event must survive ``EventEncoder``, exactly as the endpoint does.

    ``endpoint.py`` encodes each event as it streams and, on failure, emits a
    ``RunErrorEvent(code="ENCODING_ERROR")`` and **breaks** — so a single
    unserializable event truncates the run: no ``TEXT_MESSAGE_END``, no final
    snapshots, no ``RUN_FINISHED``. Collecting events in-process (as these tests
    do) never exercises that, which is why this guard is asserted explicitly in
    every test that can produce a RAW event.
    """
    encoder = EventEncoder()
    for event in events:
        try:
            encoder.encode(event)
        except Exception as exc:  # noqa: BLE001 - surfacing the real failure
            payload = getattr(event, "event", None)
            pytest.fail(
                f"event of type {event.type} is not encodable and would abort "
                f"the SSE stream: {type(exc).__name__}: {exc}\npayload={payload!r}"
            )


# ---------------------------------------------------------------------------
# Nested-agent fixture (agent-as-tool)
# ---------------------------------------------------------------------------


def _nested_agent(
    parent_tool_use_id: str = "tooluse_parent_1",
    inner_tool_use_id: str = "tooluse_inner_1",
) -> StrandsAgentCore:
    """A real parent Agent whose only tool wraps a real inner Agent.

    The inner agent calls a real ``@tool`` of its own; Strands surfaces the
    whole inner stream to the parent as ``tool_stream_event`` payloads.
    """

    @tool
    def lookup_weather(city: str) -> str:
        """Look up the weather for a city."""
        return f"sunny in {city}"

    inner = StrandsAgentCore(
        model=ScriptedModel(
            [
                _tool_turn(inner_tool_use_id, "lookup_weather", '{"city": "Paris"}'),
                _text_turn("Paris is sunny."),
            ]
        ),
        tools=[lookup_weather],
        callback_handler=None,
    )

    @tool
    async def research_agent(query: str):
        """Delegate research to a sub-agent."""
        async for event in inner.stream_async(query):
            yield event

    return StrandsAgentCore(
        model=ScriptedModel(
            [
                _tool_turn(parent_tool_use_id, "research_agent", '{"query": "weather"}'),
                _text_turn("Done."),
            ]
        ),
        tools=[research_agent],
        callback_handler=None,
    )


# ---------------------------------------------------------------------------
# Issue #2291 — RAW fallback
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bedrock_citation_event_is_emitted_as_raw():
    """A citation delta must reach the wire instead of being dropped."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_text_turn("Revenue grew.", citation=CITATION)]),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))
    _assert_stream_encodes(events)

    raw_events = [e for e in events if e.type == EventType.RAW]
    # ``CitationStreamEvent`` has TWO wire shapes across the range this package
    # declares (``strands-agents>=1.15.0``), verified against every published
    # 1.x wheel in that range:
    #
    #   1.15.0 – 1.20.0 : {"callback": {"citation": ..., "delta": ...}}
    #   1.21.0 – latest : {"citation": ..., "delta": ...}
    #
    # The adapter is right either way — RAW forwards the provider's own payload
    # verbatim rather than normalising a shape it does not own — so this test
    # must accept both instead of pinning whichever one the lockfile happens to
    # resolve. Asserting the top-level key alone made the suite fail on the
    # locked 1.18.0 while passing locally on a newer resolution.
    located = [
        (e, payload)
        for e in raw_events
        for payload in [_find_citation_payload(e.event)]
        if payload is not None
    ]
    assert located, (
        "expected a RAW event carrying the Bedrock citation payload; "
        f"got RAW events: {[e.event for e in raw_events]}"
    )
    event, payload = located[0]
    assert event.source == "strands"
    assert payload == CITATION


@pytest.mark.asyncio
async def test_lifecycle_events_are_not_emitted_as_raw():
    """The deliberate plumbing skips must stay silent, not turn into RAW."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_text_turn("hi")]),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))
    _assert_stream_encodes(events)

    lifecycle_keys = {"init_event_loop", "start_event_loop", "start", "complete", "force_stop"}
    leaked = [
        e.event
        for e in events
        if e.type == EventType.RAW
        and isinstance(e.event, dict)
        and lifecycle_keys & set(e.event)
    ]
    assert leaked == [], f"lifecycle events leaked as RAW: {leaked}"


@pytest.mark.asyncio
async def test_raw_fallback_does_not_disturb_mapped_events():
    """Text still streams normally alongside the new RAW fallback."""
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_text_turn("Revenue grew.", citation=CITATION)]),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))

    _assert_stream_encodes(events)

    deltas = "".join(
        e.delta for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT
    )
    assert deltas == "Revenue grew."
    assert events[-1].type == EventType.RUN_FINISHED


@pytest.mark.asyncio
async def test_raw_payloads_never_carry_invocation_state_injections():
    """`ModelStreamEvent.prepare()` merges `invocation_state` into any event
    holding a ``delta`` — the live ``Agent``, an OTel span, a telemetry
    ``Trace``, a ``UUID``. None of it is model output, and the ``Agent`` alone
    carries the system prompt, message history and model config. It must never
    be forwarded to a client, in any form, stringified or otherwise.
    """
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_text_turn("Revenue grew.", citation=CITATION)]),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))
    _assert_stream_encodes(events)

    raw_events = [e for e in events if e.type == EventType.RAW]
    assert raw_events, "expected at least one RAW event to inspect"

    forbidden = {
        "agent",
        "event_loop_cycle_id",
        "event_loop_cycle_trace",
        "event_loop_cycle_span",
        "event_loop_parent_span",
        "event_loop_parent_cycle_id",
        "request_state",
    }
    for raw in raw_events:
        leaked = forbidden & set(raw.event)
        assert not leaked, f"invocation_state leaked into a RAW payload: {leaked}"

    # And nothing anywhere in the emitted payloads may be a stringified Agent:
    # a `default=str` style escape hatch would pass the key check above while
    # still shipping the system prompt and history to the browser.
    blob = json.dumps([e.event for e in raw_events])
    assert "You are helpful" not in blob
    assert "strands.agent.agent.Agent" not in blob
    assert "<strands" not in blob


@pytest.mark.asyncio
async def test_terminal_lifecycle_events_are_not_emitted_as_raw():
    """`AgentResultEvent` / `EventLoopStopEvent` must not reach the wire.

    ``Agent.stream_async`` yields ``{"result": AgentResult(...)}`` at the end of
    EVERY invocation. It carries ``EventLoopMetrics.traces``, which Pydantic
    cannot serialize — forwarding it aborted the stream before RUN_FINISHED.
    It is also pure duplication: end-of-run is already RUN_FINISHED.
    """
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_text_turn("hi")]),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))
    _assert_stream_encodes(events)

    leaked = [
        e.event
        for e in events
        if e.type == EventType.RAW
        and isinstance(e.event, dict)
        and {"result", "stop"} & set(e.event)
    ]
    assert leaked == [], f"terminal lifecycle events leaked as RAW: {leaked}"
    assert events[-1].type == EventType.RUN_FINISHED

    # The end-to-end half above cannot actually pin ``_RAW_TERMINAL_KEYS``: a
    # real ``AgentResult`` is unserializable, so it is dropped by the strict
    # round-trip whether or not the key exclusion exists. Delete the exclusion
    # and the assertions above still pass. Exercise the sanitizer directly with
    # a *plainly serializable* payload so the drop can only come from the
    # exclusion this test is named for.
    for terminal_key in ("result", "stop"):
        serializable = {terminal_key: {"stop_reason": "end_turn", "metrics": {}}}
        assert json.dumps(serializable)  # the payload itself round-trips fine
        assert _sanitize_raw_event(serializable) is None, (
            f"{terminal_key!r} must be excluded from RAW by name, not by "
            "accidentally failing serialization"
        )


@pytest.mark.asyncio
async def test_assistant_message_is_not_re_emitted_as_raw():
    """Strands' ``ModelMessageEvent`` re-announces the finished assistant turn.

    Its text has already been streamed via TEXT_MESSAGE_CONTENT, so forwarding
    it as RAW re-sends the whole assistant message a second time.
    """
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_text_turn("Revenue grew.")]),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))
    _assert_stream_encodes(events)

    duplicated = [
        e.event
        for e in events
        if e.type == EventType.RAW
        and isinstance(e.event, dict)
        and isinstance(e.event.get("message"), dict)
        and e.event["message"].get("role") == "assistant"
    ]
    assert duplicated == [], (
        "the assistant message was re-emitted as RAW after already being "
        f"streamed as TEXT_MESSAGE_CONTENT: {duplicated}"
    )


# ---------------------------------------------------------------------------
# Issue #2304 — agent-as-tool inner event forwarding
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_inner_agent_tool_call_lifecycle_is_forwarded():
    """The sub-agent's own tool call must produce start/args/end/result."""
    events = await _collect(_wrap(_nested_agent()))
    _assert_stream_encodes(events)

    starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
    inner_starts = [e for e in starts if e.tool_call_name == "lookup_weather"]
    assert inner_starts, (
        "inner sub-agent tool call was never emitted; "
        f"only saw: {[e.tool_call_name for e in starts]}"
    )

    inner_id = inner_starts[0].tool_call_id

    args = [
        e
        for e in events
        if e.type == EventType.TOOL_CALL_ARGS and e.tool_call_id == inner_id
    ]
    assert "".join(e.delta for e in args) == '{"city": "Paris"}'

    ends = [
        e
        for e in events
        if e.type == EventType.TOOL_CALL_END and e.tool_call_id == inner_id
    ]
    assert len(ends) == 1

    results = [
        e
        for e in events
        if e.type == EventType.TOOL_CALL_RESULT and e.tool_call_id == inner_id
    ]
    assert len(results) == 1
    assert "sunny in Paris" in results[0].content


@pytest.mark.asyncio
async def test_inner_tool_call_lifecycle_is_ordered_within_the_parent_call():
    """Inner start/end must land between the parent tool's start and result."""
    events = await _collect(_wrap(_nested_agent()))
    _assert_stream_encodes(events)

    def _index(predicate) -> int:
        return next(i for i, e in enumerate(events) if predicate(e))

    parent_start = _index(
        lambda e: e.type == EventType.TOOL_CALL_START
        and e.tool_call_name == "research_agent"
    )
    inner_start = _index(
        lambda e: e.type == EventType.TOOL_CALL_START
        and e.tool_call_name == "lookup_weather"
    )
    inner_end = _index(
        lambda e: e.type == EventType.TOOL_CALL_END
        and events[inner_start].tool_call_id == e.tool_call_id
    )
    parent_result = _index(
        lambda e: e.type == EventType.TOOL_CALL_RESULT
        and e.tool_call_id == "tooluse_parent_1"
    )

    assert parent_start < inner_start < inner_end < parent_result


@pytest.mark.asyncio
async def test_inner_tool_call_id_cannot_collide_with_a_parent_id():
    """An inner agent reusing the parent's toolUseId must not alias it."""
    events = await _collect(
        _wrap(
            _nested_agent(
                parent_tool_use_id="tooluse_1",
                inner_tool_use_id="tooluse_1",
            )
        )
    )
    _assert_stream_encodes(events)

    starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
    by_name = {e.tool_call_name: e.tool_call_id for e in starts}
    assert by_name["research_agent"] == "tooluse_1"
    assert by_name["lookup_weather"] != by_name["research_agent"]
    assert "tooluse_1" in by_name["lookup_weather"]

    # And the inner result must not resolve the parent's tool card.
    inner_results = [
        e
        for e in events
        if e.type == EventType.TOOL_CALL_RESULT
        and e.tool_call_id == by_name["lookup_weather"]
    ]
    assert len(inner_results) == 1


# ---------------------------------------------------------------------------
# Issue #2304 — two agent-as-tool calls in one parallel batch
# ---------------------------------------------------------------------------


class _Sequencer:
    """Forces a specific interleaving across concurrently streaming agents.

    Strands runs a parallel tool batch through ``asyncio.gather``
    (``strands/tools/executors/concurrent.py``), so two agent-as-tool calls
    interleave their inner streams non-deterministically. This pins one exact
    interleaving so the regression below cannot flake either way.
    """

    def __init__(self, order: list[str]) -> None:
        self._order = list(order)
        self._index = 0
        self._condition = asyncio.Condition()

    async def step(self, label: str) -> None:
        if label not in self._order:
            return  # ungated: proceed freely
        async with self._condition:
            await self._condition.wait_for(
                lambda: self._index >= len(self._order)
                or self._order[self._index] == label
            )
            if self._index < len(self._order):
                self._index += 1
            self._condition.notify_all()


def _gate_inner_events(agent_label: str, sequencer: _Sequencer):
    """Wrap a sub-agent's stream, gating the events whose order drives the bug.

    Gating happens where the sub-agent's events are re-yielded into the parent's
    tool stream, because that is where Strands' concurrent executor enqueues
    them — gating at the model instead would not pin the order the *adapter*
    observes, since the executor's one-event-in-flight handshake reorders
    relative to model production.
    """
    counters: Dict[str, int] = {}

    def _label(event: Any) -> Optional[str]:
        if not isinstance(event, dict):
            return None
        if isinstance(event.get("current_tool_use"), dict):
            counters["tooluse"] = counters.get("tooluse", 0) + 1
            return f"{agent_label}:tooluse#{counters['tooluse']}"
        model_chunk = event.get("event")
        if isinstance(model_chunk, dict) and "contentBlockStop" in model_chunk:
            counters["stop"] = counters.get("stop", 0) + 1
            return f"{agent_label}:stop#{counters['stop']}"
        return None

    async def gated(stream):
        async for event in stream:
            label = _label(event)
            if label:
                await sequencer.step(label)
            yield event

    return gated


def _parallel_agent_as_tool_parent(sequencer: _Sequencer) -> StrandsAgentCore:
    """A parent Agent that invokes TWO agent-as-tool tools in one batch.

    Sub-agent A calls a tool of its own, streaming its arguments across two
    deltas. Sub-agent B has no tools at all — it just answers — so the only
    ``contentBlockStop`` it produces belongs to a *text* block. That asymmetry
    is the point: B's text stop has no inner call of its own to close, and an
    unscoped "newest still-open inner call" search makes it close A's instead.
    """

    @tool
    def lookup_weather(city: str) -> str:
        """Look up the weather for a city."""
        return f"sunny in {city}"

    # A's tool arguments arrive in two deltas, so the adapter emits a second
    # TOOL_CALL_ARGS after B's stop lands — which is what makes the misclose
    # observable on the wire.
    inner_a = StrandsAgentCore(
        model=ScriptedModel(
            [
                [
                    {"messageStart": {"role": "assistant"}},
                    {
                        "contentBlockStart": {
                            "start": {
                                "toolUse": {
                                    "toolUseId": "inner_a_1",
                                    "name": "lookup_weather",
                                }
                            }
                        }
                    },
                    {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"city": '}}}},
                    {"contentBlockDelta": {"delta": {"toolUse": {"input": '"Paris"}'}}}},
                    {"contentBlockStop": {}},
                    {"messageStop": {"stopReason": "tool_use"}},
                ],
                _text_turn("Paris is sunny."),
            ]
        ),
        tools=[lookup_weather],
        callback_handler=None,
    )
    # B answers directly — no tools, so its only contentBlockStop is a text one.
    inner_b = StrandsAgentCore(
        model=ScriptedModel([_text_turn("AMZN is up.")]),
        callback_handler=None,
    )

    gate_a = _gate_inner_events("A", sequencer)
    gate_b = _gate_inner_events("B", sequencer)

    @tool
    async def weather_agent(query: str):
        """Delegate weather research to a sub-agent."""
        async for event in gate_a(inner_a.stream_async(query)):
            yield event

    @tool
    async def finance_agent(query: str):
        """Delegate finance research to a sub-agent."""
        async for event in gate_b(inner_b.stream_async(query)):
            yield event

    parent_turn = [
        {"messageStart": {"role": "assistant"}},
        {
            "contentBlockStart": {
                "start": {"toolUse": {"toolUseId": "parent_a", "name": "weather_agent"}}
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"query": "weather"}'}}}},
        {"contentBlockStop": {}},
        {
            "contentBlockStart": {
                "start": {"toolUse": {"toolUseId": "parent_b", "name": "finance_agent"}}
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"query": "stocks"}'}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]

    return StrandsAgentCore(
        model=ScriptedModel([parent_turn, _text_turn("Done.")]),
        tools=[weather_agent, finance_agent],
        callback_handler=None,
    )


@pytest.mark.asyncio
async def test_parallel_agent_as_tool_calls_close_their_own_inner_calls():
    """A parent's contentBlockStop must not close a *sibling* parent's call.

    ``inner_tool_calls_seen`` is one dict shared by every agent-as-tool call in
    the run, and Strands executes a parallel tool batch concurrently, so two
    sub-agents interleave their streams. Closing "the newest still-open inner
    call" without checking which parent the stop came from makes sub-agent B's
    stop resolve sub-agent A's call — A's card closes while its arguments are
    still streaming, and A's own stop then finds nothing left to close.
    """
    sequencer = _Sequencer(
        [
            "A:tooluse#1",  # A opens its inner call, first half of its args.
            "B:stop#1",  # B's *text* block stops — it owns no inner call.
            "A:tooluse#2",  # A streams the rest of its args.
            "A:stop#1",  # Only now may A's inner call legitimately close.
        ]
    )

    events = await _collect(_wrap(_parallel_agent_as_tool_parent(sequencer)))
    _assert_stream_encodes(events)

    starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
    inner = [e for e in starts if e.tool_call_name == "lookup_weather"]
    assert inner, "sub-agent A's inner tool call was never opened"
    inner_id = inner[0].tool_call_id
    assert inner_id.startswith("parent_a::"), (
        f"inner call is not namespaced under its owning parent: {inner_id}"
    )

    def _indices(event_type) -> list[int]:
        return [
            i
            for i, e in enumerate(events)
            if e.type == event_type and getattr(e, "tool_call_id", None) == inner_id
        ]

    end_indices = _indices(EventType.TOOL_CALL_END)
    args_indices = _indices(EventType.TOOL_CALL_ARGS)

    assert len(end_indices) == 1, (
        "sub-agent A's inner tool call must be closed exactly once; "
        f"got {len(end_indices)} TOOL_CALL_END events for {inner_id}"
    )
    assert len(args_indices) == 2, (
        f"expected both argument deltas for {inner_id}, got {len(args_indices)}"
    )
    assert end_indices[0] > args_indices[-1], (
        "sub-agent A's inner tool call was closed by sibling sub-agent B's "
        "contentBlockStop — TOOL_CALL_END arrived while A's arguments were "
        f"still streaming (END at {end_indices[0]}, last ARGS at {args_indices[-1]})"
    )

    # And B, which never opened an inner call, must not have closed anything.
    all_ends = [e.tool_call_id for e in events if e.type == EventType.TOOL_CALL_END]
    assert not [i for i in all_ends if i.startswith("parent_b::")], (
        f"sub-agent B opened no inner call yet closed one: {all_ends}"
    )


# ---------------------------------------------------------------------------
# Issue #2291 — suppressed payloads must not re-enter through the RAW fallback
# ---------------------------------------------------------------------------


class _ReplayAgent:
    """Yields a fixed event list, standing in for ``Agent.stream_async``.

    The suppression gates under test key off flag values (``reasoning`` false,
    ``current_tool_use`` empty) that Strands' own constructors never produce at
    any version in range — ``ReasoningTextStreamEvent`` hardcodes
    ``reasoning: True``. The gates exist precisely for the payload shapes a
    provider or a future release could emit, so they can only be exercised by
    feeding the dispatch chain directly. The genuinely reachable case (an empty
    text delta) is covered below by a real ``strands.Agent``.
    """

    def __init__(self, events: list[dict]) -> None:
        self._events = events
        self.model = MagicMock()
        self.system_prompt = "test"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.record_direct_tool_call = True

    async def stream_async(self, message: Any):
        for event in self._events:
            yield event


def _wrap_replay(events: list[dict], thread_id: str = "t1") -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=StrandsAgentConfig()
    )
    agent._agents_by_thread[thread_id] = _ReplayAgent(events)
    return agent


@pytest.mark.parametrize(
    ("event", "secret"),
    [
        # Reasoning suppressed because the ``reasoning`` flag is off.
        ({"reasoningText": "chain of thought", "reasoning": False}, "chain of thought"),
        # Same, with the flag absent entirely.
        ({"reasoningText": "chain of thought"}, "chain of thought"),
        # Redacted reasoning is encrypted provider content; the adapter exposes
        # it only as REASONING_ENCRYPTED_VALUE, never as a bare payload.
        (
            {"reasoningRedactedContent": "cipher-text", "reasoning": False},
            "cipher-text",
        ),
        # The verification token is deliberately never surfaced to the UI.
        ({"reasoning_signature": "sig-abc123", "reasoning": False}, "sig-abc123"),
    ],
)
@pytest.mark.asyncio
async def test_suppressed_reasoning_payloads_do_not_leak_as_raw(event, secret):
    """A mapped-but-suppressed payload must stay suppressed, not become RAW.

    These branches are guarded suppression gates, e.g.
    ``elif "reasoningText" in event and event.get("reasoning")``. When the guard
    is false the branch is skipped — and with a terminal ``else`` added for
    issue #2291, the event then falls all the way through, so the withheld text
    is forwarded verbatim as RAW. The adapter would be publishing over RAW
    exactly the content the reasoning gate exists to withhold.

    The pre-existing reasoning tests miss this: they assert only that no
    ``REASONING_*`` event fires, which stays true while the payload leaks out
    the other door.
    """
    events = await _collect(_wrap_replay([event, {"data": "Visible answer."}]))
    _assert_stream_encodes(events)

    raw_events = [e.event for e in events if e.type == EventType.RAW]
    leaked = [r for r in raw_events if secret in json.dumps(r)]
    assert leaked == [], (
        f"suppressed payload {secret!r} was forwarded as RAW anyway: {leaked}"
    )
    assert raw_events == [], f"suppressed event should be silent, got RAW: {raw_events}"

    # The suppression must be surgical: ordinary output still streams.
    assert any(e.type == EventType.TEXT_MESSAGE_CONTENT for e in events)


@pytest.mark.asyncio
async def test_empty_tool_use_update_is_not_emitted_as_raw():
    """``current_tool_use`` is owned by the tool-call branch, empty or not.

    Its handler is gated on the value being non-empty. An empty update carries
    nothing a client can act on, so falling through to RAW is pure noise.
    """
    events = await _collect(
        _wrap_replay([{"current_tool_use": None}, {"current_tool_use": {}}])
    )
    _assert_stream_encodes(events)

    raw_events = [e.event for e in events if e.type == EventType.RAW]
    assert raw_events == [], f"empty tool-use updates leaked as RAW: {raw_events}"


@pytest.mark.asyncio
async def test_empty_text_delta_is_not_emitted_as_raw():
    """An empty text delta must be silent — proven against a real ``Agent``.

    Unlike the gates above, this one is reachable today: on the locked
    strands-agents 1.18.0 a real ``Agent`` streaming an empty text delta emits
    ``TextStreamEvent`` as ``{"data": "", "delta": {"text": ""}}``. The text
    branch is gated on ``event["data"]`` being truthy, so without this fix the
    event falls through and every empty delta becomes a RAW event carrying no
    information at all.
    """
    strands_agent = StrandsAgentCore(
        model=ScriptedModel([_text_turn("")]),
        callback_handler=None,
    )

    events = await _collect(_wrap(strands_agent))
    _assert_stream_encodes(events)

    raw_events = [e.event for e in events if e.type == EventType.RAW]
    assert raw_events == [], f"empty text delta leaked as RAW: {raw_events}"

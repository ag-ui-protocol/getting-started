"""Developer callback failures are reported on the wire, not only in the log.

The per-tool and per-prompt hooks are each wrapped so a throw degrades the run
instead of ending it. That is deliberate, but until these
events existed the only trace was a server-side warning, so a developer whose
callback threw saw nothing in the browser and nothing in their own application.

A hook failure now also yields ``CustomEvent(name="hook_error")`` carrying
``{"hook", "tool", "error"}``. Eight of the nine sites report every failure;
``tool_stream_event_handler`` runs per streamed chunk and reports once per tool
call, which ``TestRunIsUnaffected`` holds. The name and the keys match the TypeScript
bridge exactly so a client handles one shape across both languages. Two things
deliberately do not match, and are pinned below so a change to either is a test
failure rather than a surprise:

- ``hook`` carries Python's spelling of the callback the developer configured
  (``state_from_args``), not TypeScript's (``stateFromArgs``).
- ``tool_stream_event_handler`` is reported here and only logged in TypeScript.
  What is pinned below is that Python reports it; TypeScript's side of that
  sentence is not observable from this file.

``session_manager_provider`` is deliberately absent: a throw from it is not
swallowed, so it has nothing to surface. ``TestTheCarveOut`` holds that.

The per-site tests assert two things together: the event reaches the wire, AND
the run still does what it did before the event existed. Each also asserts the
exception message reaches ``value["error"]``, because the sites do not all bind
the caught exception to the same variable name. The contract and
characterization tests further down assert narrower properties and say so.

Only the Python half of the two divergences can be held from here. Nothing in
this file observes ``typescript/src/agent.ts``, so a change on that side is
caught by review, not by this suite.
"""

from __future__ import annotations

import ast
import collections.abc
import dataclasses
import json
import logging
import re
import typing
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    RunAgentInput,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands.tools.registry import ToolRegistry

import ag_ui_strands.agent as agent_module
import ag_ui_strands.config as config_module
from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import (
    StrandsAgentConfig,
    ToolBehavior,
    ToolStreamEventContext,
)


BOOM = "callback exploded"


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    mock.session_manager = None
    mock._session_manager = None
    return mock


def _build_agent(
    thread_id: str,
    stream_events: list,
    config: StrandsAgentConfig,
) -> StrandsAgent:
    agent = StrandsAgent(_template_agent(), name="test-agent", config=config)
    inner = MagicMock()
    inner.tool_registry = ToolRegistry()
    inner.session_manager = None
    inner._session_manager = None
    inner._interrupt_state = None

    async def _stream(_message):
        for event in stream_events:
            yield event

    inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = inner
    return agent


def _input(thread_id: str, messages: list | None = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="run-1",
        state={},
        messages=messages if messages is not None else [
            UserMessage(id="u1", content="do the thing")
        ],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _run(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


def _hook_errors(events: list) -> list:
    return [
        e
        for e in events
        if e.type == EventType.CUSTOM and getattr(e, "name", "") == "hook_error"
    ]


def _assert_inside_the_run_envelope(events: list) -> None:
    """Every report must fall between RUN_STARTED and the run's terminal event.

    A CUSTOM event outside that envelope is a protocol violation the AG-UI
    client verifier rejects. Every emitting site sits after a RunStartedEvent
    today, which is a property of where those sites were placed rather than one
    the code enforces, so it is asserted rather than assumed.
    """
    types = [e.type for e in events]
    assert EventType.RUN_STARTED in types, "no run to be inside of"
    start = types.index(EventType.RUN_STARTED)
    terminal = [
        i
        for i, t in enumerate(types)
        if t in (EventType.RUN_FINISHED, EventType.RUN_ERROR)
    ]
    # Falling back to the end of the list here would make the check pass in
    # exactly the case the docstring calls a violation: a stream that never
    # terminates. Demand a terminal event instead.
    assert terminal, f"the run never terminated; got {types}"
    end = terminal[0]
    for index, event in enumerate(events):
        if (
            event.type == EventType.CUSTOM
            and getattr(event, "name", "") == "hook_error"
        ):
            assert start < index < end, (
                f"hook_error at position {index} falls outside the "
                f"RUN_STARTED..terminal envelope ({start}..{end})"
            )


def _assert_reports(events: list, hook: str, tool: str) -> None:
    """Assert the wire carries exactly this hook failure, message included.

    The message check is what catches a site binding the wrong exception
    variable: the sites do not all name the caught exception ``e``.
    """
    _assert_inside_the_run_envelope(events)
    errors = _hook_errors(events)
    assert [e.value["hook"] for e in errors] == [hook], (
        f"expected one {hook} report; got {[e.value for e in errors]}"
    )
    assert errors[0].value["tool"] == tool
    assert BOOM in errors[0].value["error"], (
        f"the caught exception must reach the wire; got {errors[0].value['error']!r}"
    )


# The exact log lines the nine sites emit. Matching these rather than a bare
# "failed" keeps unrelated adapter warnings (media-conversion fallbacks, for
# one) out of the exact-count and exc_info assertions below.
_HOOK_LOG_LINE = re.compile(
    r"(State context builder failed"
    r"|state_context_builder failed"
    r"|(state_from_args|state_from_result|custom_result_handler"
    r"|args_streamer|tool_stream_event_handler) failed for )"
)


def _hook_records(caplog) -> list:
    """Hook-failure log records at whatever level they were emitted.

    Level is deliberately not part of this filter. ``TestTheLogContract``
    asserts the level, and filtering on it first would make that circular.
    """
    return [
        r
        for r in caplog.records
        if r.name == "ag_ui_strands.agent" and _HOOK_LOG_LINE.search(r.getMessage())
    ]


def _hook_warnings(caplog) -> list:
    """The warning-level subset, for tests counting logged attempts rather than
    asserting the level itself."""
    return [r for r in _hook_records(caplog) if r.levelno == logging.WARNING]


def _finished(events: list) -> bool:
    return any(e.type == EventType.RUN_FINISHED for e in events)


def _tool_call_stream(tool_name: str, tool_use_id: str, args: str) -> list:
    return [
        {
            "current_tool_use": {
                "name": tool_name,
                "toolUseId": tool_use_id,
                "input": args,
            }
        },
        {"event": {"contentBlockStop": {}}},
    ]


async def _ok_streamer(_context):
    yield "{}"


def _stream_event_chunks(tool_name: str, tool_use_id: str, count: int) -> list:
    return [
        {
            "tool_stream_event": {
                "tool_use": {"name": tool_name, "toolUseId": tool_use_id},
                "data": {"i": i},
            }
        }
        for i in range(count)
    ]


def _tool_result(tool_use_id: str, text: str = "done") -> dict:
    return {
        "message": {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": tool_use_id, "content": [{"text": text}]}}
            ],
        }
    }


class TestPayloadShape:
    """The wire contract itself, pinned against the TypeScript bridge."""

    async def test_event_name_and_payload_keys(self):
        def bad_builder(_input_data, _text):
            raise RuntimeError(BOOM)

        agent = _build_agent(
            "shape",
            [{"data": "hi"}],
            StrandsAgentConfig(state_context_builder=bad_builder),
        )
        events = await _run(agent, _input("shape"))
        _assert_inside_the_run_envelope(events)
        assert _finished(events)
        errors = _hook_errors(events)

        assert errors, "a throwing hook must reach the wire"
        for event in errors:
            assert event.type == EventType.CUSTOM
            assert event.name == "hook_error"
            assert set(event.value) == {"hook", "tool", "error"}
            assert event.value["hook"] == "state_context_builder"
            assert event.value["tool"] == "__prompt__"
            assert BOOM in event.value["error"]

    async def test_no_event_when_the_hook_succeeds(self):
        calls = []

        def good_builder(_input_data, text):
            calls.append(text)
            return f"{text} (enriched)"

        agent = _build_agent(
            "quiet",
            [{"data": "hi"}],
            StrandsAgentConfig(state_context_builder=good_builder),
        )
        assert _hook_errors(await _run(agent, _input("quiet"))) == []
        assert calls, "the builder must actually run, or this proves nothing"


class TestAwaitedHooks:
    """The hooks that go through ``maybe_await`` accept coroutines too, and the
    failure has to surface identically whether the hook was sync or async."""

    async def test_async_state_from_args(self):
        async def bad_state_from_args(_context):
            raise RuntimeError(BOOM)

        config = StrandsAgentConfig(
            tool_behaviors={
                "make_chart": ToolBehavior(state_from_args=bad_state_from_args)
            }
        )
        agent = _build_agent(
            "async-hook",
            _tool_call_stream("make_chart", "tc-8", '{"kind":"bar"}'),
            config,
        )
        events = await _run(agent, _input("async-hook"))

        _assert_reports(events, "state_from_args", "make_chart")
        assert any(e.type == EventType.TOOL_CALL_END for e in events)
        assert _finished(events)


class TestStateContextBuilder:
    async def test_both_builder_sites_report_and_the_run_survives(self, caplog):
        """The prompt path and the replayed-history path each report."""

        def bad_builder(_input_data, _text):
            raise RuntimeError(BOOM)

        agent = _build_agent(
            "builder",
            [{"data": "still talking"}],
            StrandsAgentConfig(state_context_builder=bad_builder),
        )
        with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
            events = await _run(agent, _input("builder"))

        errors = _hook_errors(events)
        assert len(errors) == 2, (
            "the builder runs once on the outgoing prompt and once on the "
            f"replayed history; got {[e.value for e in errors]}"
        )
        assert {e.value["hook"] for e in errors} == {"state_context_builder"}
        assert {e.value["tool"] for e in errors} == {"__prompt__"}
        for event in errors:
            assert BOOM in event.value["error"]

        # The traceback goes to the log, not to the wire, at both sites. The
        # two sites happen to log different spellings, which is the only thing
        # distinguishing them: without this, one site firing twice would pass.
        warnings = _hook_warnings(caplog)
        assert sorted(r.getMessage().split(":")[0] for r in warnings) == [
            "State context builder failed",
            "state_context_builder failed",
        ], (
            "one report must come from each builder site; got "
            f"{[r.getMessage() for r in warnings]}"
        )
        assert all(r.exc_info for r in warnings)
        for event in errors:
            assert "Traceback" not in event.value["error"]

        assert _finished(events)
        assert any(
            e.type == EventType.TEXT_MESSAGE_CONTENT and "still talking" in e.delta
            for e in events
        )


class TestStateFromArgs:
    """Three call sites: the streaming path, the continuation path, and the
    legacy path taken when the tool also supplies an ``args_streamer``."""

    @staticmethod
    def _bad_state_from_args(_context):
        raise RuntimeError(BOOM)

    async def test_streaming_path(self):
        config = StrandsAgentConfig(
            tool_behaviors={
                "make_chart": ToolBehavior(
                    state_from_args=self._bad_state_from_args
                )
            }
        )
        agent = _build_agent(
            "args-streaming",
            _tool_call_stream("make_chart", "tc-1", '{"kind":"bar"}'),
            config,
        )
        events = await _run(agent, _input("args-streaming"))

        _assert_reports(events, "state_from_args", "make_chart")

        # Unchanged semantics: the tool call is still opened and closed, and
        # the model's own arguments still stream. The deltas are what tell this
        # branch apart from the legacy one below, which lets the developer's
        # streamer drive them instead.
        assert any(e.type == EventType.TOOL_CALL_START for e in events)
        assert any(e.type == EventType.TOOL_CALL_END for e in events)
        assert [
            e.delta for e in events if e.type == EventType.TOOL_CALL_ARGS
        ] == ['{"kind":"bar"}']
        assert _finished(events)

    async def test_continuation_path(self):
        """A tool whose result is already in history takes the pending branch."""
        config = StrandsAgentConfig(
            tool_behaviors={
                "make_chart": ToolBehavior(
                    state_from_args=self._bad_state_from_args
                )
            }
        )
        agent = _build_agent(
            "args-pending",
            _tool_call_stream("make_chart", "tc-2", '{"kind":"bar"}'),
            config,
        )
        events = await _run(
            agent,
            _input(
                "args-pending",
                messages=[
                    UserMessage(id="u1", content="chart it"),
                    AssistantMessage(
                        id="a1",
                        content="",
                        tool_calls=[
                            ToolCall(
                                id="tc-2",
                                type="function",
                                function=FunctionCall(
                                    name="make_chart", arguments='{"kind":"bar"}'
                                ),
                            )
                        ],
                    ),
                    ToolMessage(id="t1", tool_call_id="tc-2", content="charted"),
                ],
            ),
        )

        _assert_reports(events, "state_from_args", "make_chart")

        # Unchanged semantics: the continuation branch emits no tool-call events.
        assert not any(e.type == EventType.TOOL_CALL_START for e in events)
        assert not any(e.type == EventType.TOOL_CALL_END for e in events)
        assert _finished(events)

    async def test_legacy_args_streamer_path(self):
        async def streamer(_context):
            yield "<from-the-streamer>"

        config = StrandsAgentConfig(
            tool_behaviors={
                "make_chart": ToolBehavior(
                    args_streamer=streamer,
                    state_from_args=self._bad_state_from_args,
                )
            }
        )
        agent = _build_agent(
            "args-legacy",
            _tool_call_stream("make_chart", "tc-3", '{"kind":"bar"}'),
            config,
        )
        events = await _run(agent, _input("args-legacy"))

        _assert_reports(events, "state_from_args", "make_chart")
        assert any(e.type == EventType.TOOL_CALL_END for e in events)
        # The developer's streamer drove the arguments, which is what
        # distinguishes this branch from the streaming one above.
        assert [
            e.delta for e in events if e.type == EventType.TOOL_CALL_ARGS
        ] == ["<from-the-streamer>"]
        assert _finished(events)


class TestArgsStreamer:
    async def test_reports_and_still_falls_back_to_the_full_args(self):
        async def bad_streamer(_context):
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        config = StrandsAgentConfig(
            tool_behaviors={"make_chart": ToolBehavior(args_streamer=bad_streamer)}
        )
        agent = _build_agent(
            "streamer",
            _tool_call_stream("make_chart", "tc-4", '{"kind":"bar"}'),
            config,
        )
        events = await _run(agent, _input("streamer"))

        _assert_reports(events, "args_streamer", "make_chart")

        # Unchanged semantics: Python falls back to emitting the full args.
        deltas = [e.delta for e in events if e.type == EventType.TOOL_CALL_ARGS]
        assert json.loads("".join(deltas)) == {"kind": "bar"}
        assert any(e.type == EventType.TOOL_CALL_END for e in events)
        assert _finished(events)


class TestResultHooks:
    async def test_state_from_result(self):
        def bad_state_from_result(_context):
            raise RuntimeError(BOOM)

        config = StrandsAgentConfig(
            tool_behaviors={
                "make_chart": ToolBehavior(state_from_result=bad_state_from_result)
            }
        )
        agent = _build_agent(
            "result-state",
            _tool_call_stream("make_chart", "tc-5", "{}") + [_tool_result("tc-5")],
            config,
        )
        events = await _run(agent, _input("result-state"))

        _assert_reports(events, "state_from_result", "make_chart")

        # Unchanged semantics: the result still reaches the wire.
        assert any(e.type == EventType.TOOL_CALL_RESULT for e in events)
        assert _finished(events)

    async def test_custom_result_handler(self):
        async def bad_handler(_context):
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        config = StrandsAgentConfig(
            tool_behaviors={
                "make_chart": ToolBehavior(custom_result_handler=bad_handler)
            }
        )
        agent = _build_agent(
            "result-handler",
            _tool_call_stream("make_chart", "tc-6", "{}") + [_tool_result("tc-6")],
            config,
        )
        events = await _run(agent, _input("result-handler"))

        _assert_reports(events, "custom_result_handler", "make_chart")
        assert any(e.type == EventType.TOOL_CALL_RESULT for e in events)
        assert _finished(events)


class TestToolStreamEventHandler:
    async def test_reports_and_the_stream_continues(self):
        async def bad_handler(_context: ToolStreamEventContext):
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        config = StrandsAgentConfig(
            tool_behaviors={
                "sub_agent": ToolBehavior(tool_stream_event_handler=bad_handler)
            }
        )
        stream = [
            {
                "tool_stream_event": {
                    "tool_use": {"name": "sub_agent", "toolUseId": "tc-7"},
                    "data": {"progress": 50},
                }
            },
            {"data": "all good after the error"},
        ]
        agent = _build_agent("tse", stream, config)
        events = await _run(agent, _input("tse"))

        _assert_reports(events, "tool_stream_event_handler", "sub_agent")

        # Unchanged semantics: text after the failure still arrives.
        assert any(
            e.type == EventType.TEXT_MESSAGE_CONTENT and "all good" in e.delta
            for e in events
        )
        assert _finished(events)


class TestRunIsUnaffected:
    """The point of the change is visibility. These pin the parts of "nothing
    else changed" that the per-site tests do not reach."""

    async def test_a_throwing_builder_leaves_the_prompt_alone(self):
        """The documented fallback is that the original message survives.

        On the default config the adapter hands Strands the reconciled history
        rather than a prompt string, so the surviving text is asserted there.
        """

        def bad_builder(_input_data, _text):
            raise RuntimeError(BOOM)

        agent = _build_agent(
            "prompt-intact",
            [{"data": "ok"}],
            StrandsAgentConfig(state_context_builder=bad_builder),
        )
        inner = agent._agents_by_thread["prompt-intact"]

        events = await _run(agent, _input("prompt-intact"))

        assert _hook_errors(events), "the failure must still be reported"

        texts = [
            block["text"]
            for message in inner.messages
            if message.get("role") == "user"
            for block in message.get("content", [])
            if "text" in block
        ]
        assert texts == ["do the thing"], (
            f"the unenriched message must reach the agent; got {texts}"
        )
        assert _finished(events)

    async def test_a_per_chunk_hook_reports_once_per_tool_call(self, caplog):
        """``tool_stream_event_handler`` runs per streamed chunk. A handler that
        throws throws on every one of them, and the wire must not carry a copy
        of the same failure per chunk.

        Reporting once must not be achieved by calling the handler once: the
        handler is a developer's code and the adapter still owes it every chunk.
        Both halves are asserted, because suppressing the call instead of the
        event passes any test that only counts events.
        """
        chunks = 25
        attempts = []

        async def bad_handler(context: ToolStreamEventContext):
            attempts.append(context.stream_data)
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        config = StrandsAgentConfig(
            tool_behaviors={
                "sub_agent": ToolBehavior(tool_stream_event_handler=bad_handler)
            }
        )
        stream = _stream_event_chunks("sub_agent", "tc-flood", chunks) + [
            {"data": "still talking"}
        ]

        agent = _build_agent("flood", stream, config)
        with caplog.at_level(logging.WARNING, logger="ag_ui_strands.agent"):
            events = await _run(agent, _input("flood"))

        _assert_reports(events, "tool_stream_event_handler", "sub_agent")

        # Unchanged semantics: the handler is still attempted on every chunk,
        # and the log still records every attempt.
        assert attempts == [{"i": i} for i in range(chunks)], (
            f"the handler must still see every chunk in order; got {attempts}"
        )
        assert len(_hook_warnings(caplog)) == chunks, (
            f"the log must still record every attempt; got {len(_hook_warnings(caplog))}"
        )
        assert any(
            e.type == EventType.TEXT_MESSAGE_CONTENT and "still talking" in e.delta
            for e in events
        )
        assert _finished(events)

    async def test_one_tool_with_two_empty_ids_collapses_into_one_report(self):
        """Characterization of the dedupe key's one soft spot.

        The key is the tool plus the call id the stream supplies. Two calls to
        the SAME tool that both arrive with an empty id are indistinguishable to
        it, so they collapse, and nothing is lost: the payload carries no call
        id either, so the second report would have been byte-identical.
        """

        async def bad_handler(_context: ToolStreamEventContext):
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        config = StrandsAgentConfig(
            tool_behaviors={
                "sub_agent": ToolBehavior(tool_stream_event_handler=bad_handler)
            }
        )
        stream = _stream_event_chunks("sub_agent", "", 2)

        agent = _build_agent("empty-id", stream, config)
        events = await _run(agent, _input("empty-id"))

        _assert_reports(events, "tool_stream_event_handler", "sub_agent")
        assert _finished(events)

    async def test_two_tools_with_empty_ids_each_still_report(self):
        """The collapse above must not reach across tools.

        Two different tools arriving with the same absent id produce reports
        that differ in their `tool` field, so dropping the second loses real
        information. The key includes the tool name for exactly this case.
        """

        async def bad_handler(_context: ToolStreamEventContext):
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        config = StrandsAgentConfig(
            tool_behaviors={
                "tool_a": ToolBehavior(tool_stream_event_handler=bad_handler),
                "tool_b": ToolBehavior(tool_stream_event_handler=bad_handler),
            }
        )
        stream = _stream_event_chunks("tool_a", "", 1) + _stream_event_chunks(
            "tool_b", "", 1
        )

        agent = _build_agent("two-tools", stream, config)
        events = await _run(agent, _input("two-tools"))
        errors = _hook_errors(events)

        assert [e.value["tool"] for e in errors] == ["tool_a", "tool_b"], (
            "each tool owes its own report; got "
            f"{[e.value['tool'] for e in errors]}"
        )
        assert _finished(events)

    async def test_two_tool_calls_each_report_their_own_failure(self):
        """Reporting once per tool call must not swallow the second call's."""

        async def bad_handler(_context: ToolStreamEventContext):
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        config = StrandsAgentConfig(
            tool_behaviors={
                "sub_agent": ToolBehavior(tool_stream_event_handler=bad_handler)
            }
        )
        stream = _stream_event_chunks("sub_agent", "tc-a", 3) + _stream_event_chunks(
            "sub_agent", "tc-b", 3
        )

        agent = _build_agent("two-calls", stream, config)
        events = await _run(agent, _input("two-calls"))
        errors = _hook_errors(events)

        assert len(errors) == 2, (
            f"one report per tool call, not per chunk; got {len(errors)}"
        )
        for event in errors:
            assert event.value["hook"] == "tool_stream_event_handler"
            assert BOOM in event.value["error"]
        assert _finished(events)

    async def test_the_report_is_once_per_run_not_once_per_process(self):
        """The bookkeeping that dedupes within a run must not outlive it.

        The same thread reuses its cached agent, so state hung off the adapter
        rather than the run would silence every run after the first.
        """
        attempts = []

        async def bad_handler(context: ToolStreamEventContext):
            attempts.append(context.stream_data)
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        config = StrandsAgentConfig(
            tool_behaviors={
                "sub_agent": ToolBehavior(tool_stream_event_handler=bad_handler)
            }
        )
        agent = _build_agent(
            "repeat", _stream_event_chunks("sub_agent", "tc-r", 3), config
        )

        for run_number in (1, 2, 3):
            attempts.clear()
            events = await _run(agent, _input("repeat"))
            _assert_inside_the_run_envelope(events)
            assert _finished(events)
            assert len(_hook_errors(events)) == 1, (
                f"run {run_number} must report the failure once; the dedupe "
                "bookkeeping is per run, not per adapter"
            )
            assert attempts == [{"i": 0}, {"i": 1}, {"i": 2}], (
                f"run {run_number} must still attempt every chunk; got {attempts}"
            )


class TestTheCarveOut:
    """``session_manager_provider`` is a developer callback the adapter does NOT
    swallow, which is why it is absent from the nine sites. It is not the only
    fail-loud callback in the package, only the one that sits closest to these.
    If it ever starts degrading instead, this is where it shows up."""

    async def test_a_throwing_session_manager_provider_ends_the_run(self):
        calls = []

        def bad_provider(input_data):
            calls.append(input_data.thread_id)
            raise RuntimeError(BOOM)

        agent = StrandsAgent(
            _template_agent(),
            name="test-agent",
            config=StrandsAgentConfig(session_manager_provider=bad_provider),
        )
        events = await _run(agent, _input("carve-out"))

        _assert_inside_the_run_envelope(events)
        assert _hook_errors(events) == [], (
            "a hook that ends the run has nothing to surface as a hook_error"
        )
        errors = [e for e in events if e.type == EventType.RUN_ERROR]
        assert [e.code for e in errors] == ["SESSION_MANAGER_ERROR"]
        assert calls, "the provider must actually run, or this proves nothing"
        assert not _finished(events)


class TestKnownRoughEdges:
    """Characterization, not endorsement.

    Two behaviours here are worse than they should be. The corrupt arguments
    predate the wire event. The empty ``error`` string does not: that payload
    is new, and it is left alone because TypeScript derives the same empty
    string and diverging would break the parity the event exists for.

    Both are pinned so that changing either is a deliberate act with a failing
    test attached, rather than a silent drift.
    """

    async def test_a_message_less_exception_reports_an_empty_string(self):
        """``str(exception)`` is empty for an exception raised with no message,
        so the report says which hook broke but not why. TypeScript's
        ``_errorMessage`` has the same hole, so this is parity rather than a
        Python quirk."""

        def bad_state_from_result(_context):
            raise TimeoutError

        config = StrandsAgentConfig(
            tool_behaviors={
                "make_chart": ToolBehavior(state_from_result=bad_state_from_result)
            }
        )
        agent = _build_agent(
            "empty-message",
            _tool_call_stream("make_chart", "tc-9", "{}") + [_tool_result("tc-9")],
            config,
        )
        events = await _run(agent, _input("empty-message"))
        _assert_inside_the_run_envelope(events)
        assert _finished(events)
        errors = _hook_errors(events)

        assert len(errors) == 1
        assert errors[0].value["hook"] == "state_from_result"
        assert errors[0].value["error"] == ""

    async def test_a_mid_stream_args_streamer_failure_corrupts_the_arguments(self):
        """A streamer that yields part of the arguments and then throws leaves
        the concatenated ``TOOL_CALL_ARGS`` unparseable, because the fallback
        replays the full arguments on top of the deltas already sent.

        TypeScript emits no fallback delta at all. Fixing this changes what a
        throwing hook does to the run, which is why the report was added
        without touching it.
        """

        async def partial_streamer(_context):
            yield '{"kind":'
            raise RuntimeError(BOOM)

        config = StrandsAgentConfig(
            tool_behaviors={"make_chart": ToolBehavior(args_streamer=partial_streamer)}
        )
        agent = _build_agent(
            "partial-args",
            _tool_call_stream("make_chart", "tc-10", '{"kind":"bar"}'),
            config,
        )
        events = await _run(agent, _input("partial-args"))

        _assert_reports(events, "args_streamer", "make_chart")

        joined = "".join(
            e.delta for e in events if e.type == EventType.TOOL_CALL_ARGS
        )
        assert joined.startswith('{"kind":{'), (
            f"the fallback must land on top of the partial delta; got {joined!r}"
        )
        with pytest.raises(json.JSONDecodeError):
            json.loads(joined)

        # The run still finishes, which is the property this change protects.
        # The tool call itself is the casualty, and was before the event too.
        assert any(e.type == EventType.TOOL_CALL_END for e in events)
        assert _finished(events)


def _raise_sync(_context):
    raise RuntimeError(BOOM)


async def _raise_async_gen(_context):
    raise RuntimeError(BOOM)
    yield  # pragma: no cover - makes this an async generator


def _log_contract_cases():
    """One entry per site that logs WITH a traceback, labelled by site."""
    chart = _tool_call_stream("make_chart", "log-tc", '{"kind":"bar"}')
    pending = [
        UserMessage(id="u1", content="chart it"),
        AssistantMessage(
            id="a1",
            content="",
            tool_calls=[
                ToolCall(
                    id="log-pending",
                    type="function",
                    function=FunctionCall(name="make_chart", arguments="{}"),
                )
            ],
        ),
        ToolMessage(id="t1", tool_call_id="log-pending", content="ok"),
    ]
    return [
        (
            "state_context_builder (both sites)",
            StrandsAgentConfig(state_context_builder=lambda _i, _t: _raise_sync(None)),
            [{"data": "hi"}],
            None,
            2,
        ),
        (
            "state_from_args (streaming path)",
            StrandsAgentConfig(
                tool_behaviors={"make_chart": ToolBehavior(state_from_args=_raise_sync)}
            ),
            chart,
            None,
            1,
        ),
        (
            "state_from_args (continuation path)",
            StrandsAgentConfig(
                tool_behaviors={"make_chart": ToolBehavior(state_from_args=_raise_sync)}
            ),
            _tool_call_stream("make_chart", "log-pending", "{}"),
            pending,
            1,
        ),
        (
            "state_from_args (legacy args_streamer path)",
            StrandsAgentConfig(
                tool_behaviors={
                    "make_chart": ToolBehavior(
                        args_streamer=_ok_streamer, state_from_args=_raise_sync
                    )
                }
            ),
            chart,
            None,
            1,
        ),
        (
            "state_from_result",
            StrandsAgentConfig(
                tool_behaviors={
                    "make_chart": ToolBehavior(state_from_result=_raise_sync)
                }
            ),
            chart + [_tool_result("log-tc")],
            None,
            1,
        ),
        (
            "custom_result_handler",
            StrandsAgentConfig(
                tool_behaviors={
                    "make_chart": ToolBehavior(custom_result_handler=_raise_async_gen)
                }
            ),
            chart + [_tool_result("log-tc")],
            None,
            1,
        ),
        (
            "tool_stream_event_handler",
            StrandsAgentConfig(
                tool_behaviors={
                    "sub_agent": ToolBehavior(tool_stream_event_handler=_raise_async_gen)
                }
            ),
            _stream_event_chunks("sub_agent", "log-tse", 1),
            None,
            1,
        ),
    ]


class TestTheLogContract:
    """The log is the other half of the contract and the only half carrying a
    traceback, so what it does is asserted here rather than only described.

    Every one of the nine sites is driven, by seven parametrized cases plus the
    ``args_streamer`` test below. Six cases cover one site each; the
    ``state_context_builder`` case covers both of its sites in one run, because
    one broken builder necessarily hits both. Parametrizing means a failure
    names its case and does not abort the others.

    Eight sites log with ``exc_info``; ``args_streamer`` is the documented
    exception and is asserted as such, so adding a traceback there fails and
    sends whoever did it to the sentence in ARCHITECTURE.md that has to change
    with it.
    """

    async def _records_for(self, caplog, thread, config, stream, messages=None):
        """Every hook-failure record, unfiltered by level, so the level itself
        can be asserted rather than assumed."""
        agent = _build_agent(thread, stream, config)
        caplog.clear()
        with caplog.at_level(logging.DEBUG, logger="ag_ui_strands.agent"):
            await _run(agent, _input(thread, messages=messages))
        return _hook_records(caplog)

    @pytest.mark.parametrize(
        "label,config,stream,messages,expected",
        _log_contract_cases(),
        ids=[case[0] for case in _log_contract_cases()],
    )
    async def test_the_site_logs_at_warning_with_a_traceback(
        self, caplog, label, config, stream, messages, expected
    ):
        """Holds for the eight sites that log a traceback. The ninth,
        ``args_streamer``, is the documented exception and is asserted by the
        test below, so adding a traceback there fails that one, not this."""
        records = await self._records_for(
            caplog, f"log-{label}", config, stream, messages
        )
        assert len(records) == expected, (
            f"{label} must log {expected} time(s); got "
            f"{[r.getMessage() for r in records]}"
        )
        assert all(r.levelno == logging.WARNING for r in records), (
            f"{label} logs at warning, which ARCHITECTURE.md states; got "
            f"{[r.levelname for r in records]}"
        )
        assert all(r.exc_info for r in records), (
            f"{label} must log the traceback the wire event omits"
        )

    async def test_the_args_streamer_site_logs_without_a_traceback(self, caplog):
        """Characterization of the documented exception to the rule above: this
        is the one site whose failure leaves no traceback anywhere, which is
        also the hook whose failure damages the tool call."""

        async def bad_streamer(_context):
            raise RuntimeError(BOOM)
            yield  # pragma: no cover - makes this an async generator

        records = await self._records_for(
            caplog,
            "log-streamer",
            StrandsAgentConfig(
                tool_behaviors={"make_chart": ToolBehavior(args_streamer=bad_streamer)}
            ),
            _tool_call_stream("make_chart", "log-streamer", "{}"),
        )

        assert len(records) == 1
        assert records[0].levelno == logging.WARNING
        assert not records[0].exc_info, (
            "if this site gained exc_info, ARCHITECTURE.md's "
            "'eight of the nine sites' claim needs updating with it"
        )


class TestEverySwallowSiteReports:
    """The invariant behind the site count, checked against the source itself.

    Counting emissions would only notice someone deleting one. The failure this
    guards is the opposite and likelier: a future hook site that catches, logs
    and carries on, and forgets to report. That site would be invisible to every
    other test here, and it would quietly falsify the "nine sites" arithmetic
    the docstrings and ARCHITECTURE.md are written around.

    The set of hooks is read off the config dataclasses rather than listed here,
    so adding a hook field extends this check automatically. The rule keys on
    what the guarded code CALLS, not on how the handler happens to log, because
    a handler that switched to ``logger.exception`` or reworded its message
    would otherwise slip through.

    A handler that ends the run is exempt, and that is how the
    ``session_manager_provider`` carve-out stays derived instead of hardcoded:
    its handler returns, so it owes no hint event.
    """

    @staticmethod
    def _hook_field_names() -> set:
        """Every developer-supplied callback field on the config dataclasses.

        Derived, not listed: the module declares its hook types as Callable
        aliases, so the aliases are collected from the module and the fields are
        matched against them. Adding a hook alias and a field that uses it
        extends this check with no edit here. ``config.py`` uses string
        annotations, so the match is textual against the alias names.
        """
        callable_aliases = {
            name
            for name, value in vars(config_module).items()
            if not name.startswith("_")
            and typing.get_origin(value) is collections.abc.Callable
        }
        assert callable_aliases, (
            "no Callable aliases found in config.py; the module layout changed "
            "and this check is no longer deriving anything"
        )
        names = set()
        for cls in (ToolBehavior, StrandsAgentConfig):
            for field in dataclasses.fields(cls):
                annotation = str(field.type)
                if any(alias in annotation for alias in callable_aliases):
                    names.add(field.name)
        assert names, "no hook fields found; the config layout changed"
        return names

    @classmethod
    def _guarded_hook_calls(cls):
        """Every hook invocation paired with its INNERMOST enclosing handler.

        Innermost matters: the run body sits inside one big try whose handlers
        end the run, and every hook call is nested somewhere inside it. Only the
        guard closest to the call is the one that decides whether that hook's
        failure degrades or terminates.
        """
        source = Path(agent_module.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        hooks = cls._hook_field_names()

        parents = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                parents[child] = node

        def innermost_try(node):
            seen_body = node
            walker = parents.get(node)
            while walker is not None:
                if isinstance(walker, ast.Try) and any(
                    seen_body is stmt or seen_body in ast.walk(stmt)
                    for stmt in walker.body
                ):
                    return walker
                seen_body = walker
                walker = parents.get(walker)
            return None

        pairs = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Attribute) or node.attr not in hooks:
                continue
            guard = innermost_try(node)
            if guard is None:
                continue
            for handler in guard.handlers:
                body = ast.get_source_segment(source, handler) or ""
                pairs.append((handler.lineno, node.attr, handler, body))
        return pairs

    @staticmethod
    def _ends_the_run(handler: ast.ExceptHandler) -> bool:
        """A handler that returns, re-raises or reports a terminal error.

        Such a handler does not degrade the run, so the hook it guards owes no
        hint event. This is how the ``session_manager_provider`` carve-out stays
        derived rather than hardcoded.

        Walks the handler's own statements. Substring-matching its source would
        let the word "return" in a comment exempt a handler that swallows, and
        re-parsing that source is not possible: an ``except`` clause on its own
        is not valid Python, so every handler would look exempt.
        """
        for statement in handler.body:
            for node in ast.walk(statement):
                if isinstance(node, (ast.Return, ast.Raise)):
                    return True
                if isinstance(node, ast.Name) and node.id in (
                    "RunErrorEvent",
                    "_error_events",
                ):
                    return True
        return False

    def test_every_degrading_hook_handler_also_reports(self):
        offenders = sorted(
            set(
                (lineno, hook)
                for lineno, hook, handler, body in self._guarded_hook_calls()
                if not self._ends_the_run(handler) and "_hook_error(" not in body
            )
        )
        assert offenders == [], (
            "these except handlers guard a developer hook, swallow its failure "
            "and never put it on the wire, at agent.py "
            f"{[lineno for lineno, _ in offenders]} (hooks: "
            f"{sorted({hook for _, hook in offenders})}). Add "
            "`yield _hook_error(<hook>, <tool>, <exc>)` beside the log, and "
            "update the site count in the three places that state it: this "
            "file's docstring, _hook_error's docstring and ARCHITECTURE.md."
        )

    def test_the_site_count_is_what_everything_else_claims(self):
        """Nine. Written down in four places, so it is asserted in one."""
        reporting = {
            lineno
            for lineno, _hook, _handler, body in self._guarded_hook_calls()
            if "_hook_error(" in body
        }
        assert len(reporting) == 9, (
            f"found {len(reporting)} reporting hook handlers at agent.py "
            f"{sorted(reporting)}, not the nine that this file's docstring, "
            "_hook_error's docstring and ARCHITECTURE.md all state. Whichever "
            "moved, move the other three."
        )

    def test_the_carve_out_is_still_a_carve_out(self):
        """``session_manager_provider`` must stay in the fail-loud set.

        If its handler ever starts degrading instead of returning, the count
        above becomes ten and every claim written around nine goes stale.
        """
        degrading = [
            (lineno, hook)
            for lineno, hook, handler, _body in self._guarded_hook_calls()
            if hook == "session_manager_provider" and not self._ends_the_run(handler)
        ]
        assert degrading == [], (
            "session_manager_provider now degrades rather than ending the run "
            f"at agent.py {degrading}; it owes a hook_error and the site count "
            "is no longer nine."
        )

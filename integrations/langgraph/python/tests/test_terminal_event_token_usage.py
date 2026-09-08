"""Terminal-event token usage (OSS-886).

``RUN_FINISHED.usage`` and ``RUN_ERROR.usage`` are documented on the protocol
but were never populated by the Python producer — only by the TypeScript one.
These tests pin the Python side to the same behaviour: per-model-call
``usage_metadata`` is accumulated during the run and folded into one entry per
``(provider, model)`` at the terminal event.

Two rules carry most of the weight and are asserted from both directions:

* **omit vs zero** — a provider that reported nothing leaves ``usage`` absent,
  never present-with-zeros. "Not measured" and "measured zero" are different
  answers, and a consumer showing 0 tokens for an unreported run is wrong.
* **numeric-only** — ``TokenUsage`` feeds anonymous usage telemetry, so no
  content-bearing provider field may be copied into it, whatever else the
  provider attaches next to the counts.

Like ``test_exit_custom_event.py``, these drive the real pipeline
(``_handle_stream_events`` -> ``_handle_single_event`` -> ``_dispatch_event``)
over a synthetic LangGraph event stream, rather than calling the emit helpers
directly — the capture point is inside the streaming path and its ORDER
relative to the finish-reason early return is the thing most likely to break.
"""

import math
import unittest
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from ag_ui.core import EventType, RunAgentInput

from tests._helpers import make_agent


def _chunk_event(
    *,
    usage_metadata: Any = None,
    finish_reason: Optional[str] = None,
    content: str = "",
    provider: Optional[str] = "openai",
    model: Optional[str] = "gpt-4o",
    node: str = "model",
    message_id: str = "run--msg1",
):
    """An ``on_chat_model_stream`` event, optionally carrying usage metadata.

    ``usage_metadata`` is assigned after construction on purpose: LangChain
    validates the field against its ``UsageMetadata`` TypedDict at construction,
    which would reject exactly the malformed payloads these tests must feed in.
    Real providers deliver those payloads regardless — the metadata comes off
    the wire, not out of a constructor.

    ``provider`` / ``model`` become the standard LangChain run metadata keys
    (``ls_provider`` / ``ls_model_name``); ``None`` omits the key entirely, which
    is what providers that report no labels look like.
    """
    chunk = AIMessageChunk(content=content, id=message_id)
    chunk.response_metadata = {"finish_reason": finish_reason} if finish_reason else {}
    chunk.tool_call_chunks = []
    chunk.usage_metadata = usage_metadata

    metadata = {"langgraph_node": node}
    if provider is not None:
        metadata["ls_provider"] = provider
    if model is not None:
        metadata["ls_model_name"] = model

    return {
        "event": "on_chat_model_stream",
        "run_id": "run1",
        "metadata": metadata,
        "data": {"chunk": chunk},
        "name": node,
        "parent_ids": [],
        "tags": [],
    }


def _model_end_event(
    *,
    usage_metadata: Any = None,
    run_id: str = "run1",
    provider: Optional[str] = "openai",
    model: Optional[str] = "gpt-4o",
    node: str = "model",
    output_as_dict: bool = False,
):
    """An ``on_chat_model_end`` event carrying the aggregated output message.

    This is the only channel a non-streaming model uses — it emits no
    ``on_chat_model_stream`` event at all.
    """
    if output_as_dict:
        output: Any = {"usage_metadata": usage_metadata}
    else:
        output = AIMessage(content="hi")
        output.usage_metadata = usage_metadata

    metadata = {"langgraph_node": node}
    if provider is not None:
        metadata["ls_provider"] = provider
    if model is not None:
        metadata["ls_model_name"] = model

    return {
        "event": "on_chat_model_end",
        "run_id": run_id,
        "metadata": metadata,
        "data": {"output": output},
        "name": node,
        "parent_ids": [],
        "tags": [],
    }


class _NonStreamingModel(BaseChatModel):
    """A model with no ``_astream``, so LangChain emits no stream events for it
    — the shape a real provider takes when streaming is disabled, or when a
    tool call is answered without streaming."""

    @property
    def _llm_type(self) -> str:
        return "test-non-streaming"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        message = AIMessage(
            content="hi",
            usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
        )
        return ChatResult(generations=[ChatGeneration(message=message)])


class _StreamingModel(BaseChatModel):
    """A model that streams and reports usage on its final chunk, as real
    streaming providers do."""

    @property
    def _llm_type(self) -> str:
        return "test-streaming"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="hi"))])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        yield ChatGenerationChunk(message=AIMessageChunk(content="h"))
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="i",
                usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
                response_metadata={"finish_reason": "stop"},
            )
        )


async def _events_from_real_model(model, *, node="model", provider="openai",
                                  model_name="gpt-4o"):
    """Capture what LangChain ACTUALLY emits for a model call, rather than
    assuming the event shape.

    The model-call events are taken verbatim and only have the LangGraph run
    metadata merged in (which LangGraph, not LangChain, supplies). If a future
    LangChain changes where usage lives, these fixtures change with it and the
    tests fail loudly — which is the point.
    """
    captured = []
    async for event in model.astream_events([HumanMessage("q")], version="v2"):
        if event["event"] not in ("on_chat_model_stream", "on_chat_model_end"):
            continue
        event["metadata"] = {
            **(event.get("metadata") or {}),
            "langgraph_node": node,
            "ls_provider": provider,
            "ls_model_name": model_name,
        }
        captured.append(event)
    return captured


def _error_event(message: str = "boom", node: str = "model"):
    return {
        "event": "error",
        "run_id": "run1",
        "metadata": {"langgraph_node": node},
        "data": {"message": message},
        "name": node,
        "parent_ids": [],
        "tags": [],
    }


def _usage(input_tokens=None, output_tokens=None, total_tokens=None,
           reasoning=None, cache_read=None, **extra):
    """A LangChain-shaped ``usage_metadata`` payload.

    ``extra`` keys land at the top level, which is how a provider smuggles
    content-bearing fields in next to the counts.
    """
    payload = {}
    if input_tokens is not None:
        payload["input_tokens"] = input_tokens
    if output_tokens is not None:
        payload["output_tokens"] = output_tokens
    if total_tokens is not None:
        payload["total_tokens"] = total_tokens
    if reasoning is not None:
        payload["output_token_details"] = {"reasoning": reasoning}
    if cache_read is not None:
        payload["input_token_details"] = {"cache_read": cache_read}
    payload.update(extra)
    return payload


async def _drive(agent, stream_events, interrupts=None):
    """Drive the real streaming pipeline over ``stream_events``.

    Takes the agent rather than building one, so a test can drive the SAME
    agent twice and check that per-run state does not leak between runs.
    """

    async def fake_stream():
        for ev in stream_events:
            yield ev

    final_state = MagicMock()
    final_state.values = {"messages": []}
    if interrupts:
        task = MagicMock()
        task.interrupts = list(interrupts)
        final_state.tasks = [task]
        final_state.next = ("model",)
    else:
        final_state.tasks = []
        final_state.next = []
    final_state.metadata = {"writes": {}}

    mock_prepared = {
        "state": {"messages": []},
        "stream": fake_stream(),
        "config": {"configurable": {"thread_id": "t1"}},
    }

    def fake_get_state_snapshot(state):
        if isinstance(state, dict):
            return state
        return getattr(state, "values", {}) or {}

    with patch.object(agent, "prepare_stream", AsyncMock(return_value=mock_prepared)), \
         patch.object(agent.graph, "aget_state", AsyncMock(return_value=final_state)), \
         patch.object(agent, "get_state_snapshot", side_effect=fake_get_state_snapshot):
        input_data = RunAgentInput(
            thread_id="t1",
            run_id="run1",
            messages=[],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )
        return [ev async for ev in agent._handle_stream_events(input_data)]


async def _run(stream_events, interrupts=None, **agent_kwargs):
    agent = make_agent(**{"emit_raw_events": False, **agent_kwargs})
    return await _drive(agent, stream_events, interrupts=interrupts)


def _terminal(emitted, event_type):
    matches = [
        ev for ev in emitted
        if ev is not None and getattr(ev, "type", None) == event_type
    ]
    types = [None if ev is None else getattr(ev, "type", None) for ev in emitted]
    assert len(matches) == 1, f"expected exactly one {event_type}; got {types!r}"
    return matches[0]


def _wire(event):
    """The event as it reaches the client. Absent counts must be absent, not
    ``null`` — which is what distinguishes "not measured" from zero on the
    wire."""
    return event.model_dump(by_alias=True, exclude_none=True)


class TestRunFinishedUsage(unittest.IsolatedAsyncioTestCase):
    async def test_a_single_model_call_reports_its_usage(self):
        emitted = await _run([
            _chunk_event(content="hi"),
            _chunk_event(
                usage_metadata=_usage(
                    input_tokens=100, output_tokens=50, total_tokens=150,
                    reasoning=20, cache_read=10,
                ),
                finish_reason="stop",
            ),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertEqual(
            _wire(finished)["usage"],
            [{
                "provider": "openai",
                "model": "gpt-4o",
                "inputTokens": 100,
                "outputTokens": 50,
                "totalTokens": 150,
                "reasoningTokens": 20,
                "cachedInputTokens": 10,
            }],
        )

    async def test_usage_on_the_finish_reason_chunk_is_not_dropped(self):
        """LangChain attaches ``usage_metadata`` to the FINAL chunk — the same
        one that carries ``finish_reason`` and makes the handler return early.
        Capture therefore has to happen before that return, so this is the
        whole feature in one assertion: the only chunk carrying usage here is
        the one that returns early."""
        emitted = await _run([
            _chunk_event(content="hi"),
            _chunk_event(usage_metadata=_usage(input_tokens=7), finish_reason="stop"),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertEqual([u.input_tokens for u in finished.usage], [7])

    async def test_repeated_calls_to_one_model_are_summed(self):
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens=100, output_tokens=20,
                                               total_tokens=120), finish_reason="stop"),
            _chunk_event(usage_metadata=_usage(input_tokens=10, output_tokens=5,
                                               total_tokens=15), finish_reason="stop"),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertEqual(len(finished.usage), 1)
        self.assertEqual(
            (finished.usage[0].input_tokens,
             finished.usage[0].output_tokens,
             finished.usage[0].total_tokens),
            (110, 25, 135),
        )

    async def test_distinct_models_stay_separate_in_first_seen_order(self):
        emitted = await _run([
            _chunk_event(model="gpt-4o", usage_metadata=_usage(input_tokens=1),
                         finish_reason="stop"),
            _chunk_event(model="gpt-4o-mini", usage_metadata=_usage(input_tokens=2),
                         finish_reason="stop"),
            _chunk_event(model="gpt-4o", usage_metadata=_usage(input_tokens=3),
                         finish_reason="stop"),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertEqual([u.model for u in finished.usage], ["gpt-4o", "gpt-4o-mini"])
        self.assertEqual([u.input_tokens for u in finished.usage], [4, 2])

    async def test_a_field_only_some_calls_report_is_summed_over_those_calls(self):
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens=1, reasoning=7),
                         finish_reason="stop"),
            _chunk_event(usage_metadata=_usage(input_tokens=2), finish_reason="stop"),
            _chunk_event(usage_metadata=_usage(input_tokens=3, reasoning=5),
                         finish_reason="stop"),
        ])

        entry = _terminal(emitted, EventType.RUN_FINISHED).usage[0]
        self.assertEqual(entry.input_tokens, 6)
        self.assertEqual(entry.reasoning_tokens, 12)
        # No call reported these, so they must not appear at all.
        self.assertIsNone(entry.output_tokens)
        self.assertNotIn("outputTokens", _wire(_terminal(emitted, EventType.RUN_FINISHED))["usage"][0])

    async def test_unlabelled_usage_is_still_reported(self):
        """Some providers attach no ``ls_provider`` / ``ls_model_name``. The
        counts are still real; only the labels are missing."""
        emitted = await _run([
            _chunk_event(provider=None, model=None,
                         usage_metadata=_usage(input_tokens=5), finish_reason="stop"),
        ])

        self.assertEqual(
            _wire(_terminal(emitted, EventType.RUN_FINISHED))["usage"],
            [{"inputTokens": 5}],
        )


class TestUsageIsOmittedNotZeroed(unittest.IsolatedAsyncioTestCase):
    """"Not reported" must stay distinguishable from "reported as zero"."""

    async def test_a_run_with_no_provider_usage_omits_the_field_entirely(self):
        emitted = await _run([
            _chunk_event(content="hi"),
            _chunk_event(finish_reason="stop"),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertIsNone(finished.usage)
        self.assertNotIn("usage", _wire(finished))

    async def test_usage_with_no_usable_count_omits_the_field_entirely(self):
        """A labels-only or zeroed entry would claim a measurement that never
        happened, so nothing is emitted at all."""
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens="nope"), finish_reason="stop"),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertIsNone(finished.usage)
        self.assertNotIn("usage", _wire(finished))

    async def test_a_measured_zero_is_reported_as_zero(self):
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens=4, output_tokens=0),
                         finish_reason="stop"),
        ])

        self.assertEqual(
            _wire(_terminal(emitted, EventType.RUN_FINISHED))["usage"],
            [{"provider": "openai", "model": "gpt-4o", "inputTokens": 4, "outputTokens": 0}],
        )


class TestMalformedProviderCounts(unittest.IsolatedAsyncioTestCase):
    """A bad count must never reach the wire. Consumers validate every event and
    raise on failure, so one malformed count would fail an otherwise-successful
    run at its FINAL event — and on the Python side the ``TokenUsage``
    constructor would raise inside the producer's own terminal path. Either way
    the user loses the answer, not just the token count."""

    async def test_malformed_counts_are_dropped_and_the_run_still_finishes(self):
        emitted = await _run([
            _chunk_event(
                usage_metadata={
                    "input_tokens": "100",          # string
                    "output_tokens": None,          # not reported
                    "total_tokens": float("nan"),   # NaN
                    "input_token_details": {"cache_read": -1},      # negative
                    "output_token_details": {"reasoning": 1.5},     # fractional
                },
                finish_reason="stop",
            ),
            _chunk_event(usage_metadata=_usage(output_tokens=9), finish_reason="stop"),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertEqual(
            _wire(finished)["usage"],
            [{"provider": "openai", "model": "gpt-4o", "outputTokens": 9}],
        )

    async def test_infinite_counts_are_dropped(self):
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens=math.inf, output_tokens=3),
                         finish_reason="stop"),
        ])

        entry = _terminal(emitted, EventType.RUN_FINISHED).usage[0]
        self.assertIsNone(entry.input_tokens)
        self.assertEqual(entry.output_tokens, 3)

    async def test_an_integer_too_large_to_be_a_float_does_not_abort_the_run(self):
        """Regression: the count guard called ``math.isfinite`` first, which
        coerces to float and raises ``OverflowError`` on a large int. The
        exception escaped mid-stream, so the run died with no terminal event —
        the guard killing the run it exists to protect."""
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens=10**1000, output_tokens=4),
                         finish_reason="stop"),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertEqual(
            _wire(finished)["usage"],
            [{"provider": "openai", "model": "gpt-4o", "outputTokens": 4}],
        )

    async def test_a_huge_integer_on_the_model_end_path_does_not_abort_the_run(self):
        emitted = await _run([
            _model_end_event(usage_metadata=_usage(input_tokens=10**1000)),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertIsNone(finished.usage)

    async def test_counts_beyond_the_safe_integer_wire_range_are_dropped(self):
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens=2**53, output_tokens=6),
                         finish_reason="stop"),
        ])

        entry = _terminal(emitted, EventType.RUN_FINISHED).usage[0]
        self.assertIsNone(entry.input_tokens)
        self.assertEqual(entry.output_tokens, 6)

    async def test_a_wholly_malformed_payload_does_not_fail_the_run(self):
        """The regression this guards: an unguarded count raises a
        ValidationError while BUILDING RUN_FINISHED, so the run ends with no
        terminal event at all."""
        emitted = await _run([
            _chunk_event(usage_metadata="not a mapping at all", finish_reason="stop"),
            _chunk_event(usage_metadata=[1, 2, 3], finish_reason="stop"),
            _chunk_event(usage_metadata={"input_tokens": {"nested": "object"}},
                         finish_reason="stop"),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertIsNone(finished.usage)


class TestNonStreamingModelUsage(unittest.IsolatedAsyncioTestCase):
    """A model call that does not stream reports its usage ONLY on
    ``on_chat_model_end``. Capturing from ``on_chat_model_stream`` alone missed
    every such call — streaming disabled, or a tool call answered without
    streaming — and those runs finished with no usage at all."""

    async def test_a_real_non_streaming_model_reports_usage(self):
        """Driven by what LangChain actually emits, not a hand-built event."""
        events = await _events_from_real_model(_NonStreamingModel())

        # Guard the fixture: if LangChain ever starts emitting stream events for
        # a model with no _astream, this test would silently stop covering the
        # non-streaming path.
        self.assertEqual(
            [e["event"] for e in events], ["on_chat_model_end"],
            "fixture must exercise the non-streaming path (no stream events)",
        )

        finished = _terminal(await _run(events), EventType.RUN_FINISHED)
        self.assertEqual(
            _wire(finished)["usage"],
            [{
                "provider": "openai",
                "model": "gpt-4o",
                "inputTokens": 3,
                "outputTokens": 2,
                "totalTokens": 5,
            }],
        )

    async def test_model_end_usage_is_recorded(self):
        emitted = await _run([
            _model_end_event(usage_metadata=_usage(input_tokens=3, output_tokens=2,
                                                   total_tokens=5)),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertEqual(
            _wire(finished)["usage"],
            [{"provider": "openai", "model": "gpt-4o", "inputTokens": 3,
              "outputTokens": 2, "totalTokens": 5}],
        )

    async def test_model_end_output_delivered_as_a_dict_still_works(self):
        emitted = await _run([
            _model_end_event(usage_metadata=_usage(input_tokens=8),
                             output_as_dict=True),
        ])

        self.assertEqual(
            [u.input_tokens for u in _terminal(emitted, EventType.RUN_FINISHED).usage],
            [8],
        )

    async def test_model_end_without_usage_changes_nothing(self):
        emitted = await _run([_chunk_event(finish_reason="stop"), _model_end_event()])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertIsNone(finished.usage)
        self.assertNotIn("usage", _wire(finished))


class TestStreamedCallsAreNotDoubleCounted(unittest.IsolatedAsyncioTestCase):
    """A streaming provider reports the same counts TWICE — once on the final
    stream chunk, once on the aggregated model-end output — under the same run
    id. The model-end read is a fallback, not an addition."""

    async def test_a_real_streaming_model_is_counted_once(self):
        events = await _events_from_real_model(_StreamingModel())

        # Guard the fixture: this test is only meaningful if LangChain really
        # does report the same usage on both channels.
        with_usage = [
            e for e in events
            if getattr(
                (e["data"].get("chunk") or e["data"].get("output")),
                "usage_metadata", None,
            )
        ]
        self.assertEqual(
            [e["event"] for e in with_usage],
            ["on_chat_model_stream", "on_chat_model_end"],
            "fixture must report usage on BOTH channels for one call",
        )
        self.assertEqual(
            len({e["run_id"] for e in with_usage}), 1,
            "both reports must belong to the same model call",
        )

        finished = _terminal(await _run(events), EventType.RUN_FINISHED)
        self.assertEqual(
            _wire(finished)["usage"],
            [{"provider": "openai", "model": "gpt-4o", "inputTokens": 3,
              "outputTokens": 2, "totalTokens": 5}],
            "the streamed call's tokens must be reported once, not doubled",
        )

    async def test_model_end_repeating_a_streamed_call_is_ignored(self):
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens=3, output_tokens=2),
                         finish_reason="stop"),
            _model_end_event(usage_metadata=_usage(input_tokens=3, output_tokens=2)),
        ])

        entry = _terminal(emitted, EventType.RUN_FINISHED).usage[0]
        self.assertEqual((entry.input_tokens, entry.output_tokens), (3, 2))

    async def test_a_streamed_call_and_a_separate_non_streamed_call_both_count(self):
        """Dedup is per model call, not per run: a second call that never
        streamed must still be counted."""
        streamed = _chunk_event(usage_metadata=_usage(input_tokens=3),
                                finish_reason="stop")
        streamed["run_id"] = "call-a"

        emitted = await _run([
            streamed,
            _model_end_event(usage_metadata=_usage(input_tokens=3), run_id="call-a"),
            _model_end_event(usage_metadata=_usage(input_tokens=10), run_id="call-b"),
        ])

        self.assertEqual(
            [u.input_tokens for u in _terminal(emitted, EventType.RUN_FINISHED).usage],
            [13],
        )

    async def test_dedup_state_does_not_leak_between_runs(self):
        agent = make_agent(emit_raw_events=False)

        first = await _drive(agent, [
            _model_end_event(usage_metadata=_usage(input_tokens=5), run_id="call-a"),
        ])
        self.assertEqual(
            [u.input_tokens for u in _terminal(first, EventType.RUN_FINISHED).usage],
            [5],
        )

        # Same model-call run id in the next run: a set that survived the run
        # boundary would swallow this entirely.
        second = await _drive(agent, [
            _model_end_event(usage_metadata=_usage(input_tokens=7), run_id="call-a"),
        ])
        self.assertEqual(
            [u.input_tokens for u in _terminal(second, EventType.RUN_FINISHED).usage],
            [7],
        )


class TestUsageCarriesNoContent(unittest.IsolatedAsyncioTestCase):
    """``TokenUsage`` feeds anonymous usage telemetry. Nothing content-bearing
    or identifying may ride along, however the provider labels it."""

    SECRETS = {
        "prompt": "what is the capital of France?",
        "completion": "Paris",
        "messages": [{"role": "user", "content": "SECRET-CONTENT"}],
        "text": "SECRET-CONTENT",
        "content": "SECRET-CONTENT",
        "thread_id": "SECRET-THREAD",
        "user_id": "SECRET-USER",
        "api_key": "sk-live-SECRET",
    }

    async def test_no_content_bearing_provider_field_is_copied_into_usage(self):
        emitted = await _run([
            _chunk_event(
                usage_metadata=_usage(input_tokens=3, output_tokens=4, **self.SECRETS),
                finish_reason="stop",
            ),
        ])

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        usage_json = finished.usage[0].model_dump_json()
        for key, value in self.SECRETS.items():
            self.assertNotIn(key, usage_json)
            if isinstance(value, str):
                self.assertNotIn(value, usage_json)
        self.assertEqual(
            _wire(finished)["usage"],
            [{"provider": "openai", "model": "gpt-4o", "inputTokens": 3, "outputTokens": 4}],
        )


class TestRunErrorUsage(unittest.IsolatedAsyncioTestCase):
    async def test_a_run_that_fails_after_a_model_call_reports_partial_usage(self):
        emitted = await _run([
            _chunk_event(usage_metadata=_usage(input_tokens=100, output_tokens=12),
                         finish_reason="stop"),
            _error_event("boom"),
        ])

        errored = _terminal(emitted, EventType.RUN_ERROR)
        self.assertEqual(errored.message, "boom")
        self.assertEqual(
            _wire(errored)["usage"],
            [{"provider": "openai", "model": "gpt-4o", "inputTokens": 100, "outputTokens": 12}],
        )

    async def test_a_run_that_fails_before_any_model_call_omits_usage(self):
        emitted = await _run([_error_event("boom")])

        errored = _terminal(emitted, EventType.RUN_ERROR)
        self.assertIsNone(errored.usage)
        self.assertNotIn("usage", _wire(errored))


class TestInterruptedRunUsage(unittest.IsolatedAsyncioTestCase):
    async def test_an_interrupted_run_reports_the_usage_it_already_spent(self):
        """An interrupt ends the run with RUN_FINISHED. The model calls made
        before the pause were paid for, so they are reported."""
        interrupt = MagicMock()
        interrupt.value = "approve?"
        interrupt.id = "int-1"

        emitted = await _run(
            [_chunk_event(usage_metadata=_usage(input_tokens=42), finish_reason="stop")],
            interrupts=[interrupt],
        )

        finished = _terminal(emitted, EventType.RUN_FINISHED)
        self.assertEqual([u.input_tokens for u in finished.usage], [42])


class TestUsageDoesNotLeakBetweenRuns(unittest.IsolatedAsyncioTestCase):
    async def test_a_second_run_on_the_same_agent_starts_from_nothing(self):
        agent = make_agent(emit_raw_events=False)

        first = await _drive(agent, [
            _chunk_event(usage_metadata=_usage(input_tokens=11), finish_reason="stop"),
        ])
        self.assertEqual(
            [u.input_tokens for u in _terminal(first, EventType.RUN_FINISHED).usage],
            [11],
        )

        second = await _drive(agent, [_chunk_event(finish_reason="stop")])
        self.assertIsNone(
            _terminal(second, EventType.RUN_FINISHED).usage,
            "the first run's counts must not be re-reported by the second",
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

"""Provider-reported token usage on this bridge's terminal events.

``RUN_FINISHED.usage`` and ``RUN_ERROR.usage`` are documented on the protocol
but were never populated here. These tests pin the behaviour: Strands reports
usage once per model invocation on its stream's ``metadata`` event, those
entries accumulate for the length of the run, and the terminal event carries
one entry per ``(provider, model)``.

Three rules carry most of the weight and are asserted from both directions:

* omit vs zero. A provider that reported nothing leaves ``usage`` absent, never
  present-with-zeros. "Not measured" and "measured zero" are different answers,
  and a consumer showing 0 tokens for an unreported run is wrong.
* numeric-only. ``TokenUsage`` feeds anonymous usage telemetry, so nothing
  content-bearing may be copied into it, whatever else the provider attaches
  next to its counts.
* never lose the run. A malformed count is dropped, because the alternative is
  a ValidationError raised while building the terminal event, which costs the
  caller the whole answer over a token count.

Most cases drive a REAL ``strands.Agent`` over a scripted ``Model``, so the
metadata channel itself is proven rather than assumed, and the real multi-agent
``Graph`` covers the orchestrator path. Every usage payload on that path is a
VALID Strands payload, for the reason spelled out on ``_metadata``. What a real
model cannot deliver goes through a scripted core, as ``test_interrupt.py``
does: the terminal shapes it cannot reach (an interrupt outcome, the
post-stream session gates) and the usage payloads that break Strands' own
required-key contract.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any, AsyncIterable, Optional
from unittest.mock import MagicMock

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage
from strands import Agent as StrandsAgentCore
from strands import tool
from strands.agent.state import AgentState
from strands.hooks.registry import HookRegistry
from strands.interrupt import Interrupt as StrandsInterrupt
from strands.models.model import Model

from ag_ui_strands.agent import (
    _MAX_TOKEN_COUNT,
    _STRANDS_PROVIDER_LABELS,
    StrandsAgent,
    _model_usage_labels,
)
from ag_ui_strands.config import StrandsAgentConfig

from tests.interrupt_state_stub import InterruptStateStub

# Every field a usage entry is allowed to carry. Anything outside this set on an
# emitted entry is a telemetry leak, whatever else the provider sent.
ALLOWED_USAGE_FIELDS = {
    "provider",
    "model",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "reasoning_tokens",
    "cached_input_tokens",
}


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


class ScriptedModel(Model):
    """Replays canned Bedrock-shaped stream turns, one turn per invocation.

    ``model_id`` is what ``get_config`` reports, so the model label the adapter
    reads comes from the same place a real provider's does.
    """

    def __init__(self, turns: list[list[dict]], model_id: str = "scripted-1") -> None:
        self._turns = list(turns)
        self._model_id = model_id
        self.calls = 0

    def update_config(self, **model_config: Any) -> None:  # pragma: no cover
        pass

    def get_config(self) -> Any:
        return {"model_id": self._model_id}

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


def _metadata(usage: Any = None, **extra: Any) -> dict:
    """The stream event Strands reports one of per model invocation.

    Every ``usage`` handed to a REAL model here carries ``inputTokens``,
    ``outputTokens`` and ``totalTokens``, however little the case under test
    needs them: Strands' own ``Usage`` declares all three ``Required``, and its
    accumulation and telemetry subscript them bare, so a payload missing one
    aborts the run inside the SDK on any version that does not happen to
    default them (1.15 does not, 1.18 does). Trimming a fixture back to the one
    count a test talks about therefore stops testing this bridge and starts
    testing which Strands is installed. A payload that cannot carry all three
    and still make its point goes through ``_ScriptedCore`` instead.
    """
    payload: dict = {"metrics": {"latencyMs": 12}, **extra}
    if usage is not None:
        payload["usage"] = usage
    return {"metadata": payload}


def _stream_event(usage: Any = None, **extra: Any) -> dict:
    """The metadata event as it reaches the adapter's stream loop.

    Strands forwards each provider chunk verbatim inside an ``event`` wrapper,
    ahead of its own accumulation, which is why the counts the adapter reads
    are the provider's own rather than the zero-seeded ``Usage`` the SDK
    derives for ``AgentResult.metrics``.
    """
    return {"event": _metadata(usage, **extra)}


def _turn(text: str = "Done.", usage: Any = None, **extra: Any) -> list[dict]:
    """One assistant text turn, optionally reporting usage as it closes."""
    events: list[dict] = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": text}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    if usage is not None or extra:
        events.append(_metadata(usage, **extra))
    return events


def _tool_turn(name: str, tool_use_id: str, usage: Any = None) -> list[dict]:
    """A turn that calls a tool, which makes Strands invoke the model again."""
    events: list[dict] = [
        {"messageStart": {"role": "assistant"}},
        {
            "contentBlockStart": {
                "start": {"toolUse": {"toolUseId": tool_use_id, "name": name}}
            }
        },
        {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]
    if usage is not None:
        events.append(_metadata(usage))
    return events


@tool
def lookup() -> str:
    """Look something up."""
    return "ok"


def _template() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _wrap(core: Any, config: StrandsAgentConfig | None = None) -> StrandsAgent:
    """An adapter whose per-thread agent is ``core``, template untouched."""
    adapter = StrandsAgent(
        _template(),
        name="usage-agent",
        config=config or StrandsAgentConfig(replay_history_into_strands=False),
    )
    adapter._agents_by_thread["t1"] = core
    return adapter


def _run_input(run_id: str = "r1") -> RunAgentInput:
    return RunAgentInput(
        thread_id="t1",
        run_id=run_id,
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _collect(adapter: StrandsAgent, run_id: str = "r1") -> list:
    return [event async for event in adapter.run(_run_input(run_id))]


def _terminal(events: list):
    """The run's single terminal event, whichever kind it is."""
    terminals = [
        event
        for event in events
        if event.type in (EventType.RUN_FINISHED, EventType.RUN_ERROR)
    ]
    assert len(terminals) == 1, [event.type for event in events]
    return terminals[0]


def _usage(events: list):
    return _terminal(events).usage


def _reported(entry) -> dict:
    """The fields an entry actually reports, unset ones excluded."""
    return entry.model_dump(exclude_none=True)


async def _run_scripted(turns: list[list[dict]], **model_kwargs) -> list:
    core = StrandsAgentCore(
        model=ScriptedModel(turns, **model_kwargs),
        tools=[lookup],
        callback_handler=None,
    )
    return await _collect(_wrap(core))


class _ScriptedCore:
    """The ``StrandsAgentCore`` surface the adapter reads, stream scripted.

    Used for what a scripted model cannot deliver: the terminal shapes a real
    model never reaches (a paused checkpoint, the post-stream
    mixed-checkpoint gates), and usage payloads that break Strands' OWN
    ``Usage`` contract, which its accumulation and telemetry reject before the
    adapter is reached. Those payloads still arrive off the wire in the wild,
    so the adapter's read of them is worth pinning, just not through a path
    that cannot carry them.
    """

    def __init__(
        self,
        events: list,
        *,
        interrupts=None,
        session_manager=None,
        model_id: str = "scripted-1",
    ):
        self.agent_id = "default"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.state = AgentState()
        self.model = ScriptedModel([], model_id=model_id)
        self.messages: list = []
        self.hooks = HookRegistry()
        self.session_manager = session_manager
        self._events = events
        self._interrupt_state = InterruptStateStub()
        for interrupt in interrupts or []:
            self._interrupt_state.interrupts[interrupt.id] = interrupt
        if interrupts:
            self._interrupt_state.activate()

    async def stream_async(self, prompt):
        for event in self._events:
            yield event


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------


class TestRunFinishedUsage:
    @pytest.mark.asyncio
    async def test_a_single_model_call_reports_its_usage(self):
        events = await _run_scripted(
            [
                _turn(
                    usage={
                        "inputTokens": 11,
                        "outputTokens": 7,
                        "totalTokens": 18,
                        "cacheReadInputTokens": 4,
                    }
                )
            ]
        )

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert [_reported(entry) for entry in _usage(events)] == [
            {
                "model": "scripted-1",
                "input_tokens": 11,
                "output_tokens": 7,
                "total_tokens": 18,
                "cached_input_tokens": 4,
            }
        ]

    @pytest.mark.asyncio
    async def test_repeated_calls_in_one_run_are_summed(self):
        """A tool cycle invokes the model twice, and both calls count."""
        events = await _run_scripted(
            [
                _tool_turn(
                    "lookup",
                    "tu-1",
                    usage={"inputTokens": 10, "outputTokens": 2, "totalTokens": 12},
                ),
                _turn(usage={"inputTokens": 20, "outputTokens": 3, "totalTokens": 23}),
            ]
        )

        assert [_reported(entry) for entry in _usage(events)] == [
            {
                "model": "scripted-1",
                "input_tokens": 30,
                "output_tokens": 5,
                "total_tokens": 35,
            }
        ]

    @pytest.mark.asyncio
    async def test_a_field_only_one_call_reports_is_summed_over_that_call(self):
        events = await _run_scripted(
            [
                _tool_turn(
                    "lookup",
                    "tu-1",
                    usage={
                        "inputTokens": 1,
                        "outputTokens": 1,
                        "totalTokens": 2,
                        "cacheReadInputTokens": 6,
                    },
                ),
                _turn(usage={"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}),
            ]
        )

        assert _usage(events)[0].cached_input_tokens == 6

    @pytest.mark.asyncio
    async def test_a_cache_write_count_is_dropped_not_folded_in(self):
        """AG-UI has no slot for it, and folding it in would overstate a count."""
        events = await _run_scripted(
            [
                _turn(
                    usage={
                        "inputTokens": 5,
                        "outputTokens": 5,
                        "totalTokens": 10,
                        "cacheReadInputTokens": 1,
                        "cacheWriteInputTokens": 99,
                    }
                )
            ]
        )

        entry = _usage(events)[0]
        assert entry.input_tokens == 5
        assert entry.cached_input_tokens == 1
        assert 99 not in _reported(entry).values()

    @pytest.mark.asyncio
    async def test_strands_reports_no_reasoning_tokens_so_the_field_stays_unset(self):
        events = await _run_scripted(
            [_turn(usage={"inputTokens": 5, "outputTokens": 5, "totalTokens": 10})]
        )

        assert _usage(events)[0].reasoning_tokens is None


# ---------------------------------------------------------------------------
# Omitted, never zeroed
# ---------------------------------------------------------------------------


class TestUsageIsOmittedNotZeroed:
    """A run nobody measured must not look like a run that cost nothing."""

    @pytest.mark.asyncio
    async def test_a_provider_that_reports_no_usage_omits_the_field(self):
        events = await _run_scripted([_turn()])

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events) is None

    @pytest.mark.asyncio
    async def test_a_metadata_event_with_no_usage_key_omits_the_field(self):
        """A metadata event may carry only latency, and that is not usage.

        Driven through a scripted core: Strands' own accumulation subscripts
        ``metadata["usage"]`` on the versions this package supports, so no
        real model path can hand the adapter a metadata event without it.
        """
        core = _ScriptedCore([_stream_event(None)])

        events = await _collect(_wrap(core))

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events) is None

    @pytest.mark.asyncio
    async def test_usage_with_no_usable_count_omits_the_field(self):
        """All three counts reported, none of them a number, so none survive.

        Driven through a scripted core because Strands accumulates its own
        run metrics by ``+=``-ing these values, which a string count breaks
        inside the SDK whichever keys are present. Numeric-but-unusable counts
        reach the guard over a real model and are covered there.
        """
        core = _ScriptedCore(
            [
                _stream_event(
                    {
                        "inputTokens": "lots",
                        "outputTokens": "a few",
                        "totalTokens": "some",
                    }
                )
            ]
        )

        events = await _collect(_wrap(core))

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events) is None

    @pytest.mark.asyncio
    async def test_a_labels_only_entry_is_never_emitted(self):
        """The model label alone is not usage, so nothing is reported.

        A usage object with no counts at all breaks Strands' required-key
        contract, so this one goes through a scripted core rather than a real
        model, which would abort the run inside the SDK before the adapter saw
        it.
        """
        core = _ScriptedCore([_stream_event({})], model_id="labelled-model")

        events = await _collect(_wrap(core))

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events) is None

    @pytest.mark.asyncio
    async def test_a_measured_zero_is_reported_as_zero(self):
        events = await _run_scripted(
            [_turn(usage={"inputTokens": 0, "outputTokens": 0, "totalTokens": 0})]
        )

        assert _reported(_usage(events)[0]) == {
            "model": "scripted-1",
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        }


# ---------------------------------------------------------------------------
# Malformed counts
# ---------------------------------------------------------------------------


class TestMalformedProviderCounts:
    """A bad count costs the count, never the run."""

    @pytest.mark.asyncio
    async def test_a_count_beyond_the_safe_wire_range_is_dropped(self):
        events = await _run_scripted(
            [
                _turn(
                    usage={
                        "inputTokens": _MAX_TOKEN_COUNT + 1,
                        "outputTokens": 7,
                        "totalTokens": 9,
                    }
                )
            ]
        )

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _reported(_usage(events)[0]) == {
            "model": "scripted-1",
            "output_tokens": 7,
            "total_tokens": 9,
        }

    @pytest.mark.asyncio
    async def test_the_largest_carriable_count_still_survives(self):
        """The bound is inclusive, so the ceiling itself is not dropped."""
        events = await _run_scripted(
            [
                _turn(
                    usage={
                        "inputTokens": _MAX_TOKEN_COUNT,
                        "outputTokens": 7,
                        "totalTokens": 9,
                    }
                )
            ]
        )

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events)[0].input_tokens == _MAX_TOKEN_COUNT

    @pytest.mark.asyncio
    async def test_an_integer_too_large_to_be_a_float_does_not_abort_the_run(self):
        """``math.isfinite`` raises OverflowError on this, so order matters.

        The other two counts are ordinary and complete, so what the run loses
        is one count and not the whole entry, and the payload stays valid by
        Strands' own required-key contract.
        """
        events = await _run_scripted(
            [
                _turn(
                    usage={
                        "inputTokens": 10**400,
                        "outputTokens": 3,
                        "totalTokens": 5,
                    }
                )
            ]
        )

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _reported(_usage(events)[0]) == {
            "model": "scripted-1",
            "output_tokens": 3,
            "total_tokens": 5,
        }

    @pytest.mark.asyncio
    async def test_every_other_malformed_shape_is_dropped_too(self):
        events = await _run_scripted(
            [
                _turn(
                    usage={
                        "inputTokens": float("nan"),
                        "outputTokens": float("inf"),
                        "totalTokens": -1,
                        "cacheReadInputTokens": 1.5,
                    }
                )
            ]
        )

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events) is None

    @pytest.mark.asyncio
    async def test_a_boolean_is_not_a_token_count(self):
        """``bool`` subclasses ``int``, and ``True`` is not one token."""
        events = await _run_scripted(
            [_turn(usage={"inputTokens": True, "outputTokens": 2, "totalTokens": 3})]
        )

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _reported(_usage(events)[0]) == {
            "model": "scripted-1",
            "output_tokens": 2,
            "total_tokens": 3,
        }

    @pytest.mark.asyncio
    async def test_a_wholly_malformed_payload_does_not_fail_the_run(self):
        """A payload that is not even a mapping is read as no usage at all.

        Driven through a scripted core because Strands' own
        ``extract_usage_metrics`` raises on a non-mapping ``usage`` before the
        adapter is reached, so the real-model path cannot deliver this shape.
        """
        core = _ScriptedCore([_stream_event("nope"), {"metadata": "nope"}])

        events = await _collect(_wrap(core))

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events) is None

    @pytest.mark.asyncio
    async def test_a_float_whole_number_is_accepted(self):
        events = await _run_scripted(
            [_turn(usage={"inputTokens": 4.0, "outputTokens": 1, "totalTokens": 5})]
        )

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events)[0].input_tokens == 4


# ---------------------------------------------------------------------------
# Nothing content-bearing rides along
# ---------------------------------------------------------------------------


class TestUsageCarriesNoContent:
    @pytest.mark.asyncio
    async def test_no_content_bearing_field_is_copied_into_usage(self):
        """``TokenUsage`` feeds anonymous telemetry. Counts and labels only."""
        events = await _run_scripted(
            [
                _turn(
                    usage={
                        "inputTokens": 3,
                        "outputTokens": 4,
                        "totalTokens": 7,
                        "prompt": "the user's secret question",
                        "completion": "the assistant's answer",
                        "requestId": "req-abc",
                    },
                    trace={"spans": [{"name": "the user's secret question"}]},
                )
            ]
        )

        entry = _usage(events)[0]
        reported = _reported(entry)
        assert set(reported) <= ALLOWED_USAGE_FIELDS
        assert "secret" not in repr(reported)
        assert "req-abc" not in repr(reported)


# ---------------------------------------------------------------------------
# Provider and model labels
# ---------------------------------------------------------------------------


class TestUsageLabels:
    def test_the_provider_label_is_keyed_on_the_model_class_name(self):
        stand_in = type(
            "BedrockModel", (), {"get_config": lambda self: {"model_id": "nova"}}
        )()

        assert _model_usage_labels(stand_in) == ("bedrock", "nova")

    def test_the_google_model_is_labelled_google_not_gemini(self):
        """The label is the vendor, so both bridges can report the same one.

        Python calls this class ``GeminiModel`` and the TypeScript SDK keeps
        its equivalent under ``models/google``. A label derived from either
        class name would split one vendor into two across the two bridges, so
        the canonical label is fixed here and matched there.
        """
        assert _STRANDS_PROVIDER_LABELS["GeminiModel"] == "google"

    def test_every_model_class_the_sdk_ships_has_a_canonical_label(self):
        """A provider Strands adds later must be labelled, not silently skipped.

        Read with ``ast`` rather than imported: most provider modules need an
        optional SDK that this package does not depend on, so importing them
        would make the test pass or fail on which extras happen to be present.
        """
        import strands.models

        package_dir = Path(strands.models.__file__).parent
        shipped = set()
        for path in sorted(package_dir.glob("*.py")):
            if path.name.startswith("_") or path.name == "model.py":
                continue
            for node in ast.parse(path.read_text()).body:
                if not isinstance(node, ast.ClassDef):
                    continue
                bases = {
                    base.id if isinstance(base, ast.Name) else getattr(base, "attr", "")
                    for base in node.bases
                }
                if any(base.endswith("Model") for base in bases):
                    shipped.add(node.name)

        assert shipped
        assert shipped <= set(_STRANDS_PROVIDER_LABELS)

    def test_the_labels_are_lowercase_and_one_vendor_gets_one_label(self):
        """Two classes may share a label; one vendor may not have two.

        A repeated label is only ever right when the classes really are one
        vendor's two APIs, which today is OpenAI's Chat Completions and
        Responses classes. Any other repetition is a vendor spelled twice, so
        the exception is enumerated here rather than waved through.
        """
        labels = list(_STRANDS_PROVIDER_LABELS.values())
        assert labels == [label.lower() for label in labels]
        assert {label for label in labels if labels.count(label) > 1} == {"openai"}

    @pytest.mark.asyncio
    async def test_an_unrecognised_model_class_omits_the_provider_label(self):
        """``ScriptedModel`` is nobody's provider, so no provider is claimed."""
        events = await _run_scripted(
            [_turn(usage={"inputTokens": 1, "outputTokens": 1, "totalTokens": 2})]
        )

        entry = _usage(events)[0]
        assert entry.provider is None
        assert entry.model == "scripted-1"

    @pytest.mark.asyncio
    async def test_a_model_whose_get_config_raises_still_reports_its_counts(self):
        class _HostileModel(ScriptedModel):
            def get_config(self):
                raise RuntimeError("no config for you")

        core = StrandsAgentCore(
            model=_HostileModel(
                [_turn(usage={"inputTokens": 8, "outputTokens": 2, "totalTokens": 10})]
            ),
            callback_handler=None,
        )
        events = await _collect(_wrap(core))

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _reported(_usage(events)[0]) == {
            "input_tokens": 8,
            "output_tokens": 2,
            "total_tokens": 10,
        }

    @pytest.mark.asyncio
    async def test_a_config_without_a_model_id_omits_the_model_label(self):
        class _UnlabelledModel(ScriptedModel):
            def get_config(self):
                return {"params": {"temperature": 0}}

        core = StrandsAgentCore(
            model=_UnlabelledModel(
                [_turn(usage={"inputTokens": 8, "outputTokens": 2, "totalTokens": 10})]
            ),
            callback_handler=None,
        )
        events = await _collect(_wrap(core))

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _reported(_usage(events)[0]) == {
            "input_tokens": 8,
            "output_tokens": 2,
            "total_tokens": 10,
        }


# ---------------------------------------------------------------------------
# Terminal events other than a plain success
# ---------------------------------------------------------------------------


class TestRunErrorUsage:
    @pytest.mark.asyncio
    async def test_a_run_that_fails_after_a_model_call_reports_partial_usage(self):
        """The failed cycle's predecessors were still paid for."""

        class _FailsAfterFirstCall(ScriptedModel):
            async def stream(self, messages, tool_specs=None, system_prompt=None, **kw):
                if self.calls == 0:
                    async for event in super().stream(messages, tool_specs, **kw):
                        yield event
                    return
                self.calls += 1
                raise RuntimeError("provider exploded")
                yield  # pragma: no cover

        core = StrandsAgentCore(
            model=_FailsAfterFirstCall(
                [
                    _tool_turn(
                        "lookup",
                        "tu-1",
                        usage={"inputTokens": 9, "outputTokens": 1, "totalTokens": 10},
                    )
                ]
            ),
            tools=[lookup],
            callback_handler=None,
        )
        events = await _collect(_wrap(core))

        terminal = _terminal(events)
        assert terminal.type == EventType.RUN_ERROR
        assert [_reported(entry) for entry in terminal.usage] == [
            {
                "model": "scripted-1",
                "input_tokens": 9,
                "output_tokens": 1,
                "total_tokens": 10,
            }
        ]

    @pytest.mark.asyncio
    async def test_a_run_that_fails_before_any_model_call_omits_usage(self):
        """An early-exit validation error has no usage to carry, and claims none."""
        adapter = StrandsAgent(
            _template(),
            name="usage-agent",
            config=StrandsAgentConfig(replay_history_into_strands=False),
        )
        core = _ScriptedCore(
            [],
            interrupts=[StrandsInterrupt(id="native-1", name="confirm")],
        )
        adapter._agents_by_thread["t1"] = core

        events = await _collect(adapter)

        terminal = _terminal(events)
        assert terminal.type == EventType.RUN_ERROR
        assert terminal.code == "PENDING_INTERRUPTS"
        assert terminal.usage is None

    @pytest.mark.asyncio
    async def test_a_forced_stop_after_a_model_call_reports_partial_usage(self):
        core = _ScriptedCore(
            [
                _stream_event({"inputTokens": 2, "outputTokens": 2, "totalTokens": 4}),
                {"force_stop": True, "force_stop_reason": "provider gave up"},
            ]
        )

        events = await _collect(_wrap(core))

        terminal = _terminal(events)
        assert terminal.type == EventType.RUN_ERROR
        assert terminal.code == "STRANDS_FORCE_STOP"
        assert _reported(terminal.usage[0]) == {
            "model": "scripted-1",
            "input_tokens": 2,
            "output_tokens": 2,
            "total_tokens": 4,
        }


class TestInterruptedRunUsage:
    @pytest.mark.asyncio
    async def test_an_interrupted_run_reports_the_usage_it_already_spent(self):
        """An interrupted run is a finished run: those calls really happened."""
        core = _ScriptedCore(
            [_stream_event({"inputTokens": 6, "outputTokens": 2, "totalTokens": 8})],
            interrupts=[StrandsInterrupt(id="native-1", name="confirm")],
            session_manager=MagicMock(),
        )
        # An activated checkpoint would refuse a fresh turn, so the pause is
        # created by the stream rather than pre-existing it.
        core._interrupt_state = InterruptStateStub()

        async def _stream(prompt):
            for event in core._events:
                yield event
            interrupt = StrandsInterrupt(id="native-1", name="confirm")
            core._interrupt_state.interrupts[interrupt.id] = interrupt
            core._interrupt_state.activate()

        core.stream_async = _stream

        events = await _collect(_wrap(core))

        terminal = _terminal(events)
        assert terminal.type == EventType.RUN_FINISHED
        assert terminal.outcome.type == "interrupt"
        assert _reported(terminal.usage[0]) == {
            "model": "scripted-1",
            "input_tokens": 6,
            "output_tokens": 2,
            "total_tokens": 8,
        }


# ---------------------------------------------------------------------------
# The multi-agent orchestrator path
# ---------------------------------------------------------------------------


def _graph(*nodes: tuple[str, str]):
    """A linear Graph of one scripted agent per ``(node_id, model_id)``."""
    from strands.multiagent import GraphBuilder

    builder = GraphBuilder()
    previous = None
    for node_id, model_id in nodes:
        builder.add_node(
            StrandsAgentCore(
                model=ScriptedModel(
                    [
                        _turn(
                            f"{node_id} done.",
                            usage={
                                "inputTokens": 5,
                                "outputTokens": 2,
                                "totalTokens": 7,
                            },
                        )
                    ],
                    model_id=model_id,
                ),
                name=node_id,
                callback_handler=None,
            ),
            node_id,
        )
        if previous is not None:
            builder.add_edge(previous, node_id)
        previous = node_id
    builder.set_entry_point(nodes[0][0])
    return builder.build()


async def _run_orchestrator(orchestrator) -> list:
    adapter = StrandsAgent(orchestrator, name="usage-graph")
    return await _collect(adapter)


class TestOrchestratorUsage:
    """A Graph's nodes report on the same metadata channel, one wrapper deeper.

    Node identity IS available where the usage arrives (the node-stream wrapper
    carries ``node_id``, and both Graph and Swarm key ``nodes`` by it), so each
    entry is labelled with the model of the node that spent the tokens.
    """

    @pytest.mark.asyncio
    async def test_a_graph_reports_each_node_under_its_own_model(self):
        events = await _run_orchestrator(
            _graph(("researcher", "model-a"), ("writer", "model-b"))
        )

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert [_reported(entry) for entry in _usage(events)] == [
            {
                "model": "model-a",
                "input_tokens": 5,
                "output_tokens": 2,
                "total_tokens": 7,
            },
            {
                "model": "model-b",
                "input_tokens": 5,
                "output_tokens": 2,
                "total_tokens": 7,
            },
        ]

    @pytest.mark.asyncio
    async def test_two_nodes_on_one_model_are_summed_into_one_entry(self):
        events = await _run_orchestrator(
            _graph(("researcher", "shared"), ("writer", "shared"))
        )

        assert [_reported(entry) for entry in _usage(events)] == [
            {
                "model": "shared",
                "input_tokens": 10,
                "output_tokens": 4,
                "total_tokens": 14,
            }
        ]

    @pytest.mark.asyncio
    async def test_a_graph_that_reports_nothing_omits_the_field(self):
        from strands.multiagent import GraphBuilder

        builder = GraphBuilder()
        builder.add_node(
            StrandsAgentCore(
                model=ScriptedModel([_turn("quiet.")]),
                name="quiet",
                callback_handler=None,
            ),
            "quiet",
        )
        builder.set_entry_point("quiet")

        events = await _run_orchestrator(builder.build())

        assert _terminal(events).type == EventType.RUN_FINISHED
        assert _usage(events) is None

    @pytest.mark.asyncio
    async def test_a_graph_that_fails_mid_run_reports_partial_usage(self):
        graph = _graph(("researcher", "model-a"), ("writer", "model-b"))
        original = graph.stream_async

        async def _fails_after_the_first_node(task, **kwargs):
            async for event in original(task, **kwargs):
                yield event
                if event.get("type") == "multiagent_node_stop":
                    raise RuntimeError("graph exploded")

        graph.stream_async = _fails_after_the_first_node
        adapter = StrandsAgent(graph, name="usage-graph")
        events = await _collect(adapter)

        terminal = _terminal(events)
        assert terminal.type == EventType.RUN_ERROR
        assert [_reported(entry) for entry in terminal.usage] == [
            {
                "model": "model-a",
                "input_tokens": 5,
                "output_tokens": 2,
                "total_tokens": 7,
            }
        ]


# ---------------------------------------------------------------------------
# Per-run scoping
# ---------------------------------------------------------------------------


class TestUsageDoesNotLeakBetweenRuns:
    @pytest.mark.asyncio
    async def test_a_second_run_on_the_same_agent_starts_from_nothing(self):
        core = StrandsAgentCore(
            model=ScriptedModel(
                [_turn(usage={"inputTokens": 4, "outputTokens": 1, "totalTokens": 5})]
            ),
            callback_handler=None,
        )
        adapter = _wrap(core)

        first = await _collect(adapter, run_id="r1")
        second = await _collect(adapter, run_id="r2")

        expected = [
            {
                "model": "scripted-1",
                "input_tokens": 4,
                "output_tokens": 1,
                "total_tokens": 5,
            }
        ]
        assert [_reported(entry) for entry in _usage(first)] == expected
        assert [_reported(entry) for entry in _usage(second)] == expected

    @pytest.mark.asyncio
    async def test_a_second_orchestrator_run_starts_from_nothing(self):
        adapter = StrandsAgent(
            lambda: _graph(("researcher", "model-a")), name="usage-graph"
        )

        first = await _collect(adapter, run_id="r1")
        second = await _collect(adapter, run_id="r2")

        expected = [
            {
                "model": "model-a",
                "input_tokens": 5,
                "output_tokens": 2,
                "total_tokens": 7,
            }
        ]
        assert [_reported(entry) for entry in _usage(first)] == expected
        assert [_reported(entry) for entry in _usage(second)] == expected


# ---------------------------------------------------------------------------
# The boundary of what is counted
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_agent_as_tool_sub_agents_own_calls_are_not_counted():
    """Pins the current boundary, which both bridges share.

    A generator tool that wraps another ``Agent`` re-yields the inner agent's
    whole stream as ``tool_stream_event`` payloads, which the parent loop routes
    to the inner tool-call forwarder and never through the metadata branch. So
    a sub-agent's own model calls are absent from the parent run's usage.

    Widening this would have to happen in both bridges at once, or the same run
    would report different totals depending on which one served it.
    """

    @tool
    def weather(city: str) -> str:
        """Look up the weather."""
        return f"sunny in {city}"

    inner = StrandsAgentCore(
        model=ScriptedModel(
            [
                _turn(
                    "Paris is sunny.",
                    usage={
                        "inputTokens": 100,
                        "outputTokens": 50,
                        "totalTokens": 150,
                    },
                )
            ],
            model_id="inner-model",
        ),
        tools=[weather],
        callback_handler=None,
    )

    @tool
    async def research(query: str):
        """Delegate research to a sub-agent."""
        async for event in inner.stream_async(query):
            yield event

    parent = StrandsAgentCore(
        model=ScriptedModel(
            [
                _tool_turn(
                    "research",
                    "tu-parent",
                    usage={"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                ),
                _turn(usage={"inputTokens": 2, "outputTokens": 2, "totalTokens": 4}),
            ],
            model_id="outer-model",
        ),
        tools=[research],
        callback_handler=None,
    )

    events = await _collect(_wrap(parent))

    assert [_reported(entry) for entry in _usage(events)] == [
        {
            "model": "outer-model",
            "input_tokens": 3,
            "output_tokens": 3,
            "total_tokens": 6,
        }
    ]


# ---------------------------------------------------------------------------
# The usage is still forwarded as RAW
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_metadata_event_is_still_forwarded_as_raw():
    """Reading usage off this channel must not consume the event."""
    events = await _run_scripted(
        [_turn(usage={"inputTokens": 1, "outputTokens": 1, "totalTokens": 2})]
    )

    raws = [event for event in events if event.type == EventType.RAW]
    assert any("metadata" in (event.event or {}).get("event", {}) for event in raws)

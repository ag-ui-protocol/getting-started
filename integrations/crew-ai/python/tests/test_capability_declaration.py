"""Capability declaration and RAW-passthrough configuration: ``get_capabilities()``,
the provider-agnostic reasoning capability + native-Gemini LLM resolution, and the
"explicit argument > env var > default" resolution behind ``emit_raw_events``.
No network."""

import dataclasses

import pytest
from fastapi import FastAPI

from ag_ui_crewai import get_capabilities
from ag_ui_crewai import _capabilities as caps_mod
from ag_ui_crewai import _config as config_mod
from ag_ui_crewai import endpoint as ep


# -- shape of the declaration ----------------------------------------------

@pytest.fixture(autouse=True)
def _clean_protocol_env(monkeypatch):
    """Clear the RAW env var: otherwise an exported AGUI_CREWAI_EMIT_RAW_EVENTS makes
    these tests assert the ambient environment rather than the shipped defaults."""
    monkeypatch.delenv(config_mod.EMIT_RAW_EVENTS_ENV_VAR, raising=False)


def test_get_capabilities_gates_raw_events_on_the_streamframe_transport(monkeypatch):
    """RAW passthrough needs the scoped stream sink, so ``supported`` / ``enabled``
    track the StreamFrame transport rather than the flag alone."""
    if caps_mod.LLMThinkingChunkEvent is None:  # pragma: no cover
        # Skipped up front: a mid-test skip would silently void the rawEvents
        # assertions that precede it.
        pytest.skip("installed crewai does not expose LLMThinkingChunkEvent")
    def _set_stream_frames(available):
        # ``CAPABILITIES`` is a frozen dataclass, so swap the whole cached probe
        # result rather than mutating a field.
        monkeypatch.setattr(caps_mod, "_stream_frame_available", available)
        monkeypatch.setattr(
            caps_mod,
            "CAPABILITIES",
            dataclasses.replace(
                caps_mod.CAPABILITIES, stream_frame_available=available
            ),
        )

    # Available transport: the flag decides.
    _set_stream_frames(True)
    on = get_capabilities(emit_raw_events=True)
    assert on["transport"]["streamFrames"] is True
    assert on["rawEvents"]["supported"] is True
    assert on["rawEvents"]["enabled"] is True
    assert get_capabilities(emit_raw_events=False)["rawEvents"]["enabled"] is False

    # Unavailable transport: the flag cannot turn RAW on. Reasoning is now a
    # first-class channel (litellm), independent of RAW / StreamFrame, so it
    # stays supported here.
    _set_stream_frames(False)
    off = get_capabilities(llm=_FakeNativeGemini(), emit_raw_events=True)
    assert off["transport"]["streamFrames"] is False
    assert off["rawEvents"]["supported"] is False
    assert off["rawEvents"]["enabled"] is False
    assert off["reasoning"]["supported"] is True
    assert off["reasoning"]["requiresEmitRawEvents"] is False


# -- reasoning: provider-agnostic, first-class ------------------------------

class _FakeNativeGemini:
    """Structural stand-in for ``crewai.llms.providers.gemini.completion``:
    ``provider == "gemini"`` plus the gemini-only ``thinking_config`` field."""

    provider = "gemini"
    thinking_config = None


class _FakeOpenAI:
    provider = "openai"


class _FakeLiteLLMGemini:
    """A LiteLLM-routed gemini model: carries the provider string but none of
    the native thinking plumbing (so it never emits thinking chunks)."""

    provider = "gemini"
    model = "gemini/gemini-1.0-unlisted"


def test_reasoning_supported_without_an_llm_and_provider_agnostic():
    """Reasoning is a first-class, provider-agnostic bridge capability (the
    litellm reasoning_content / thinking_blocks channel), NOT gated on a
    native-Gemini LLM or the RAW transport. It is reported supported even with no
    LLM to resolve. ``thinkingEventAvailable`` reports the extra native source."""
    reasoning = get_capabilities()["reasoning"]

    assert reasoning["supported"] is True
    assert reasoning["requiresEmitRawEvents"] is False
    assert reasoning["litellmChannel"] is True
    assert reasoning["nativeGeminiProvider"] is False
    assert reasoning["thinkingEventAvailable"] is (
        caps_mod.LLMThinkingChunkEvent is not None
    )


def test_reasoning_supported_across_providers():
    """Provider-agnostic: native Gemini, OpenAI, and LiteLLM-routed models are all
    reported supported (the litellm channel carries reasoning for any
    reasoning-capable model). The native-Gemini fields are informational only."""
    gemini = get_capabilities(llm=_FakeNativeGemini())["reasoning"]
    assert gemini["supported"] is True
    assert gemini["nativeGeminiProvider"] is True
    assert gemini["resolvedProvider"] == "gemini"

    openai = get_capabilities(llm=_FakeOpenAI())["reasoning"]
    assert openai["supported"] is True
    assert openai["nativeGeminiProvider"] is False
    assert openai["resolvedProvider"] == "openai"

    litellm_routed = get_capabilities(llm=_FakeLiteLLMGemini())["reasoning"]
    assert litellm_routed["supported"] is True
    assert litellm_routed["nativeGeminiProvider"] is False


def test_reasoning_still_supported_via_litellm_when_thinking_event_absent(monkeypatch):
    """On a crewai without ``LLMThinkingChunkEvent`` reasoning is STILL supported
    through the litellm channel; only the extra native Gemini source is gone. The
    ``reasoning_available`` flag keys off the litellm channel too, so patch both."""
    monkeypatch.setattr(caps_mod, "_thinking_event_available", False)
    monkeypatch.setattr(
        caps_mod,
        "CAPABILITIES",
        dataclasses.replace(caps_mod.CAPABILITIES, reasoning_available=True),
    )
    reasoning = caps_mod._reasoning_capability(_FakeNativeGemini())
    assert reasoning["supported"] is True
    assert reasoning["thinkingEventAvailable"] is False
    assert reasoning["reason"] is None


def test_reasoning_resolves_the_llm_through_agent_and_crew_wrappers():
    """Callers pass what they have - an Agent, a Crew, a Flow - so the probe
    unwraps the conventional LLM-carrying attributes."""
    class _Agent:
        llm = _FakeNativeGemini()

    class _Crew:
        chat_llm = _FakeNativeGemini()

    class _Flow:
        llm = _Agent()

    class _NoLLM:
        pass

    assert caps_mod._resolve_llm(_Agent()) is _Agent.llm
    assert caps_mod._resolve_llm(_Crew()) is _Crew.chat_llm
    assert caps_mod._is_native_gemini(caps_mod._resolve_llm(_Flow())) is True
    assert caps_mod._resolve_llm(_NoLLM()) is None
    assert caps_mod._resolve_llm(None) is None


def test_native_gemini_probe_needs_both_signals():
    """Provider string alone (LiteLLM fallback) and ``thinking_config`` alone (a
    hypothetical future provider) are each insufficient."""
    class _ThinkingConfigOnly:
        provider = "anthropic"
        thinking_config = None

    assert caps_mod._is_native_gemini(_FakeLiteLLMGemini()) is False
    assert caps_mod._is_native_gemini(_ThinkingConfigOnly()) is False
    assert caps_mod._is_native_gemini(_FakeNativeGemini()) is True
    assert caps_mod._is_native_gemini(None) is False


def test_thinking_chunk_event_resolves_from_the_installed_crewai():
    """Sanity-check the resolution itself (never version-gated): on crewai 1.x
    the class lives at ``crewai.events.types.llm_events``."""
    if caps_mod.LLMThinkingChunkEvent is None:  # pragma: no cover
        pytest.skip("installed crewai does not expose LLMThinkingChunkEvent")
    assert caps_mod.LLMThinkingChunkEvent.__name__ == "LLMThinkingChunkEvent"


# -- configuration resolution ----------------------------------------------

def test_emit_raw_events_defaults_off_and_needs_an_explicit_truthy_value(monkeypatch):
    monkeypatch.delenv(config_mod.EMIT_RAW_EVENTS_ENV_VAR, raising=False)
    assert config_mod.resolve_emit_raw_events(None) is False

    for value in ("1", "true", "TRUE", "yes", "on", " On "):
        monkeypatch.setenv(config_mod.EMIT_RAW_EVENTS_ENV_VAR, value)
        assert config_mod.resolve_emit_raw_events(None) is True, value

    for value in ("0", "false", "no", "off", "", "maybe"):
        monkeypatch.setenv(config_mod.EMIT_RAW_EVENTS_ENV_VAR, value)
        assert config_mod.resolve_emit_raw_events(None) is False, value

    # An explicit argument wins over the env var either way.
    monkeypatch.setenv(config_mod.EMIT_RAW_EVENTS_ENV_VAR, "1")
    assert config_mod.resolve_emit_raw_events(False) is False


def test_reasoning_resolves_an_llm_off_a_crews_agents():
    """A Crew keeps its LLMs on .agents; chat_llm / manager_llm are None there, so
    resolution has to walk the agents or the documented "pass a Crew" case lies."""
    class _Agent:
        llm = _FakeNativeGemini()

    class _Crew:
        agents = [_Agent()]
        chat_llm = None
        manager_llm = None

    assert caps_mod._is_native_gemini(caps_mod._resolve_llm(_Crew())) is True


def test_llm_resolution_never_calls_a_factory_or_raising_property():
    """Capability probing walks caller objects: it must not execute a @CrewBase
    crew() factory or let a raising property escape as an error."""
    class _Raising:
        @property
        def llm(self):
            raise RuntimeError("should not escape")

    calls = []

    class _WithFactory:
        def crew(self):
            calls.append(1)
            return _FakeNativeGemini()

    assert caps_mod._resolve_llm(_Raising()) is None
    assert caps_mod._resolve_llm(_WithFactory()) is None
    assert calls == []


def test_llm_resolution_terminates_on_a_cycle():
    class _Cycle:
        pass

    node = _Cycle()
    node.llm = node
    assert caps_mod._resolve_llm(node) is None


def test_reasoning_supported_regardless_of_llm_resolution():
    """Reasoning no longer hinges on resolving an LLM (it is provider-agnostic via
    the litellm channel), so passing nothing, or an object with no LLM inside it,
    both still report supported. LLM resolution only feeds the informational
    ``resolvedProvider`` field, which stays None when nothing resolves."""
    class _NoLLMAnywhere:
        pass

    for caps in (get_capabilities(), get_capabilities(llm=_NoLLMAnywhere())):
        assert caps["reasoning"]["supported"] is True
        assert caps["reasoning"]["reason"] is None
        assert caps["reasoning"]["resolvedProvider"] is None


def test_native_gemini_is_recognised_under_both_provider_stamps():
    """crewai stamps "gemini" for gemini/... models and "google" for google/...;
    both build a real GeminiCompletion, so both must count as native."""
    class _GoogleStamped:
        provider = "google"
        thinking_config = None

    assert caps_mod._is_native_gemini(_GoogleStamped()) is True
    assert caps_mod._is_native_gemini(_FakeNativeGemini()) is True


def test_mixed_crew_prefers_the_native_gemini_agent():
    """A crew whose first agent is OpenAI and whose second is native Gemini DOES
    have a reasoning-capable LLM; first-match resolution reported otherwise."""
    class _OpenAIAgent:
        llm = _FakeLiteLLMGemini()

    class _GeminiAgent:
        llm = _FakeNativeGemini()

    class _MixedCrew:
        agents = [_OpenAIAgent(), _GeminiAgent()]

    assert caps_mod._is_native_gemini(caps_mod._resolve_llm(_MixedCrew())) is True


def test_llm_resolution_searches_every_branch_for_native_gemini():
    """Returning the first agent's LLM meant a crew whose agents are OpenAI but whose
    chat_llm is native Gemini reported provider_not_native_gemini."""
    class _OpenAIAgent:
        llm = _FakeLiteLLMGemini()

    class _CrewWithGeminiChatLLM:
        agents = [_OpenAIAgent(), _OpenAIAgent()]
        chat_llm = _FakeNativeGemini()

    resolved = caps_mod._resolve_llm(_CrewWithGeminiChatLLM())
    assert caps_mod._is_native_gemini(resolved) is True


def test_llm_resolution_is_not_order_dependent_across_branches():
    """A shared visited set was never unwound, so a node reached first down a
    dead-end branch stayed poisoned and an LLM genuinely reachable elsewhere resolved
    to None. The ancestor-path guard cuts only real cycles."""
    shared_dead_end = object()

    class _Branchy:
        # Same object on two branches: the first branch finds no LLM below it, the
        # second reaches one THROUGH it.
        def __init__(self):
            self.agents = [shared_dead_end]
            self.llm = _FakeNativeGemini()

    assert caps_mod._is_native_gemini(caps_mod._resolve_llm(_Branchy())) is True

    # A genuine ancestor cycle still terminates.
    class _Cycle:
        pass

    a, b = _Cycle(), _Cycle()
    a.llm, b.llm = b, a
    assert caps_mod._resolve_llm(a) is None

def test_raw_passthrough_resolution_rejects_a_non_bool_argument():
    """Config plumbing commonly yields the STRING "false", which is truthy. Silently
    enabling RAW passthrough would widen what leaves the process (prompt and
    completion text), so a non-bool fails at registration instead."""
    for bad in ("false", "true", 1, 0, object()):
        with pytest.raises(ValueError):
            config_mod.resolve_emit_raw_events(bad)

    assert config_mod.resolve_emit_raw_events(True) is True
    assert config_mod.resolve_emit_raw_events(False) is False
    assert config_mod.resolve_emit_raw_events(None) is config_mod.DEFAULT_EMIT_RAW_EVENTS


def test_raw_env_var_is_honoured_and_typos_are_reported(monkeypatch, caplog):
    """Falling back on a typo is right; falling back SILENTLY made the typo
    undiagnosable, because the operator sees default behaviour and no explanation."""
    import logging

    monkeypatch.setenv(config_mod.EMIT_RAW_EVENTS_ENV_VAR, "ON")
    assert config_mod.resolve_emit_raw_events(None) is True

    monkeypatch.setenv(config_mod.EMIT_RAW_EVENTS_ENV_VAR, "yes-please")
    monkeypatch.setattr(config_mod, "_ENV_WARN_SEEN", set())
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._config"):
        assert config_mod.resolve_emit_raw_events(None) is False
    assert any("yes-please" in r.getMessage() for r in caplog.records), caplog.text

    # An explicitly EMPTY value is documented as "unset", so it is not a typo.
    monkeypatch.setenv(config_mod.EMIT_RAW_EVENTS_ENV_VAR, "")
    monkeypatch.setattr(config_mod, "_ENV_WARN_SEEN", set())
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="ag_ui_crewai._config"):
        assert config_mod.resolve_emit_raw_events(None) is False
    assert not caplog.records, caplog.text


def test_endpoint_factories_reject_a_bad_raw_flag_at_registration():
    """Resolved once at registration, so a mistake in code fails at startup rather
    than on every request."""
    class _Flow:
        def kickoff_async(self, inputs=None):  # pragma: no cover - never called
            raise AssertionError

    with pytest.raises(ValueError):
        ep.add_crewai_flow_fastapi_endpoint(
            FastAPI(), _Flow(), "/flow", emit_raw_events="false"
        )

"""Provider wiring in the shared examples model factory.

The factory is the only place that asks a provider for reasoning content, and
the dojo e2e suite always drives the OpenAI branch against a mock server, so
deleting a provider's reasoning config leaves every other check green. These
tests close that hole.

No network and no provider SDK: each ``strands.models.*`` module is replaced
with a recorder that captures the kwargs the factory passed, which is exactly
the layer where a dropped config block would show up.
"""
import importlib.util
import sys
import types
from pathlib import Path

import pytest

_FACTORY_PATH = (
    Path(__file__).parent.parent / "examples" / "server" / "model_factory.py"
)

# Load by path rather than by import: ``server/__init__.py`` builds every demo
# app, which needs dependencies the adapter package itself does not ship.
_PROVIDER_MODULES = (
    ("strands.models.openai", "OpenAIModel"),
    ("strands.models.openai_responses", "OpenAIResponsesModel"),
    ("strands.models.anthropic", "AnthropicModel"),
    ("strands.models.gemini", "GeminiModel"),
)


class _Recorder:
    """Stands in for a provider model class and remembers its kwargs."""

    def __init__(self) -> None:
        self.kwargs: dict | None = None

    def __call__(self, **kwargs):
        self.kwargs = kwargs
        return self


@pytest.fixture
def providers(monkeypatch):
    recorders = {}
    for module_name, class_name in _PROVIDER_MODULES:
        recorder = _Recorder()
        stub = types.ModuleType(module_name)
        setattr(stub, class_name, recorder)
        monkeypatch.setitem(sys.modules, module_name, stub)
        recorders[class_name] = recorder
    return recorders


@pytest.fixture
def create_model(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    spec = importlib.util.spec_from_file_location(
        "examples_model_factory", _FACTORY_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.create_model


def test_anthropic_omits_thinking_by_default(providers, create_model, monkeypatch):
    monkeypatch.setenv("MODEL_PROVIDER", "anthropic")

    create_model()

    assert providers["AnthropicModel"].kwargs["params"] == {}


def test_anthropic_requests_extended_thinking_when_reasoning(
    providers, create_model, monkeypatch
):
    monkeypatch.setenv("MODEL_PROVIDER", "anthropic")

    create_model(reasoning=True)

    assert providers["AnthropicModel"].kwargs["params"] == {
        "thinking": {"type": "enabled", "budget_tokens": 2000}
    }


def test_openai_responses_omits_reasoning_by_default(
    providers, create_model, monkeypatch
):
    monkeypatch.setenv("MODEL_PROVIDER", "openai")

    create_model(openai_api="responses")

    assert providers["OpenAIResponsesModel"].kwargs["params"] == {}


def test_openai_responses_requests_reasoning_summaries_when_reasoning(
    providers, create_model, monkeypatch
):
    monkeypatch.setenv("MODEL_PROVIDER", "openai")

    create_model(openai_api="responses", reasoning=True)

    assert providers["OpenAIResponsesModel"].kwargs["params"] == {
        "reasoning": {"effort": "medium", "summary": "auto"}
    }


def test_openai_chat_never_requests_reasoning(providers, create_model, monkeypatch):
    """Chat Completions surfaces no reasoning, and the A2UI demos depend on it
    for incremental tool-call argument streaming."""
    monkeypatch.setenv("MODEL_PROVIDER", "openai")

    create_model(reasoning=True)

    assert "params" not in providers["OpenAIModel"].kwargs
    assert providers["OpenAIResponsesModel"].kwargs is None

"""Bind a native Strands history with the real provider formatters.

The bridge never sees the provider request: it hands Strands a native history and
Strands' model provider turns that into whatever the provider's API wants. Two
rules live in that translation, and the bridge has to satisfy both because it
does not know which provider the host configured.

- The splitting formatters (``openai``, ``litellm``, ``mistral``, ``writer``,
  ``llamaapi``, ``llamacpp``) turn one native user turn into several provider
  messages. The turn's non-tool content becomes a message of its own, emitted
  AHEAD of the tool messages the same turn's tool results become, whatever the
  order of the blocks inside the turn. A turn carrying both text and a tool
  result therefore binds as ``assistant(tool_calls) -> user(text) ->
  tool(result)``, and OpenAI answers that with HTTP 400 "An assistant message
  with 'tool_calls' must be followed by tool messages responding to each
  'tool_call_id'".
- The one-to-one formatters (``anthropic``, ``bedrock``, ``gemini``) map each
  native message to one provider message, so two consecutive user turns bind as
  two consecutive user messages, which those providers reject.

Every formatter here is the real one the SDK ships, reached through the model
class the host would use. Only the transport is missing: none of these calls
opens a connection, and the credentials are placeholders the constructors need
and never send. ``bedrock`` and ``llamacpp`` need no provider SDK beyond what
``strands-agents`` already installs, so both families are covered even in a bare
environment; ``openai`` is in the dev group because it is the provider whose 400
this is about. The rest run wherever their SDK happens to be installed and are
skipped where it is not, rather than being asserted against a reimplementation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, List

import pytest

#: Formatters that split one user turn into several provider messages.
SPLITTING = "splitting"

#: Formatters that map each native message to exactly one provider message.
ONE_TO_ONE = "one-to-one"


@dataclass(frozen=True)
class ProviderFormatter:
    """One shipped formatter, and how to reach it without a network call."""

    name: str
    family: str
    bind: Callable[[List[dict]], List[str]]

    def __str__(self) -> str:  # pragma: no cover - pytest id only
        return self.name


def _openai(messages: List[dict]) -> List[str]:
    from strands.models.openai import OpenAIModel

    return [m["role"] for m in OpenAIModel.format_request_messages(messages, None)]


def _litellm(messages: List[dict]) -> List[str]:
    from strands.models.litellm import LiteLLMModel

    return [m["role"] for m in LiteLLMModel.format_request_messages(messages, None)]


def _mistral(messages: List[dict]) -> List[str]:
    from strands.models.mistral import MistralModel

    model = MistralModel(api_key="not-a-real-key", model_id="mistral-large-latest")
    return [m["role"] for m in model._format_request_messages(messages, None)]


def _writer(messages: List[dict]) -> List[str]:
    from strands.models.writer import WriterModel

    model = WriterModel(client_args={"api_key": "not-a-real-key"}, model_id="palmyra-x5")
    return [m["role"] for m in model._format_request_messages(messages, None)]


def _llamaapi(messages: List[dict]) -> List[str]:
    from strands.models.llamaapi import LlamaAPIModel

    model = LlamaAPIModel(
        client_args={"api_key": "not-a-real-key"}, model_id="llama-3"
    )
    return [m["role"] for m in model._format_request_messages(messages, None)]


def _llamacpp(messages: List[dict]) -> List[str]:
    from strands.models.llamacpp import LlamaCppModel

    model = LlamaCppModel(model_id="local")
    return [m["role"] for m in model._format_messages(messages, None)]


def _anthropic(messages: List[dict]) -> List[str]:
    from strands.models.anthropic import AnthropicModel

    model = AnthropicModel(
        client_args={"api_key": "not-a-real-key"},
        model_id="claude-sonnet-4",
        max_tokens=1,
    )
    return [m["role"] for m in model._format_request_messages(messages)]


def _bedrock(messages: List[dict]) -> List[str]:
    from strands.models.bedrock import BedrockModel

    model = BedrockModel(model_id="anthropic.claude-sonnet-4", region_name="us-east-1")
    return [m["role"] for m in model._format_bedrock_messages(messages)]


def _gemini(messages: List[dict]) -> List[str]:
    from strands.models.gemini import GeminiModel

    model = GeminiModel(
        client_args={"api_key": "not-a-real-key"}, model_id="gemini-2.0-flash"
    )
    return [content.role for content in model._format_request_content(messages)]


PROVIDER_FORMATTERS = [
    ProviderFormatter("openai", SPLITTING, _openai),
    ProviderFormatter("litellm", SPLITTING, _litellm),
    ProviderFormatter("mistral", SPLITTING, _mistral),
    ProviderFormatter("writer", SPLITTING, _writer),
    ProviderFormatter("llamaapi", SPLITTING, _llamaapi),
    ProviderFormatter("llamacpp", SPLITTING, _llamacpp),
    ProviderFormatter("anthropic", ONE_TO_ONE, _anthropic),
    ProviderFormatter("bedrock", ONE_TO_ONE, _bedrock),
    ProviderFormatter("gemini", ONE_TO_ONE, _gemini),
]


#: The subset whose rule is tool-call adjacency. Used where a scenario legitimately
#: produces two consecutive user turns, which this adapter has always produced on
#: its ordinary paths and does not claim to repair.
SPLITTING_FORMATTERS = [p for p in PROVIDER_FORMATTERS if p.family is SPLITTING]


def bound_roles(provider: ProviderFormatter, messages: Any) -> List[str]:
    """The provider-message roles ``messages`` binds to, skipping when the
    provider's own SDK is not installed. Only the import is forgiven: a
    formatter that is present and raises is a real failure."""
    try:
        return provider.bind(list(messages))
    except ImportError as missing:
        pytest.skip(f"{provider.name} provider SDK is not installed: {missing}")


def assert_binds_cleanly(provider: ProviderFormatter, messages: Any) -> List[str]:
    """Assert ``messages`` satisfies the rule ``provider``'s family enforces."""
    roles = bound_roles(provider, messages)
    if provider.family is SPLITTING:
        for index, role in enumerate(roles):
            if role != "assistant":
                continue
            answer = roles[index + 1] if index + 1 < len(roles) else None
            assert answer == "tool", (
                f"{provider.name}: an assistant message with tool_calls must be "
                f"followed by its tool messages, got {roles}"
            )
    else:
        for index in range(1, len(roles)):
            assert roles[index] != roles[index - 1], (
                f"{provider.name}: roles must alternate, got {roles}"
            )
    return roles

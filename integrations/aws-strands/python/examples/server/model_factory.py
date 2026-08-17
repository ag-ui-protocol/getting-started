"""Shared model factory for Strands examples.

Supports OpenAI, Anthropic, and Gemini via MODEL_PROVIDER env var.
Defaults to OpenAI.
"""
import os
import logging

logger = logging.getLogger(__name__)


def create_model(openai_api: str = "chat"):
    """Create a Strands model based on MODEL_PROVIDER env var.

    Supported providers: openai (default), anthropic, gemini

    ``openai_api`` selects the OpenAI API mode. The default Chat Completions
    API streams tool-call ARGUMENTS incrementally and emits no reasoning
    summaries, which is what most demos want. Pass ``"responses"`` only for
    demos that deliberately showcase reasoning (e.g. agentic_chat_reasoning);
    the Responses API surfaces reasoning summaries but buffers tool-call
    argument deltas until the call completes, which defeats progressive A2UI
    surface painting.
    """
    provider = os.getenv("MODEL_PROVIDER", "openai").lower()

    if openai_api not in ("chat", "responses"):
        # A typo here would silently select the Responses API, whose buffered
        # tool-call deltas defeat progressive A2UI painting — the exact
        # regression the streaming e2e guards. Fail loud instead.
        raise ValueError(
            f"Unknown openai_api: {openai_api!r}. Supported: chat, responses"
        )

    if provider == "openai":
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OPENAI_API_KEY environment variable is required when MODEL_PROVIDER=openai. "
                "Set it in your .env file or environment."
            )
        if openai_api == "chat":
            from strands.models.openai import OpenAIModel
            return OpenAIModel(
                client_args={
                    "api_key": api_key,
                },
                model_id=os.getenv("MODEL_ID", "gpt-5.4"),
            )
        from strands.models.openai_responses import OpenAIResponsesModel
        return OpenAIResponsesModel(
            client_args={
                "api_key": api_key,
            },
            model_id=os.getenv("MODEL_ID", "gpt-5.4"),
            params={
                "reasoning": {"effort": "medium", "summary": "auto"},
            }
        )
    elif provider == "anthropic":
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError(
                "ANTHROPIC_API_KEY environment variable is required when MODEL_PROVIDER=anthropic. "
                "Set it in your .env file or environment."
            )
        from strands.models.anthropic import AnthropicModel
        return AnthropicModel(
            client_args={
                "api_key": api_key,
                # Without this beta, Anthropic buffers tool-input JSON into a
                # few coarse validated chunks (seconds apart), which defeats
                # progressive A2UI painting. Fine-grained tool streaming emits
                # token-level input_json_delta events.
                "default_headers": {
                    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14"
                },
            },
            model_id=os.getenv("MODEL_ID", "claude-sonnet-4-6"),
            # Top-level required config for strands' AnthropicModel (its
            # format_request reads self.config["max_tokens"] unconditionally).
            max_tokens=8192,
        )
    elif provider == "gemini":
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError(
                "GOOGLE_API_KEY environment variable is required when MODEL_PROVIDER=gemini. "
                "Set it in your .env file or environment."
            )
        from strands.models.gemini import GeminiModel
        return GeminiModel(
            client_args={
                "api_key": api_key,
            },
            model_id=os.getenv("MODEL_ID", "gemini-2.5-flash"),
            params={
                "temperature": 0.7,
                "max_output_tokens": 2048,
            }
        )
    else:
        raise ValueError(f"Unknown MODEL_PROVIDER: {provider}. Supported: openai, anthropic, gemini")

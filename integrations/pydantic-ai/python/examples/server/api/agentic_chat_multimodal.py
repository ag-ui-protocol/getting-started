"""Agentic Chat Multimodal — accepts images and other media."""

from __future__ import annotations

from pydantic_ai import Agent


agent = Agent(
    'openai:gpt-4o',
    instructions=(
        'You are a helpful assistant. When the user sends images or other '
        'media, describe what you see and answer their questions about it.'
    ),
)

"""Agentic chat: plain streaming conversation over the Antigravity harness.

Text arrives as `content_delta` on a re-emitted step and is translated into a
single bookended AG-UI message (TEXT_MESSAGE_START/CONTENT.../END).
"""

from __future__ import annotations

from ._common import build, chat_only_capabilities

agent = build(
    capabilities=chat_only_capabilities(),
    system_instructions=(
        "You are a helpful, concise assistant. Answer directly. "
        "Do not read or write files unless the user explicitly asks."
    ),
)

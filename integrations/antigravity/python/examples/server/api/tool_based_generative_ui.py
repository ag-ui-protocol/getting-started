"""Tool-based generative UI: the model drives client-rendered components.

Each tool the client sends in `RunAgentInput.tools` becomes a custom async
Antigravity tool. Calling one emits TOOL_CALL_START/ARGS/END and parks the
harness until the client returns a ToolMessage -- the return value becomes the
model's tool result natively.
"""

from __future__ import annotations

from ._common import build, chat_only_capabilities

agent = build(
    capabilities=chat_only_capabilities(),
    system_instructions=(
        "You help the user by calling the frontend tools they provide. "
        "When a tool matches the request, call it instead of describing what "
        "you would do. After the tool returns, briefly confirm the result."
    ),
)

"""Human-in-the-loop: the run pauses on the user and resumes on the next run.

The client's tools become custom async Antigravity tools. Calling one emits
TOOL_CALL_START/ARGS/END, parks on an asyncio.Future, and ends the run; the
next run resolves the Future from the client's `ToolMessage`. This works
because Antigravity's custom tools are awaited with no timeout, so the harness
stays alive while run N's SSE response is already closed.

The adapter also supports the model's own `ask_question` interaction, mapped to
an AG-UI interrupt via OnInteractionHook. That path is NOT exercised here:
`chat_only_capabilities()` disables the `ask_question` built-in, because the
dojo answers frontend tools rather than `RunAgentInput.resume` interrupts. Drop
the capability restriction to try it against a client that handles interrupts.
"""

from __future__ import annotations

from ._common import build, chat_only_capabilities

agent = build(
    capabilities=chat_only_capabilities(),
    system_instructions=(
        "You plan tasks with the user. When you need the user to choose "
        "between options, ask them rather than guessing. Use the frontend "
        "tools the user provides to present plans, and revise the plan when "
        "the user changes it."
    ),
)

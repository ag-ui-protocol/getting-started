"""Backend tool rendering: the harness' own built-in tools, surfaced to the UI.

Antigravity executes these in the Go subprocess against the real filesystem.

`tool_approval=True` is deliberately NOT set. It routes every non-auto-approved
call through an AG-UI approval *interrupt*, and the dojo answers frontend tools
(`ToolMessage`) rather than interrupts (`RunAgentInput.resume`) -- so the first
`create_file` would park on a prompt nothing can answer and the run would hang.
It looks fine until you ask for a write, because reads are auto-approved.

Enable it against a client that implements the interrupt protocol; the adapter
then also stops needing the `allow_all` fallback for the SDK's write-tool
safety guard.
"""

from __future__ import annotations

from google.antigravity import CapabilitiesConfig
from google.antigravity.types import BuiltinTools

from ._common import WORKSPACE, build

agent = build(
    system_instructions=(
        "You are a coding assistant with real filesystem and shell access, "
        f"scoped to {WORKSPACE}. Use your built-in tools to inspect and "
        "modify files when the user asks."
    ),
    # search_web returns an empty summary without Google credentials, which
    # sends the model into a retry loop; the filesystem tools work, so expose
    # only those.
    capabilities=CapabilitiesConfig(
        enabled_tools=[
            BuiltinTools.LIST_DIR,
            BuiltinTools.VIEW_FILE,
            BuiltinTools.FIND_FILE,
            BuiltinTools.SEARCH_DIR,
            BuiltinTools.CREATE_FILE,
            BuiltinTools.EDIT_FILE,
            BuiltinTools.RUN_COMMAND,
            BuiltinTools.FINISH,
        ],
        enable_subagents=False,
    ),
)

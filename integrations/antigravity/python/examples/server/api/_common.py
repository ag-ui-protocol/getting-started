"""Shared model/workspace wiring for the Antigravity demo agents.

Antigravity gives every session a real subprocess with filesystem and shell
access, so the demos confine it to a scratch workspace rather than the server's
working directory.
"""

from __future__ import annotations

import os
import tempfile

from google.antigravity import CapabilitiesConfig
from google.antigravity.types import BuiltinTools

WORKSPACE = os.environ.get(
    "ANTIGRAVITY_WORKSPACE", os.path.join(tempfile.gettempdir(), "ag-ui-antigravity")
)
# exist_ok only tolerates an existing *directory*; a leftover file at this path
# would otherwise abort the import with a bare FileExistsError.
if os.path.exists(WORKSPACE) and not os.path.isdir(WORKSPACE):
    raise RuntimeError(
        f"ANTIGRAVITY_WORKSPACE points at {WORKSPACE!r}, which exists but is not a "
        "directory. Remove it or set ANTIGRAVITY_WORKSPACE to a free path."
    )
os.makedirs(WORKSPACE, exist_ok=True)

# Seed the sandbox so the backend-tool demo has something real to inspect.
_SEED = {
    "README.md": (
        "# Antigravity demo workspace\n\n"
        "The agent has real filesystem and shell access, scoped to this\n"
        'directory. Try: "list the files here", "read notes.txt", or\n'
        '"create a file called hello.txt".\n'
    ),
    "notes.txt": "Project codename: Octarine\nStatus: shipping\n",
}
for _name, _body in _SEED.items():
    _path = os.path.join(WORKSPACE, _name)
    if not os.path.exists(_path):
        with open(_path, "w") as _handle:
            _handle.write(_body)

# The SDK's OpenAI-compatible path targets unauthenticated local servers. To
# demo against hosted OpenAI, set ANTIGRAVITY_USE_OPENAI=1 and the example shim
# injects the Authorization header (see ../openai_proxy.py).
USE_OPENAI = os.environ.get("ANTIGRAVITY_USE_OPENAI") == "1"

if USE_OPENAI:
    from ..openai_proxy import start_background

    BASE_URL = start_background(port=int(os.environ.get("ANTIGRAVITY_SHIM_PORT", 8931)))
    MODEL = os.environ.get("ANTIGRAVITY_MODEL", "gpt-4.1-mini")
else:
    BASE_URL = None
    MODEL = os.environ.get("ANTIGRAVITY_MODEL")  # None -> the SDK default


def chat_only_capabilities() -> CapabilitiesConfig:
    """Enables no built-in tool except `finish`.

    `enabled_tools` is an allowlist, so this strips the harness' *entire*
    built-in toolset -- filesystem, shell, subagents, image generation,
    `search_web` and `ask_question` -- leaving the demos to use only the tools
    the client supplies. Two reasons:

    * `search_web` returns an empty summary unless the harness has Google
      credentials, and the model then retries it until the turn never settles.
    * `ask_question` would park on an AG-UI interrupt, and the dojo answers
      frontend tools (via `ToolMessage`) rather than interrupts (via
      `RunAgentInput.resume`), so nothing would ever resolve it. The same
      constraint is why no demo here sets `tool_approval=True`.

    `finish` must stay: the harness uses it to end a turn.
    """
    return CapabilitiesConfig(
        enabled_tools=[BuiltinTools.FINISH], enable_subagents=False
    )


def build(**kwargs):
    """Creates an AntigravityAgent with the demo's shared model/workspace."""
    from ag_ui_antigravity import AntigravityAgent

    defaults = dict(model=MODEL, base_url=BASE_URL, workspaces=[WORKSPACE])
    defaults.update(kwargs)
    return AntigravityAgent(**defaults)

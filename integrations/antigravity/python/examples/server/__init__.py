"""Demo server exposing one Antigravity agent per dojo feature.

Against Gemini (the SDK's native path):

    export GEMINI_API_KEY=...
    uv run dev

Against hosted OpenAI (uses the auth-injecting shim in this package):

    export OPENAI_API_KEY=...
    export ANTIGRAVITY_USE_OPENAI=1
    uv run dev
"""

from __future__ import annotations

import os

import uvicorn
from ag_ui_antigravity import create_antigravity_app

from .api import (
    agentic_chat,
    backend_tool_rendering,
    human_in_the_loop,
    tool_based_generative_ui,
)
from .api._common import WORKSPACE

# Keys must match the dojo feature ids in apps/dojo/src/menu.ts.
AGENTS = {
    "agentic_chat": agentic_chat.agent,
    "human_in_the_loop": human_in_the_loop.agent,
    "tool_based_generative_ui": tool_based_generative_ui.agent,
    "backend_tool_rendering": backend_tool_rendering.agent,
}

app = create_antigravity_app(AGENTS)


def main() -> None:
    """Starts the demo server."""
    if not os.getenv("OPENAI_API_KEY") and not os.getenv("GEMINI_API_KEY"):
        print("⚠️  No model credentials found.")
        print("   Gemini (default):  export GEMINI_API_KEY=...")
        print("   OpenAI (via shim): export OPENAI_API_KEY=... ANTIGRAVITY_USE_OPENAI=1")
        print()

    port = int(os.getenv("PORT", "8027"))
    print("Starting Antigravity demo server...")
    print(f"  workspace: {WORKSPACE}")
    for name in AGENTS:
        print(f"  • {name}: http://localhost:{port}/{name}")
    # Pass the app object rather than an import string: the string form only
    # resolves when the process happens to be started from this directory.
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

__all__ = ["app", "main"]

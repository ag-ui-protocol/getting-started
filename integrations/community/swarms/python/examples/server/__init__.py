"""Example AG-UI server exposing a Swarms agent.

Demonstrates the AG-UI dojo "Agentic Chat" feature backed by a ``swarms.Agent``.
The agent is registered with the AG-UI adapter and served over HTTP/SSE so any
AG-UI compatible frontend (such as the dojo) can talk to it.
"""

from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI
from swarms import Agent

from swarms_agui import add_swarms_fastapi_endpoint

load_dotenv()


def build_agent() -> Agent:
    """Build the Swarms agent used by the Agentic Chat example."""
    return Agent(
        agent_name="AG-UI Assistant",
        system_prompt="You are a helpful assistant.",
        model_name=os.getenv("OPENAI_CHAT_MODEL_ID", "gpt-4o"),
        max_loops=1,
        # Return only the agent's final reply (not the whole transcript), which
        # is what the adapter streams back to the client.
        output_type="final",
        # Stream tokens as they are generated so the adapter can forward
        # incremental TEXT_MESSAGE_CONTENT events to the client.
        streaming_on=True,
        autosave=False,
        verbose=False,
        print_on=False,
    )


app = FastAPI(title="Swarms AG-UI server")
# The dojo addresses agents at ``<url>/<feature>/agui``, so the Agentic Chat
# feature is served at ``/agentic_chat/agui``.
add_swarms_fastapi_endpoint(app, build_agent(), path="/agentic_chat/agui")


def main() -> None:
    """Start the FastAPI server, honoring the HOST and PORT env vars."""
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8023"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()


__all__ = ["app", "build_agent", "main"]

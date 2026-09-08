"""Shared fixtures and lightweight fakes for the Claude Agent SDK adapter tests.

These tests exercise the *translation* layer (Claude Agent SDK message
objects -> AG-UI protocol events) and the pure helper utilities. None of them
call the Anthropic / Claude LLM API: the adapter is fed pre-constructed SDK
message objects, so the network is never touched and no aimock recording is
required. (aimock would be used only for a test that actually drives the LLM,
e.g. a live ``SessionWorker.query`` end-to-end test.)
"""

from typing import Any, AsyncIterator, List

import pytest

from ag_ui.core import RunAgentInput


# ---------------------------------------------------------------------------
# Fake Claude Agent SDK stream / message shapes
#
# The adapter consumes objects from ``claude_agent_sdk``. We import the real
# block/message classes where their constructors are simple, and build tiny
# stand-ins for the streaming ``StreamEvent`` (which is just a wrapper around a
# raw event dict).
# ---------------------------------------------------------------------------

from claude_agent_sdk.types import StreamEvent  # noqa: E402


def stream_event(event: dict, *, uuid: str = "evt", session_id: str = "thread-1") -> StreamEvent:
    """Build a real StreamEvent wrapping a raw streaming event dict."""
    return StreamEvent(uuid=uuid, session_id=session_id, event=event)


async def aiter(items: List[Any]) -> AsyncIterator[Any]:
    """Turn a list into an async iterator (a fake message stream)."""
    for item in items:
        yield item


@pytest.fixture
def make_input():
    """Factory for RunAgentInput with sensible defaults."""

    def _make(
        *,
        thread_id: str = "thread-1",
        run_id: str = "run-1",
        messages=None,
        tools=None,
        state=None,
        context=None,
        forwarded_props=None,
    ) -> RunAgentInput:
        return RunAgentInput(
            thread_id=thread_id,
            run_id=run_id,
            messages=messages or [],
            tools=tools or [],
            state=state if state is not None else None,
            context=context or [],
            forwarded_props=forwarded_props or {},
        )

    return _make

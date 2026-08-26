"""Standalone, single-file reproduction of the TEXT_MESSAGE_START bug.

Bug: a suppressed internal LLM call (whose TEXT_MESSAGE_*/TOOL_CALL_* events
are filtered out by a subclass's ``_dispatch_event`` returning ``None`` --
e.g. CopilotKit's ``LangGraphAGUIAgent`` does this for calls tagged
``copilotkit:emit-messages=False``) permanently leaves
``messages_in_process[run_id]`` marked "in progress". Every subsequent
*real*, organically-streamed assistant message in the same run then skips
``TEXT_MESSAGE_START`` entirely and jumps straight to
``TEXT_MESSAGE_CONTENT`` -- which AG-UI clients reject with:

    Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found
    with ID '...'. Start a text message with 'TEXT_MESSAGE_START' first.

This script drives ``LangGraphAgent._handle_single_event`` directly with
synthetic LangGraph ``astream_events``-shaped events -- no LangGraph graph,
LLM, or API key required. It exercises exactly two calls in one run:

  1. An internal call whose events are suppressed (simulating
     ``copilotkit:emit-messages=False``), which streams and then ends.
  2. A real call, in a different graph node, that streams normally.

Expected (correct) behavior: step 2 emits TEXT_MESSAGE_START before its
TEXT_MESSAGE_CONTENT. Buggy behavior: TEXT_MESSAGE_START is missing.

Usage:
    pip install ag-ui-langgraph
    python repro_text_message_start_bug.py
"""
import asyncio

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui_langgraph.types import LangGraphEventTypes


def dispatch_passthrough(ev):
    """Mimics CopilotKit's LangGraphAGUIAgent._dispatch_event: suppresses
    TEXT_MESSAGE_*/TOOL_CALL_* events (returns None) when the originating
    LangGraph run metadata carries ``copilotkit:emit-messages=False`` --
    the pattern used to hide internal, non-user-facing LLM calls (e.g. a
    structured-output classification/routing step) from the AG-UI stream."""
    if ev.type in (
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ):
        raw_metadata = (ev.raw_event or {}).get("metadata", {})
        if raw_metadata.get("copilotkit:emit-messages") is False:
            return None
    return ev


def make_agent():
    from unittest.mock import MagicMock

    agent = LangGraphAgent(name="repro", graph=MagicMock())
    agent.active_run = {
        "id": "run-1",
        "thread_id": "t1",
        "reasoning_process": None,
        "node_name": "agent",
        "has_function_streaming": False,
        "model_made_tool_call": False,
        "state_reliable": True,
        "streamed_messages": [],
        "manually_emitted_state": None,
        "schema_keys": {"input": ["messages", "tools"], "output": ["messages", "tools"], "config": [], "context": []},
    }
    agent._dispatch_event = dispatch_passthrough
    return agent


async def stream_chunk(agent, message_id: str, content: str, *, suppress: bool):
    event = {
        "event": LangGraphEventTypes.OnChatModelStream.value,
        "data": {"chunk": {"id": message_id, "content": content, "tool_call_chunks": []}},
        "metadata": {"copilotkit:emit-messages": not suppress},
    }
    return [ev async for ev in agent._handle_single_event(event, {}) if ev is not None]


async def end_chat_model(agent, *, suppress: bool):
    event = {
        "event": LangGraphEventTypes.OnChatModelEnd.value,
        "data": {},
        "metadata": {"copilotkit:emit-messages": not suppress},
    }
    return [ev async for ev in agent._handle_single_event(event, {}) if ev is not None]


async def main() -> int:
    agent = make_agent()

    print("Step 1: internal (suppressed) LLM call streams + ends, node 'classify'")
    for _ in agent.handle_node_change("classify"):
        pass
    await stream_chunk(agent, "internal-msg", "internal output", suppress=True)
    await end_chat_model(agent, suppress=True)
    print(f"  messages_in_process['run-1'] after suppressed call: "
          f"{agent.get_message_in_progress('run-1')!r}")

    print("Step 2: real LLM call streams normally, node 'model' (different node, same run)")
    for _ in agent.handle_node_change("model"):
        pass
    events = await stream_chunk(agent, "real-msg", "Hello there", suppress=False)
    event_types = [e.type for e in events]
    print(f"  Emitted event types: {event_types}")

    ok = EventType.TEXT_MESSAGE_START in event_types and EventType.TEXT_MESSAGE_CONTENT in event_types
    if ok:
        print("\nPASS: TEXT_MESSAGE_START was emitted for the real message. Fix is present.")
        return 0
    else:
        print(
            "\nFAIL (bug reproduced): TEXT_MESSAGE_START is missing for the real message.\n"
            "AG-UI clients would reject the TEXT_MESSAGE_CONTENT that follows with:\n"
            "  \"Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found "
            "with ID '...'. Start a text message with 'TEXT_MESSAGE_START' first.\"\n"
            "Root cause: OnChatModelEnd only clears messages_in_process[run_id] when\n"
            "_dispatch_event's return value is truthy; a suppressed (None-returning)\n"
            "dispatch for the internal call in Step 1 leaves it permanently poisoned."
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

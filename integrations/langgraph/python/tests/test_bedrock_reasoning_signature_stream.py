"""Regression coverage for Bedrock Converse signature-only reasoning chunks."""

import unittest

from ag_ui.core import EventType

from ag_ui_langgraph.types import LangGraphEventTypes
from tests._helpers import make_agent, _record_dispatch


def _active_run() -> dict:
    return {
        "id": "run-1",
        "thread_id": "thread-1",
        "mode": "start",
        "reasoning_processes": {},
        "pending_reasoning_ids": {},
        "current_subagent_run_id": None,
        "node_name": "agent",
        "has_function_streaming": False,
        "streamed_tool_call_ids": set(),
        "model_made_tool_call": False,
        "state_reliable": True,
        "manually_emitted_state": None,
        "schema_keys": {
            "input": ["messages", "tools"],
            "output": ["messages", "tools"],
            "config": [],
            "context": [],
        },
    }


def _stream_event(content: list[dict]) -> dict:
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": {"emit-messages": True, "emit-tool-calls": True},
        "data": {
            "chunk": {
                "id": "bedrock-message",
                "content": content,
                "tool_call_chunks": [],
                "response_metadata": {},
            }
        },
    }


class TestBedrockReasoningSignatureStream(unittest.IsolatedAsyncioTestCase):
    async def _handle(self, agent, content: list[dict]) -> None:
        async for _ in agent._handle_single_event(_stream_event(content), {}):
            pass

    async def test_empty_flush_keeps_reasoning_open_and_signature_is_emitted(self):
        agent = _record_dispatch(make_agent())
        agent.active_run = _active_run()

        await self._handle(
            agent,
            [{
                "type": "reasoning_content",
                "reasoning_content": {"text": "The"},
                "index": 0,
            }],
        )
        reasoning_message_id = agent.active_run["reasoning_processes"]["__root__"]["message_id"]

        await self._handle(
            agent,
            [{
                "type": "reasoning_content",
                "reasoning_content": {"text": ""},
                "index": 0,
            }],
        )
        self.assertIsNotNone(agent.active_run["reasoning_processes"]["__root__"])
        self.assertFalse(
            any(event.type == EventType.REASONING_END for event in agent.dispatched)
        )

        await self._handle(
            agent,
            [{
                "type": "reasoning_content",
                "reasoning_content": {"signature": "EpcCC=="},
                "index": 0,
            }],
        )
        self.assertEqual(
            agent.active_run["reasoning_processes"]["__root__"]["signature"], "EpcCC=="
        )

        await self._handle(agent, [{"type": "text", "text": "Done", "index": 1}])

        encrypted_events = [
            event
            for event in agent.dispatched
            if event.type == EventType.REASONING_ENCRYPTED_VALUE
        ]
        self.assertEqual(len(encrypted_events), 1)
        self.assertEqual(encrypted_events[0].entity_id, reasoning_message_id)
        self.assertEqual(encrypted_events[0].encrypted_value, "EpcCC==")
        self.assertEqual(
            sum(event.type == EventType.REASONING_END for event in agent.dispatched),
            1,
        )
        self.assertIsNone(agent.active_run["reasoning_processes"].get("__root__"))


if __name__ == "__main__":
    unittest.main()

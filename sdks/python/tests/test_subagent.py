import unittest

from ag_ui.core.types import AssistantMessage, ToolMessage, ReasoningMessage
from ag_ui.core.events import (
    EventType,
    TextMessageStartEvent,
    TextMessageChunkEvent,
    ToolCallChunkEvent,
    ReasoningMessageChunkEvent,
    StateDeltaEvent,
    SubagentStartedEvent,
    SubagentFinishedEvent,
    SubagentErrorEvent,
)


class TestSubagentMessageAttribution(unittest.TestCase):
    def test_assistant_message_accepts_subagent_id(self):
        msg = AssistantMessage(id="m1", role="assistant", content="hi", subagent_id="sub-1")
        self.assertEqual(msg.subagent_id, "sub-1")
        self.assertEqual(msg.model_dump(by_alias=True)["subagentId"], "sub-1")

    def test_tool_and_reasoning_messages_accept_subagent_id(self):
        # model_dump(by_alias=True) is the meaningful guard: because ConfiguredBaseModel
        # uses extra="allow", an undeclared field would round-trip as snake_case
        # "subagent_id" and the camelCase lookup would KeyError. Asserting the aliased
        # "subagentId" key proves the field is genuinely declared on each model.
        tool = ToolMessage(id="t1", role="tool", content="ok", tool_call_id="tc1", subagent_id="sub-2")
        self.assertEqual(tool.subagent_id, "sub-2")
        self.assertEqual(tool.model_dump(by_alias=True)["subagentId"], "sub-2")
        reasoning = ReasoningMessage(id="r1", role="reasoning", content="x", subagent_id="sub-3")
        self.assertEqual(reasoning.subagent_id, "sub-3")
        self.assertEqual(reasoning.model_dump(by_alias=True)["subagentId"], "sub-3")

    def test_subagent_id_optional(self):
        msg = AssistantMessage(id="m2", role="assistant", content="hi")
        self.assertIsNone(msg.subagent_id)


class TestSubagentEventAttribution(unittest.TestCase):
    def test_creation_and_standalone_events_accept_subagent_id(self):
        e = TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1", subagent_id="sub-1")
        self.assertEqual(e.subagent_id, "sub-1")
        self.assertEqual(e.model_dump(by_alias=True)["subagentId"], "sub-1")
        d = StateDeltaEvent(type=EventType.STATE_DELTA, delta=[], subagent_id="sub-2")
        self.assertEqual(d.subagent_id, "sub-2")
        self.assertEqual(d.model_dump(by_alias=True)["subagentId"], "sub-2")

    def test_all_chunk_events_accept_subagent_id(self):
        text = TextMessageChunkEvent(type=EventType.TEXT_MESSAGE_CHUNK, message_id="m1", subagent_id="sub-7")
        self.assertEqual(text.subagent_id, "sub-7")
        self.assertEqual(text.model_dump(by_alias=True)["subagentId"], "sub-7")
        tool = ToolCallChunkEvent(type=EventType.TOOL_CALL_CHUNK, tool_call_id="tc1", subagent_id="sub-8")
        self.assertEqual(tool.subagent_id, "sub-8")
        self.assertEqual(tool.model_dump(by_alias=True)["subagentId"], "sub-8")
        reasoning = ReasoningMessageChunkEvent(
            type=EventType.REASONING_MESSAGE_CHUNK, message_id="r1", delta="thinking", subagent_id="sub-9"
        )
        self.assertEqual(reasoning.subagent_id, "sub-9")
        self.assertEqual(reasoning.model_dump(by_alias=True)["subagentId"], "sub-9")


class TestSubagentLifecycleEvents(unittest.TestCase):
    def test_started_finished_error(self):
        s = SubagentStartedEvent(
            type=EventType.SUBAGENT_STARTED, subagent_id="s1", name="R",
            description="d", parent_subagent_id="s0",
        )
        self.assertEqual(s.type, EventType.SUBAGENT_STARTED)
        self.assertEqual(s.parent_subagent_id, "s0")
        # Guard the camelCase wire aliases (declared fields dump as camelCase; an
        # undeclared extra would dump as snake_case and fail these lookups).
        s_dump = s.model_dump(by_alias=True)
        self.assertEqual(s_dump["subagentId"], "s1")
        self.assertEqual(s_dump["parentSubagentId"], "s0")
        f = SubagentFinishedEvent(type=EventType.SUBAGENT_FINISHED, subagent_id="s1")
        self.assertEqual(f.type, EventType.SUBAGENT_FINISHED)
        self.assertEqual(f.model_dump(by_alias=True)["subagentId"], "s1")
        err = SubagentErrorEvent(type=EventType.SUBAGENT_ERROR, subagent_id="s1", message="boom", code="E1")
        self.assertEqual(err.message, "boom")
        err_dump = err.model_dump(by_alias=True)
        self.assertEqual(err_dump["subagentId"], "s1")
        self.assertEqual(err_dump["code"], "E1")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python
"""Tests for output_schema text suppression (GitHub #1390).

When an ADK sub-agent has ``output_schema`` configured, its text content is
structured output intended for inter-agent data transfer (e.g. a classifier
returning "CHAT") and must not leak into the chat UI as TextMessageEvents.
"""

import pytest
from unittest.mock import MagicMock, patch

from ag_ui.core import EventType
from ag_ui_adk.event_translator import EventTranslator


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_adk_event(*, author="model", text="Hello", partial=False,
                    turn_complete=True, is_final_response=False,
                    thought=None):
    """Build a lightweight mock ADK event with text content."""
    event = MagicMock()
    event.author = author
    event.partial = partial
    event.turn_complete = turn_complete
    event.is_final_response = is_final_response
    event.finish_reason = None
    event.usage_metadata = None

    mock_part = MagicMock()
    mock_part.text = text
    # thought attribute (for reasoning parts)
    if thought is not None:
        mock_part.thought = thought
    else:
        mock_part.thought = None

    mock_content = MagicMock()
    mock_content.parts = [mock_part]
    event.content = mock_content

    # No function calls / responses by default
    event.get_function_calls = MagicMock(return_value=[])
    event.get_function_responses = MagicMock(return_value=[])

    return event


def _make_adk_event_with_thought_and_text(*, author="classifier",
                                           text="CHAT",
                                           thought_text="Thinking about classification"):
    """Build an ADK event that has both a thought part and a regular text part."""
    event = MagicMock()
    event.author = author
    event.partial = False
    event.turn_complete = True
    event.is_final_response = False
    event.finish_reason = None
    event.usage_metadata = None

    thought_part = MagicMock()
    thought_part.text = thought_text
    thought_part.thought = True

    text_part = MagicMock()
    text_part.text = text
    text_part.thought = None

    mock_content = MagicMock()
    mock_content.parts = [thought_part, text_part]
    event.content = mock_content

    event.get_function_calls = MagicMock(return_value=[])
    event.get_function_responses = MagicMock(return_value=[])

    return event


async def _collect(translator, adk_event, thread_id="t1", run_id="r1"):
    """Collect all AG-UI events from a translator.translate() call."""
    events = []
    async for ev in translator.translate(adk_event, thread_id, run_id):
        events.append(ev)
    return events


# ---------------------------------------------------------------------------
# EventTranslator tests
# ---------------------------------------------------------------------------

class TestOutputSchemaSuppression:
    """Verify that text from output_schema agents is suppressed."""

    @pytest.mark.asyncio
    async def test_text_suppressed_for_output_schema_agent(self):
        """Text from an agent listed in output_schema_agent_names is not emitted."""
        translator = EventTranslator(
            output_schema_agent_names={"classifier"},
        )
        event = _make_adk_event(author="classifier", text="CHAT")
        events = await _collect(translator, event)

        text_events = [e for e in events if e.type in (
            EventType.TEXT_MESSAGE_START,
            EventType.TEXT_MESSAGE_CONTENT,
            EventType.TEXT_MESSAGE_END,
        )]
        assert text_events == [], (
            "Text from output_schema agent should be suppressed"
        )

    @pytest.mark.asyncio
    async def test_text_not_suppressed_for_normal_agent(self):
        """Text from an agent NOT in output_schema_agent_names is emitted normally."""
        translator = EventTranslator(
            output_schema_agent_names={"classifier"},
        )
        event = _make_adk_event(author="assistant", text="Hello user!")
        events = await _collect(translator, event)

        types = [e.type for e in events]
        assert EventType.TEXT_MESSAGE_START in types
        assert EventType.TEXT_MESSAGE_CONTENT in types
        assert EventType.TEXT_MESSAGE_END in types

    @pytest.mark.asyncio
    async def test_text_not_suppressed_when_no_schema_agents_configured(self):
        """Default translator (no output_schema_agent_names) emits all text."""
        translator = EventTranslator()
        event = _make_adk_event(author="classifier", text="CHAT")
        events = await _collect(translator, event)

        types = [e.type for e in events]
        assert EventType.TEXT_MESSAGE_START in types
        assert EventType.TEXT_MESSAGE_CONTENT in types

    @pytest.mark.asyncio
    @patch("ag_ui_adk.event_translator._check_thought_support", return_value=True)
    async def test_reasoning_still_emitted_for_output_schema_agent(self, _mock_thought):
        """Reasoning/thought parts from output_schema agents are still emitted."""
        translator = EventTranslator(
            output_schema_agent_names={"classifier"},
        )
        event = _make_adk_event_with_thought_and_text(
            author="classifier",
            text="CHAT",
            thought_text="Analyzing the user request",
        )
        events = await _collect(translator, event)

        # Should have reasoning events but no text message events
        reasoning_types = {EventType.REASONING_START, EventType.REASONING_MESSAGE_START,
                          EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_END,
                          EventType.REASONING_END}
        text_types = {EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT,
                      EventType.TEXT_MESSAGE_END}

        has_reasoning = any(e.type in reasoning_types for e in events)
        has_text = any(e.type in text_types for e in events)

        assert has_reasoning, "Reasoning events should still be emitted"
        assert not has_text, "Text events should be suppressed"

    @pytest.mark.asyncio
    async def test_multiple_output_schema_agents(self):
        """Multiple agents can be suppressed simultaneously."""
        translator = EventTranslator(
            output_schema_agent_names={"classifier", "router", "scorer"},
        )

        for agent_name in ["classifier", "router", "scorer"]:
            event = _make_adk_event(author=agent_name, text="structured_output")
            events = await _collect(translator, event)
            text_events = [e for e in events if e.type in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )]
            assert text_events == [], (
                f"Text from {agent_name} should be suppressed"
            )

    @pytest.mark.asyncio
    async def test_suppression_does_not_affect_streaming_state(self):
        """Suppressed events don't leave the translator in a broken streaming state."""
        translator = EventTranslator(
            output_schema_agent_names={"classifier"},
        )

        # First: suppressed event from classifier
        suppressed = _make_adk_event(author="classifier", text="CHAT")
        await _collect(translator, suppressed)

        # Second: normal event from assistant should work fine
        normal = _make_adk_event(author="assistant", text="Here is your answer")
        events = await _collect(translator, normal)

        types = [e.type for e in events]
        assert EventType.TEXT_MESSAGE_START in types
        assert EventType.TEXT_MESSAGE_CONTENT in types
        assert EventType.TEXT_MESSAGE_END in types

        # Verify the content is correct
        content_events = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
        assert content_events[0].delta == "Here is your answer"


# ---------------------------------------------------------------------------
# ADKAgent._collect_output_schema_agent_names tests
# ---------------------------------------------------------------------------

class TestCollectOutputSchemaAgentNames:
    """Verify agent tree traversal for output_schema detection."""

    def test_single_llm_agent_with_output_schema(self):
        from google.adk.agents import LlmAgent
        from ag_ui_adk.adk_agent import ADKAgent

        agent = MagicMock(spec=LlmAgent)
        agent.name = "classifier"
        agent.output_schema = str
        agent.sub_agents = []

        result = ADKAgent._collect_output_schema_agent_names(agent)
        assert result == {"classifier"}

    def test_single_llm_agent_without_output_schema(self):
        from google.adk.agents import LlmAgent
        from ag_ui_adk.adk_agent import ADKAgent

        agent = MagicMock(spec=LlmAgent)
        agent.name = "assistant"
        agent.output_schema = None
        agent.sub_agents = []

        result = ADKAgent._collect_output_schema_agent_names(agent)
        assert result == set()

    def test_nested_workflow_with_mixed_agents(self):
        """Walk a SequentialAgent tree with some LlmAgents having output_schema."""
        from google.adk.agents import LlmAgent, BaseAgent
        from ag_ui_adk.adk_agent import ADKAgent

        # classifier sub-agent (has output_schema)
        classifier = MagicMock(spec=LlmAgent)
        classifier.name = "classifier"
        classifier.output_schema = str
        classifier.sub_agents = []

        # responder sub-agent (no output_schema)
        responder = MagicMock(spec=LlmAgent)
        responder.name = "responder"
        responder.output_schema = None
        responder.sub_agents = []

        # scorer sub-agent (has output_schema)
        scorer = MagicMock(spec=LlmAgent)
        scorer.name = "scorer"
        scorer.output_schema = int
        scorer.sub_agents = []

        # Root sequential agent (not an LlmAgent, no output_schema)
        root = MagicMock(spec=BaseAgent)
        root.name = "workflow"
        root.sub_agents = [classifier, responder, scorer]

        result = ADKAgent._collect_output_schema_agent_names(root)
        assert result == {"classifier", "scorer"}

    def test_workflow_graph_nodes_with_output_schema(self):
        """ADK Workflow graph nodes are walked in addition to sub_agents."""
        from google.adk.agents import LlmAgent, BaseAgent
        from ag_ui_adk.adk_agent import ADKAgent

        classifier = MagicMock(spec=LlmAgent)
        classifier.name = "classifier"
        classifier.output_schema = str
        classifier.sub_agents = []

        responder = MagicMock(spec=LlmAgent)
        responder.name = "responder"
        responder.output_schema = None
        responder.sub_agents = []

        workflow = MagicMock(spec=BaseAgent)
        workflow.name = "wf"
        workflow.sub_agents = []
        workflow.graph = MagicMock(nodes=[classifier, responder])

        result = ADKAgent._collect_output_schema_agent_names(workflow)
        assert result == {"classifier"}

    def test_deeply_nested_agents(self):
        """output_schema agents are found at arbitrary depth."""
        from google.adk.agents import LlmAgent, BaseAgent
        from ag_ui_adk.adk_agent import ADKAgent

        deep_agent = MagicMock(spec=LlmAgent)
        deep_agent.name = "deep_classifier"
        deep_agent.output_schema = str
        deep_agent.sub_agents = []

        mid = MagicMock(spec=BaseAgent)
        mid.name = "mid"
        mid.sub_agents = [deep_agent]

        root = MagicMock(spec=BaseAgent)
        root.name = "root"
        root.sub_agents = [mid]

        result = ADKAgent._collect_output_schema_agent_names(root)
        assert result == {"deep_classifier"}

    def test_no_sub_agents_attribute(self):
        """Gracefully handles agents without sub_agents attribute."""
        from ag_ui_adk.adk_agent import ADKAgent

        agent = MagicMock()
        del agent.sub_agents  # Ensure attribute doesn't exist
        agent.name = "solo"

        # Should not raise
        result = ADKAgent._collect_output_schema_agent_names(agent)
        assert isinstance(result, set)

    def test_empty_agent_tree(self):
        """Root agent with no sub_agents and no output_schema."""
        from google.adk.agents import LlmAgent
        from ag_ui_adk.adk_agent import ADKAgent

        agent = MagicMock(spec=LlmAgent)
        agent.name = "solo"
        agent.output_schema = None
        agent.sub_agents = []

        result = ADKAgent._collect_output_schema_agent_names(agent)
        assert result == set()

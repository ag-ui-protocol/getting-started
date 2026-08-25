"""Tests for LangGraphAgent.clone() subclass preservation."""

import unittest
from unittest.mock import MagicMock

from ag_ui_langgraph import LangGraphAgent


class SubclassAgent(LangGraphAgent):
    """Test subclass that adds custom behavior."""

    def __init__(self, *, name, graph, description=None, config=None, enable_legacy_on_interrupt_event=True, emit_interrupt_outcome=False, emit_raw_events=True, custom_flag=False):
        super().__init__(name=name, graph=graph, description=description, config=config, enable_legacy_on_interrupt_event=enable_legacy_on_interrupt_event, emit_interrupt_outcome=emit_interrupt_outcome, emit_raw_events=emit_raw_events)
        self.custom_flag = custom_flag

    def custom_method(self):
        return "subclass behavior"


class TestClone(unittest.TestCase):
    """Test that clone() preserves subclass identity and behavior."""

    def _make_graph(self):
        """Create a mock compiled graph for testing."""
        graph = MagicMock()
        graph.config_specs = []
        return graph

    def test_clone_returns_same_class(self):
        """clone() should return an instance of the same class, not the base."""
        agent = SubclassAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsInstance(cloned, SubclassAgent)

    def test_clone_base_class(self):
        """clone() on the base class should still return LangGraphAgent."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsInstance(cloned, LangGraphAgent)

    def test_clone_copies_fields(self):
        """clone() should copy name, graph, description, and config."""
        graph = self._make_graph()
        config = {"recursion_limit": 50}
        agent = LangGraphAgent(
            name="my-agent",
            graph=graph,
            description="A test agent",
            config=config,
        )
        cloned = agent.clone()
        self.assertEqual(cloned.name, "my-agent")
        self.assertIs(cloned.graph, graph)
        self.assertEqual(cloned.description, "A test agent")
        self.assertEqual(cloned.config, config)

    def test_clone_shallow_copies_config(self):
        """clone() should shallow-copy config so mutations don't leak."""
        config = {"recursion_limit": 50}
        agent = LangGraphAgent(name="test", graph=self._make_graph(), config=config)
        cloned = agent.clone()
        self.assertEqual(cloned.config, config)
        self.assertIsNot(cloned.config, agent.config)

    def test_clone_subclass_has_overridden_methods(self):
        """clone() of a subclass should have the subclass's methods."""
        agent = SubclassAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertEqual(cloned.custom_method(), "subclass behavior")

    def test_clone_does_not_preserve_subclass_extra_state(self):
        """clone() only passes base-class params; subclass defaults apply."""
        agent = SubclassAgent(name="test", graph=self._make_graph(), custom_flag=True)
        cloned = agent.clone()
        # Documented limitation: custom_flag reverts to its default
        self.assertFalse(cloned.custom_flag)

    def test_clone_subclass_with_required_extra_param_raises(self):
        """Subclasses with extra required params must override clone()."""
        class StrictAgent(LangGraphAgent):
            def __init__(self, *, name, graph, api_key, description=None, config=None):
                super().__init__(name=name, graph=graph, description=description, config=config)
                self.api_key = api_key

        agent = StrictAgent(name="test", graph=self._make_graph(), api_key="sk-123")
        with self.assertRaises(TypeError) as ctx:
            agent.clone()
        self.assertIn("must override clone()", str(ctx.exception))

    def test_clone_with_no_config(self):
        """clone() with default (empty) config round-trips correctly."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertEqual(cloned.config, {})

    def test_clone_isolates_mutable_state(self):
        """clone() should produce a separate instance (not the same object)."""
        agent = LangGraphAgent(name="test", graph=self._make_graph())
        cloned = agent.clone()
        self.assertIsNot(agent, cloned)
        self.assertIsNot(agent.messages_in_process, cloned.messages_in_process)


if __name__ == "__main__":
    unittest.main()

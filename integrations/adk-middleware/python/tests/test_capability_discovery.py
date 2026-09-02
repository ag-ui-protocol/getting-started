#!/usr/bin/env python
"""Tests for discover_capabilities: auto-deriving AgentCapabilities from the ADK agent."""

import pytest
from google.adk.agents import LlmAgent
from google.adk.planners import BuiltInPlanner
from google.genai import types

from ag_ui_adk import ADKAgent, AGUIToolset

from tests.constants import LIVE_TEST_MODEL


def _make(adk_agent, **kwargs):
    """Build an ADKAgent wrapping the given ADK agent (in-memory, no I/O)."""
    return ADKAgent(
        adk_agent=adk_agent,
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
        **kwargs,
    )


class TestDiscoveryDisabledByDefault:
    """With the flag off, behavior is unchanged from before the feature."""

    def test_returns_none_when_nothing_configured(self):
        agent = _make(LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x"))
        assert agent.get_capabilities() is None

    def test_returns_only_configured_when_flag_off(self):
        configured = {"identity": {"name": "Explicit"}}
        agent = _make(
            LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x"),
            capabilities=configured,
        )
        assert agent.get_capabilities() == configured


class TestIdentityDerivation:
    def test_derives_name_and_description(self):
        adk = LlmAgent(
            name="analyst",
            model=LIVE_TEST_MODEL,
            description="Answers business questions.",
            instruction="x",
        )
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert caps["identity"] == {
            "type": "google-adk",
            "name": "analyst",
            "description": "Answers business questions.",
        }

    def test_identity_type_present_without_description(self):
        adk = LlmAgent(name="analyst", model=LIVE_TEST_MODEL, instruction="x")
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert caps["identity"]["type"] == "google-adk"
        assert caps["identity"]["name"] == "analyst"
        assert "description" not in caps["identity"]


class TestTransportDerivation:
    def test_streaming_always_true(self):
        adk = LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x")
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert caps["transport"] == {"streaming": True}


class TestToolsAndHitlDerivation:
    def test_no_tools_no_tools_capability(self):
        adk = LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x")
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert "tools" not in caps
        assert "humanInTheLoop" not in caps

    def test_plain_tool_sets_tools_but_not_hitl(self):
        def my_tool(x: str) -> str:
            """Echoes x."""
            return x

        adk = LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x", tools=[my_tool])
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert caps["tools"] == {"supported": True}
        assert "humanInTheLoop" not in caps

    def test_agui_toolset_sets_hitl(self):
        adk = LlmAgent(
            name="a", model=LIVE_TEST_MODEL, instruction="x", tools=[AGUIToolset()]
        )
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert caps["tools"] == {"supported": True}
        assert caps["humanInTheLoop"] == {"supported": True}


class TestReasoningDerivation:
    def test_thinking_planner_sets_reasoning(self):
        adk = LlmAgent(
            name="a",
            model=LIVE_TEST_MODEL,
            instruction="x",
            planner=BuiltInPlanner(
                thinking_config=types.ThinkingConfig(include_thoughts=True)
            ),
        )
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert caps["reasoning"] == {"supported": True, "streaming": True}

    def test_planner_without_thoughts_no_reasoning(self):
        adk = LlmAgent(
            name="a",
            model=LIVE_TEST_MODEL,
            instruction="x",
            planner=BuiltInPlanner(
                thinking_config=types.ThinkingConfig(include_thoughts=False)
            ),
        )
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert "reasoning" not in caps

    def test_no_planner_no_reasoning(self):
        adk = LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x")
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert "reasoning" not in caps


class TestMultiAgentDerivation:
    def test_sub_agents_derive_multiagent(self):
        child = LlmAgent(
            name="child", model=LIVE_TEST_MODEL, description="A child.", instruction="x"
        )
        parent = LlmAgent(
            name="parent", model=LIVE_TEST_MODEL, instruction="x", sub_agents=[child]
        )
        caps = _make(parent, discover_capabilities=True).get_capabilities()
        assert caps["multiAgent"]["supported"] is True
        assert caps["multiAgent"]["subAgents"] == [
            {"name": "child", "description": "A child."}
        ]

    def test_no_sub_agents_no_multiagent(self):
        adk = LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x")
        caps = _make(adk, discover_capabilities=True).get_capabilities()
        assert "multiAgent" not in caps


class TestMergeConfiguredWins:
    def test_configured_overrides_derived_per_subkey(self):
        adk = LlmAgent(name="derived_name", model=LIVE_TEST_MODEL, instruction="x")
        agent = _make(
            adk,
            discover_capabilities=True,
            capabilities={"identity": {"name": "Override", "version": "2.0"}},
        )
        caps = agent.get_capabilities()
        # explicit name wins, explicit version added, derived type preserved
        assert caps["identity"]["name"] == "Override"
        assert caps["identity"]["version"] == "2.0"
        assert caps["identity"]["type"] == "google-adk"

    def test_configured_only_keys_are_added(self):
        adk = LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x")
        agent = _make(
            adk,
            discover_capabilities=True,
            capabilities={"custom": {"myFlag": True}},
        )
        caps = agent.get_capabilities()
        assert caps["custom"] == {"myFlag": True}
        # derived keys still present alongside
        assert caps["transport"] == {"streaming": True}

    def test_returned_dict_is_isolated_from_internal_state(self):
        adk = LlmAgent(name="a", model=LIVE_TEST_MODEL, instruction="x")
        agent = _make(
            adk, discover_capabilities=True, capabilities={"custom": {"n": 1}}
        )
        caps1 = agent.get_capabilities()
        caps1["custom"]["n"] = 999
        caps1["identity"]["name"] = "mutated"
        caps2 = agent.get_capabilities()
        assert caps2["custom"]["n"] == 1
        assert caps2["identity"]["name"] == "a"

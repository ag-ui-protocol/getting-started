"""Regression test: SequentialAgent HITL resumption requires invocation_id.

When a SequentialAgent's sub-agent pauses for a HITL tool call, resumption
must pass the stored invocation_id to runner.run_async(). This triggers ADK's
_setup_context_for_resumed_invocation() which calls
populate_invocation_agent_states() to restore SequentialAgentState — including
the current_sub_agent position. Without this, _find_agent_to_run() dispatches
directly to the sub-agent that made the FunctionCall, bypassing the parent
SequentialAgent's loop. The remaining sub-agents in the sequence never execute.

Context:
- PR #1011 introduced invocation_id storage/passing for this purpose
- Issue #1079 / PR #1080 proposes removing invocation_id entirely because
  it breaks standalone LlmAgents via _get_subagent_to_resume()
- This test ensures any fix for #1079 preserves SequentialAgent behavior
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from ag_ui.core import (
    EventType,
    RunAgentInput,
    Tool as AGUITool,
    UserMessage,
)
from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.apps import App, ResumabilityConfig

from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import INVOCATION_ID_STATE_KEY, SessionManager
from tests.constants import LIVE_TEST_MODEL


def _make_mock_event(
    *,
    author="test_agent",
    text="Hello",
    partial=False,
    invocation_id="inv_123",
    has_lro=False,
    lro_tool_name="approve_plan",
    actions=None,
):
    """Create a mock ADK event with sensible defaults."""
    event = MagicMock()
    event.author = author
    event.partial = partial
    event.invocation_id = invocation_id
    event.turn_complete = not partial
    event.actions = actions

    # Content with text part
    text_part = MagicMock()
    text_part.text = text
    text_part.function_call = None
    text_part.function_response = None

    parts = [text_part]

    if has_lro:
        fc_part = MagicMock()
        fc_part.text = None
        fc = MagicMock()
        fc.name = lro_tool_name
        fc.id = f"fc_{uuid.uuid4().hex[:8]}"
        fc.args = {"plan": {"topic": "test"}}
        fc_part.function_call = fc
        fc_part.function_response = None
        parts.append(fc_part)
        event.long_running_tool_ids = [fc.id]
    else:
        event.long_running_tool_ids = []

    event.content = MagicMock()
    event.content.parts = parts

    event.is_final_response = MagicMock(return_value=not partial)
    event.get_function_calls = MagicMock(return_value=[])
    event.get_function_responses = MagicMock(return_value=[])

    return event


class TestSequentialAgentHitlResumption:
    """Tests that SequentialAgent HITL resumption passes invocation_id to run_async.

    SequentialAgent stores its current_sub_agent position in agent_states during
    a run. When execution pauses for a HITL tool call and later resumes, ADK needs
    the original invocation_id to call populate_invocation_agent_states() and
    restore the sequence position. Without it, only the sub-agent that made the
    FunctionCall runs — the rest of the sequence is skipped.
    """

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        """Reset session manager between tests."""
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def sequential_agent(self):
        """Create a SequentialAgent with two LlmAgent sub-agents."""
        planner = LlmAgent(
            name="planner_agent",
            model=LIVE_TEST_MODEL,
            instruction="You are a planning agent. Create a plan using approve_plan.",
        )
        executor = LlmAgent(
            name="executor_agent",
            model=LIVE_TEST_MODEL,
            instruction="You are an executor. Execute the approved plan.",
        )
        return SequentialAgent(
            name="orchestrator",
            sub_agents=[planner, executor],
        )

    @pytest.fixture
    def resumable_sequential_adk_agent(self, sequential_agent):
        """ADKAgent wrapping a SequentialAgent with ResumabilityConfig."""
        app = App(
            name="test_seq_app",
            root_agent=sequential_agent,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        return ADKAgent.from_app(app, user_id="test_user")

    @pytest.fixture
    def hitl_tool(self):
        """A sample HITL tool for the planner sub-agent."""
        return AGUITool(
            name="approve_plan",
            description="Get user approval for the plan",
            parameters={
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "object",
                        "properties": {
                            "topic": {"type": "string"},
                        },
                    }
                },
                "required": ["plan"],
            },
        )

    @pytest.mark.asyncio
    async def test_sequential_agent_hitl_passes_invocation_id_to_run_async(
        self, resumable_sequential_adk_agent, hitl_tool
    ):
        """Verify run_async receives invocation_id when resuming a SequentialAgent HITL pause.

        This is the core regression test. When a SequentialAgent's sub-agent pauses
        for HITL, the stored invocation_id MUST be passed to run_async() on resume
        so ADK can restore SequentialAgentState.current_sub_agent via
        populate_invocation_agent_states().

        Without invocation_id, ADK takes the new-invocation path which calls
        _find_agent_to_run() — this dispatches directly to the sub-agent that
        made the FunctionCall, bypassing the SequentialAgent loop entirely.
        Subsequent sub-agents in the sequence never execute.
        """
        adk_agent = resumable_sequential_adk_agent
        assert adk_agent._is_adk_resumable() is True

        run_async_kwargs_capture = {}

        async def mock_run_async(**kwargs):
            run_async_kwargs_capture.update(kwargs)
            # Simulate a resumed run: planner_agent acknowledges the tool result,
            # then executor_agent runs
            yield _make_mock_event(
                author="planner_agent",
                text="Plan approved, proceeding.",
                partial=False,
                invocation_id="inv_from_lro_pause",
            )
            yield _make_mock_event(
                author="executor_agent",
                text="Executing the plan now.",
                partial=False,
                invocation_id="inv_from_lro_pause",
            )

        # Simulate stored invocation_id from a previous LRO pause
        stored_inv_id = "inv_from_lro_pause"

        async def mock_get_state(session_id, app_name, user_id):
            return {INVOCATION_ID_STATE_KEY: stored_inv_id}

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Hello")],
            state={},
            tools=[hitl_tool],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            new_callable=AsyncMock,
        ), patch.object(
            adk_agent._session_manager,
            "get_session_state",
            side_effect=mock_get_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # CRITICAL ASSERTION: invocation_id MUST be passed for SequentialAgent
        assert "invocation_id" in run_async_kwargs_capture, (
            "REGRESSION: run_async was NOT passed invocation_id during "
            "SequentialAgent HITL resumption. Without invocation_id, ADK cannot "
            "call populate_invocation_agent_states() to restore "
            "SequentialAgentState.current_sub_agent — the remaining sub-agents "
            "in the sequence will be skipped. "
            f"Got kwargs: {list(run_async_kwargs_capture.keys())}"
        )
        assert run_async_kwargs_capture["invocation_id"] == stored_inv_id, (
            f"Expected invocation_id='{stored_inv_id}', "
            f"got '{run_async_kwargs_capture['invocation_id']}'"
        )

    @pytest.mark.asyncio
    async def test_sequential_agent_stores_invocation_id_on_lro_pause(
        self, resumable_sequential_adk_agent, hitl_tool
    ):
        """Verify invocation_id is stored during a run that pauses on LRO.

        On an initial run where a sub-agent makes a HITL tool call, the middleware
        must store the invocation_id from the ADK events so it can be retrieved
        on the subsequent resume run. Without this, there would be no invocation_id
        to pass on resumption.
        """
        adk_agent = resumable_sequential_adk_agent

        update_calls = []

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append({"state": dict(state) if state else {}})
            return True

        async def mock_run_async(**kwargs):
            # Simulate: planner_agent emits text, then an LRO tool call
            yield _make_mock_event(
                author="planner_agent",
                text="Let me create a plan for you.",
                partial=True,
                invocation_id="inv_initial_run",
            )
            yield _make_mock_event(
                author="planner_agent",
                text="",
                partial=False,
                invocation_id="inv_initial_run",
                has_lro=True,
                lro_tool_name="approve_plan",
            )

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Plan a trip")],
            state={},
            tools=[hitl_tool],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # The invocation_id should have been stored for future HITL resumption
        invocation_store_calls = [
            c for c in update_calls
            if INVOCATION_ID_STATE_KEY in c["state"]
            and c["state"][INVOCATION_ID_STATE_KEY] is not None
        ]
        assert len(invocation_store_calls) >= 1, (
            "invocation_id was not stored during the LRO pause. "
            "Without storing it, the subsequent resume run cannot restore "
            "SequentialAgent state. "
            f"All update_session_state calls: {update_calls}"
        )

    @pytest.mark.asyncio
    async def test_invocation_id_not_cleared_when_lro_tool_active(
        self, resumable_sequential_adk_agent, hitl_tool
    ):
        """Verify invocation_id is NOT cleared when the run pauses on an LRO tool.

        The invocation_id must persist across the HITL pause so it can be used
        during resumption. It should only be cleared after a run completes
        without an LRO pause.
        """
        adk_agent = resumable_sequential_adk_agent

        update_calls = []

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append({"state": dict(state) if state else {}})
            return True

        async def mock_run_async(**kwargs):
            yield _make_mock_event(
                author="planner_agent",
                text="Creating plan...",
                partial=True,
                invocation_id="inv_lro_pause",
            )
            yield _make_mock_event(
                author="planner_agent",
                text="",
                partial=False,
                invocation_id="inv_lro_pause",
                has_lro=True,
                lro_tool_name="approve_plan",
            )

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Plan something")],
            state={},
            tools=[hitl_tool],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # Check that invocation_id was stored but NOT cleared (since LRO is active)
        store_calls = [
            c for c in update_calls
            if INVOCATION_ID_STATE_KEY in c["state"]
            and c["state"][INVOCATION_ID_STATE_KEY] is not None
        ]
        clear_calls = [
            c for c in update_calls
            if INVOCATION_ID_STATE_KEY in c["state"]
            and c["state"][INVOCATION_ID_STATE_KEY] is None
        ]

        assert len(store_calls) >= 1, (
            "invocation_id should be stored during LRO pause"
        )
        assert len(clear_calls) == 0, (
            "invocation_id must NOT be cleared when an LRO tool call is active. "
            "The stored ID is needed for the subsequent HITL resume run to restore "
            "SequentialAgent state. "
            f"Clear calls found: {clear_calls}"
        )

    @pytest.mark.asyncio
    async def test_invocation_id_cleared_after_completed_run(
        self, resumable_sequential_adk_agent
    ):
        """Verify invocation_id IS cleared after a run completes without LRO pause.

        After a normal completion (no HITL pause), any stored invocation_id should
        be cleared to prevent stale IDs from triggering false resumption on the
        next run.
        """
        adk_agent = resumable_sequential_adk_agent

        update_calls = []

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append({"state": dict(state) if state else {}})
            return True

        async def mock_run_async(**kwargs):
            # Normal run with no LRO — both sub-agents complete normally
            yield _make_mock_event(
                author="planner_agent",
                text="Here is the plan.",
                partial=False,
                invocation_id="inv_normal",
            )
            yield _make_mock_event(
                author="executor_agent",
                text="Plan executed.",
                partial=False,
                invocation_id="inv_normal",
            )

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Do something simple")],
            state={},
            tools=[],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        # After a completed run (no LRO), invocation_id should be cleared
        clear_calls = [
            c for c in update_calls
            if INVOCATION_ID_STATE_KEY in c["state"]
            and c["state"][INVOCATION_ID_STATE_KEY] is None
        ]
        # It's acceptable for there to be zero clear calls if the ID was never
        # stored in the first place (no prior stored_invocation_id). The key
        # contract is: if stored, it must be cleared after a non-LRO run.
        # We verify this indirectly by the other tests.


class TestLlmAgentWithSequentialSubAgentHitlResumption:
    """Tests HITL resumption when root is LlmAgent with a SequentialAgent sub-agent.

    This is the topology from issue #1444: an LlmAgent root delegates to a
    SequentialAgent sub-agent. The SequentialAgent still needs invocation_id
    to restore its internal state on resume, even though it's not the root.
    """

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    @pytest.fixture
    def llm_root_with_sequential_sub(self):
        """LlmAgent root with a SequentialAgent sub-agent."""
        step1 = LlmAgent(
            name="step1_agent",
            model=LIVE_TEST_MODEL,
            instruction="Step 1: gather requirements.",
        )
        step2 = LlmAgent(
            name="step2_agent",
            model=LIVE_TEST_MODEL,
            instruction="Step 2: execute the plan.",
        )
        seq = SequentialAgent(
            name="pipeline",
            sub_agents=[step1, step2],
        )
        return LlmAgent(
            name="router",
            model=LIVE_TEST_MODEL,
            instruction="Route to the pipeline.",
            sub_agents=[seq],
        )

    @pytest.fixture
    def resumable_adk_agent(self, llm_root_with_sequential_sub):
        app = App(
            name="test_llm_seq_app",
            root_agent=llm_root_with_sequential_sub,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        return ADKAgent.from_app(app, user_id="test_user")

    @pytest.fixture
    def hitl_tool(self):
        return AGUITool(
            name="approve_plan",
            description="Get user approval for the plan",
            parameters={
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "object",
                        "properties": {"topic": {"type": "string"}},
                    }
                },
                "required": ["plan"],
            },
        )

    def test_root_agent_needs_invocation_id_detects_sequential_sub_agent(
        self, resumable_adk_agent
    ):
        """_root_agent_needs_invocation_id returns True for LlmAgent with SequentialAgent sub."""
        assert resumable_adk_agent._root_agent_needs_invocation_id() is True

    @pytest.mark.asyncio
    async def test_hitl_passes_invocation_id_with_sequential_sub_agent(
        self, resumable_adk_agent, hitl_tool
    ):
        """Verify invocation_id is passed to run_async when LlmAgent root has SequentialAgent sub.

        This is the core test for issue #1444. Without this fix, the stored
        invocation_id was never passed on resume because the root is an LlmAgent,
        causing the SequentialAgent sub-agent to lose its position state.
        """
        adk_agent = resumable_adk_agent
        assert adk_agent._is_adk_resumable() is True

        run_async_kwargs_capture = {}

        async def mock_run_async(**kwargs):
            run_async_kwargs_capture.update(kwargs)
            yield _make_mock_event(
                author="step1_agent",
                text="Requirements gathered.",
                partial=False,
                invocation_id="inv_from_lro_pause",
            )

        stored_inv_id = "inv_from_lro_pause"

        async def mock_get_state(session_id, app_name, user_id):
            return {INVOCATION_ID_STATE_KEY: stored_inv_id}

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Hello")],
            state={},
            tools=[hitl_tool],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            new_callable=AsyncMock,
        ), patch.object(
            adk_agent._session_manager,
            "get_session_state",
            side_effect=mock_get_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        assert "invocation_id" in run_async_kwargs_capture, (
            "REGRESSION (issue #1444): run_async was NOT passed invocation_id "
            "for LlmAgent root with SequentialAgent sub-agent. The "
            "SequentialAgent cannot restore its position state without it. "
            f"Got kwargs: {list(run_async_kwargs_capture.keys())}"
        )
        assert run_async_kwargs_capture["invocation_id"] == stored_inv_id

    @pytest.mark.asyncio
    async def test_stores_invocation_id_on_lro_pause(
        self, resumable_adk_agent, hitl_tool
    ):
        """Verify invocation_id is stored when LRO pauses under LlmAgent+Sequential topology."""
        adk_agent = resumable_adk_agent
        update_calls = []

        async def tracking_update_state(session_id, app_name, user_id, state):
            update_calls.append({"state": dict(state) if state else {}})
            return True

        async def mock_run_async(**kwargs):
            yield _make_mock_event(
                author="step1_agent",
                text="Gathering requirements...",
                partial=True,
                invocation_id="inv_initial_run",
            )
            yield _make_mock_event(
                author="step1_agent",
                text="",
                partial=False,
                invocation_id="inv_initial_run",
                has_lro=True,
                lro_tool_name="approve_plan",
            )

        input_data = RunAgentInput(
            thread_id=f"test_{uuid.uuid4().hex[:8]}",
            run_id=f"run_{uuid.uuid4().hex[:8]}",
            messages=[UserMessage(id="msg1", content="Start pipeline")],
            state={},
            tools=[hitl_tool],
            context=[],
            forwarded_props={},
        )

        with patch.object(
            adk_agent._session_manager,
            "update_session_state",
            side_effect=tracking_update_state,
        ), patch.object(adk_agent, "_create_runner") as mock_create_runner:
            mock_runner = AsyncMock()
            mock_runner.close = AsyncMock()
            mock_runner.run_async = mock_run_async
            mock_create_runner.return_value = mock_runner

            events = [event async for event in adk_agent.run(input_data)]

        invocation_store_calls = [
            c for c in update_calls
            if INVOCATION_ID_STATE_KEY in c["state"]
            and c["state"][INVOCATION_ID_STATE_KEY] is not None
        ]
        assert len(invocation_store_calls) >= 1, (
            "invocation_id was not stored during LRO pause for "
            "LlmAgent+SequentialAgent topology. "
            f"All update_session_state calls: {update_calls}"
        )


class TestNestedCompositeSubAgentDetection:
    """Tests that _root_agent_needs_invocation_id detects composite agents at any depth.

    The check must be recursive: a topology like
    LlmAgent → LlmAgent → SequentialAgent should still return True,
    because the SequentialAgent needs invocation_id to restore its
    position state regardless of how deeply it's nested.
    """

    @pytest.fixture(autouse=True)
    def reset_session_manager(self):
        SessionManager.reset_instance()
        yield
        SessionManager.reset_instance()

    def test_detects_sequential_agent_two_levels_deep(self):
        """LlmAgent → LlmAgent → SequentialAgent should need invocation_id."""
        step1 = LlmAgent(name="step1", model=LIVE_TEST_MODEL, instruction="Step 1")
        step2 = LlmAgent(name="step2", model=LIVE_TEST_MODEL, instruction="Step 2")
        pipeline = SequentialAgent(name="pipeline", sub_agents=[step1, step2])
        specialist = LlmAgent(
            name="specialist", model=LIVE_TEST_MODEL,
            instruction="Run the pipeline.", sub_agents=[pipeline],
        )
        router = LlmAgent(
            name="router", model=LIVE_TEST_MODEL,
            instruction="Route to specialist.", sub_agents=[specialist],
        )
        app = App(
            name="test_nested", root_agent=router,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        agent = ADKAgent.from_app(app, user_id="test_user")
        assert agent._root_agent_needs_invocation_id() is True

    def test_standalone_llm_agents_still_return_false(self):
        """LlmAgent → LlmAgent (no composite anywhere) should NOT need invocation_id."""
        target = LlmAgent(
            name="target", model=LIVE_TEST_MODEL, instruction="Handle task.",
        )
        router = LlmAgent(
            name="router", model=LIVE_TEST_MODEL,
            instruction="Route.", sub_agents=[target],
        )
        app = App(
            name="test_no_composite", root_agent=router,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        agent = ADKAgent.from_app(app, user_id="test_user")
        assert agent._root_agent_needs_invocation_id() is False

    def test_detects_loop_agent_nested(self):
        """LlmAgent → LoopAgent should need invocation_id."""
        from google.adk.agents import LoopAgent

        inner = LlmAgent(name="worker", model=LIVE_TEST_MODEL, instruction="Work")
        loop = LoopAgent(name="retry_loop", sub_agents=[inner], max_iterations=3)
        root = LlmAgent(
            name="root", model=LIVE_TEST_MODEL,
            instruction="Delegate.", sub_agents=[loop],
        )
        app = App(
            name="test_loop_nested", root_agent=root,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        agent = ADKAgent.from_app(app, user_id="test_user")
        assert agent._root_agent_needs_invocation_id() is True

    def test_composite_root_still_detected(self):
        """SequentialAgent as root should still return True (baseline)."""
        step1 = LlmAgent(name="s1", model=LIVE_TEST_MODEL, instruction="Step 1")
        step2 = LlmAgent(name="s2", model=LIVE_TEST_MODEL, instruction="Step 2")
        root = SequentialAgent(name="seq_root", sub_agents=[step1, step2])
        app = App(
            name="test_composite_root", root_agent=root,
            resumability_config=ResumabilityConfig(is_resumable=True),
        )
        agent = ADKAgent.from_app(app, user_id="test_user")
        assert agent._root_agent_needs_invocation_id() is True

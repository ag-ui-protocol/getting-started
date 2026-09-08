"""Integration tests for ADKAgent.from_app() constructor.

Requires GOOGLE_API_KEY environment variable to be set.
"""
import asyncio
import os
import pytest
import uuid
from ag_ui.core import EventType, RunAgentInput, UserMessage, BinaryInputContent, TextInputContent
from ag_ui_adk import ADKAgent
from ag_ui_adk.session_manager import SessionManager
from google.adk.apps import App
from google.adk.agents import LlmAgent
from tests.constants import LIVE_TEST_MODEL

@pytest.fixture(autouse=True)
def setup_llmock(llmock_server):
    """Ensure LLMock is running when no real API key is set."""


@pytest.fixture
def sample_app():
    """Create a simple App for testing."""
    agent = LlmAgent(
        name="test_agent",
        model=LIVE_TEST_MODEL,
        instruction="You are a helpful assistant. Keep responses brief.",
    )
    return App(name="test_app", root_agent=agent)


@pytest.fixture(autouse=True)
def reset_session_manager():
    """Reset session manager between tests."""
    yield
    SessionManager.reset_default()


@pytest.mark.asyncio
async def test_from_app_basic_conversation(sample_app):
    """Test that from_app() creates a working agent."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")

    input_data = RunAgentInput(
        thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
        run_id=f"test_run_{uuid.uuid4().hex[:8]}",
        messages=[UserMessage(id="msg1", content="Say hello in one word")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )

    events = []
    async for event in adk_agent.run(input_data):
        events.append(event)

    # Verify we got expected event types
    event_types = [e.type for e in events]
    assert EventType.RUN_STARTED in event_types
    assert EventType.RUN_FINISHED in event_types


@pytest.mark.asyncio
async def test_from_app_preserves_app_name(sample_app):
    """Test that app.name is used correctly."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")
    assert adk_agent._static_app_name == "test_app"

@pytest.mark.asyncio
async def test_from_app_preserves_cleanup_options(sample_app):
    """Test that cleanup options are preserved."""
    adk_agent = ADKAgent.from_app(
        sample_app,
        user_id="test_user",
        delete_session_on_cleanup=False,
        save_session_to_memory_on_cleanup=False,
    )
    assert adk_agent._session_manager._delete_session_on_cleanup is False
    assert adk_agent._session_manager._save_session_to_memory_on_cleanup is False
    SessionManager.reset_instance()

    adk_agent = ADKAgent.from_app(
        sample_app,
        user_id="test_user",
        delete_session_on_cleanup=True,
        save_session_to_memory_on_cleanup=True,
    )
    assert adk_agent._session_manager._delete_session_on_cleanup is True
    assert adk_agent._session_manager._save_session_to_memory_on_cleanup is True
    SessionManager.reset_instance()

    adk_agent = ADKAgent.from_app(
        sample_app,
        user_id="test_user",
        delete_session_on_cleanup=False,
        save_session_to_memory_on_cleanup=True,
    )
    assert adk_agent._session_manager._delete_session_on_cleanup is False
    assert adk_agent._session_manager._save_session_to_memory_on_cleanup is True
    SessionManager.reset_instance()

    adk_agent = ADKAgent.from_app(
        sample_app,
        user_id="test_user",
        delete_session_on_cleanup=True,
        save_session_to_memory_on_cleanup=False,
    )
    assert adk_agent._session_manager._delete_session_on_cleanup is True
    assert adk_agent._session_manager._save_session_to_memory_on_cleanup is False
    SessionManager.reset_instance()

@pytest.mark.asyncio
async def test_from_app_stores_app_reference(sample_app):
    """Test that the App is stored for per-request use."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")
    assert adk_agent._app is sample_app


@pytest.mark.asyncio
async def test_from_app_with_custom_timeout():
    """Test that plugin_close_timeout is stored correctly."""
    agent = LlmAgent(
        name="test_agent",
        model=LIVE_TEST_MODEL,
        instruction="You are helpful.",
    )
    app = App(name="test_app", root_agent=agent)

    adk_agent = ADKAgent.from_app(
        app,
        user_id="test_user",
        plugin_close_timeout=15.0,
    )

    assert adk_agent._plugin_close_timeout == 15.0


@pytest.mark.asyncio
async def test_from_app_type_validation():
    """Test that from_app() validates the app parameter type."""
    with pytest.raises(TypeError, match="Expected App instance"):
        ADKAgent.from_app("not an app", user_id="test_user")


@pytest.mark.asyncio
async def test_from_app_extracts_root_agent(sample_app):
    """Test that root_agent is correctly extracted from App."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")
    assert adk_agent._adk_agent is sample_app.root_agent


@pytest.mark.asyncio
async def test_from_app_multi_turn_conversation(sample_app):
    """Test multi-turn conversation with from_app()."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user")
    thread_id = f"test_thread_{uuid.uuid4().hex[:8]}"

    # First turn
    input1 = RunAgentInput(
        thread_id=thread_id,
        run_id=f"run1_{uuid.uuid4().hex[:8]}",
        messages=[UserMessage(id="msg1", content="My name is Alice")],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )

    events1 = []
    async for event in adk_agent.run(input1):
        events1.append(event)

    assert any(e.type == EventType.RUN_FINISHED for e in events1)

    # Second turn - should maintain context
    input2 = RunAgentInput(
        thread_id=thread_id,
        run_id=f"run2_{uuid.uuid4().hex[:8]}",
        messages=[
            UserMessage(id="msg1", content="My name is Alice"),
            UserMessage(id="msg2", content="What is my name?"),
        ],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )

    events2 = []
    async for event in adk_agent.run(input2):
        events2.append(event)

    assert any(e.type == EventType.RUN_FINISHED for e in events2)

RED_PIXEL_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="
@pytest.mark.asyncio
async def test_from_app_with_valid_mime_type(sample_app):
    """Test multimodal input with valid MIME type (image/png) is accepted by Google API."""
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user_valid_mime")
    
    input_data = RunAgentInput(
        thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
        run_id=f"test_run_{uuid.uuid4().hex[:8]}",
        messages=[
            UserMessage(
                id="msg1",
                content=[
                    TextInputContent(text="What color is this? Reply briefly."),
                    BinaryInputContent(mime_type="image/png", data=RED_PIXEL_PNG_B64, filename="what_color_is_this.png"),
                ],
            )
        ],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )
    
    events = []
    async for event in adk_agent.run(input_data):
        events.append(event)
    event_types = [e.type for e in events]

    # Valid MIME type should work without errors
    assert EventType.RUN_STARTED in event_types
    assert EventType.RUN_FINISHED in event_types
    assert EventType.RUN_ERROR not in event_types


@pytest.mark.asyncio
async def test_from_app_with_unsupported_mime_type(sample_app):
    """Test that unsupported MIME type is gracefully ignored by Google API.
    
    Google API appears to ignore unsupported MIME types rather than rejecting them.
    This test verifies that the system handles this gracefully without crashing.
    """
    adk_agent = ADKAgent.from_app(sample_app, user_id="test_user_bad_mime")
    
    input_data = RunAgentInput(
        thread_id=f"test_thread_{uuid.uuid4().hex[:8]}",
        run_id=f"test_run_{uuid.uuid4().hex[:8]}",
        messages=[
            UserMessage(
                id="msg1",
                content=[
                    TextInputContent(text="What color is this? Reply briefly."),
                    BinaryInputContent(mime_type="image_pong", data=RED_PIXEL_PNG_B64, filename="what_color_is_this.pong"),
                ],
            )
        ],
        state={},
        tools=[],
        context=[],
        forwarded_props={},
    )
    
    events = []
    async for event in adk_agent.run(input_data):
        events.append(event)
    event_types = [e.type for e in events]
    
    # With save_input_blobs_as_artifacts=False, the invalid MIME type blob
    # reaches the Gemini API directly. The API may reject it (-> RUN_ERROR) or
    # gracefully ignore it (-> RUN_FINISHED) — either outcome is acceptable as
    # long as the run terminates cleanly with exactly one terminal event. The
    # AG-UI spec forbids more than one terminal event per run; see issue #1892.
    assert EventType.RUN_STARTED in event_types
    terminal_types = [
        t for t in event_types
        if t in (EventType.RUN_FINISHED, EventType.RUN_ERROR)
    ]
    assert len(terminal_types) == 1, (
        f"expected exactly one terminal event, got {terminal_types}"
    )

@pytest.mark.asyncio
async def test_runner_supports_plugin_close_timeout():
    """Test that runtime detection of plugin_close_timeout works."""
    agent = LlmAgent(
        name="test_agent",
        model=LIVE_TEST_MODEL,
        instruction="You are helpful.",
    )
    app = App(name="test_app", root_agent=agent)
    adk_agent = ADKAgent.from_app(app, user_id="test_user")

    # This should return True or False based on ADK version
    result = adk_agent._runner_supports_plugin_close_timeout()
    assert isinstance(result, bool)

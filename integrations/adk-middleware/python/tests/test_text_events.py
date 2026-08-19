#!/usr/bin/env python
"""Test text message event patterns and validation."""

import os
import asyncio
from pathlib import Path
from unittest.mock import MagicMock
import pytest
from ag_ui_adk.session_manager import SessionManager

from ag_ui.core import RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent
from google.adk.agents import Agent
from google.genai import types



@pytest.fixture(autouse=True)
def _isolate_session_manager():
    """Reset the SessionManager singleton around every test in this module.

    Several tests here drive the agent on the same `test_app:mock_test` thread with the
    same message id (`msg_1`). The singleton's processed-id map is not reset between
    them, so a later test's only message arrives already marked as seen and its run has
    nothing unseen to dispatch — the test then passes for the wrong reason.
    """
    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


async def test_message_events(llmock_server=None):
    """Test that we get proper message events with correct START/CONTENT/END patterns."""

    if not os.getenv("GOOGLE_API_KEY"):
        print("⚠️ GOOGLE_API_KEY not set - using mock test")
        return await test_with_mock()

    print("🧪 Testing with real Google ADK agent...")

    # Create real agent
    agent = Agent(
        name="test_agent",
        instruction="You are a helpful assistant. Keep responses brief."
    )

    # Create middleware with direct agent embedding
    adk_agent = ADKAgent(
        adk_agent=agent,
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
    )

    # Test input
    test_input = RunAgentInput(
        thread_id="test_thread",
        run_id="test_run",
        messages=[
            UserMessage(
                id="msg_1",
                role="user",
                content="Say hello in exactly 3 words."
            )
        ],
        state={},
        context=[],
        tools=[],
        forwarded_props={}
    )

    print("🚀 Running test request...")

    events = []
    text_message_events = []

    try:
        async for event in adk_agent.run(test_input):
            events.append(event)
            event_type = str(event.type)
            print(f"📧 {event_type}")

            # Track text message events specifically
            if "TEXT_MESSAGE" in event_type:
                text_message_events.append(event_type)

    except Exception as e:
        print(f"❌ Error during test: {e}")
        return False

    print(f"\n📊 Results:")
    print(f"   Total events: {len(events)}")
    print(f"   Text message events: {text_message_events}")

    # Analyze message event patterns
    start_count = text_message_events.count("EventType.TEXT_MESSAGE_START")
    end_count = text_message_events.count("EventType.TEXT_MESSAGE_END")
    content_count = text_message_events.count("EventType.TEXT_MESSAGE_CONTENT")

    print(f"   START events: {start_count}")
    print(f"   END events: {end_count}")
    print(f"   CONTENT events: {content_count}")

    return validate_message_event_pattern(start_count, end_count, content_count, text_message_events)


async def test_message_events_from_before_agent_callback():
    """Test that we get proper message events with correct START/CONTENT/END patterns,
    even if we return the message from before_agent_callback.
    """

    if not os.getenv("GOOGLE_API_KEY"):
        print("⚠️ GOOGLE_API_KEY not set - using mock test")
        return await test_with_mock()

    print("🧪 Testing with real Google ADK agent...")

    event_message = "This message was not generated."
    def return_predefined_message(callback_context):
        return types.Content(
            parts=[types.Part(text=event_message)],
            role="model"  # Assign model role to the overriding response
        )

    # Create real agent
    agent = Agent(
        name="test_agent",
        instruction="You are a helpful assistant. Keep responses brief.",
        before_agent_callback=return_predefined_message
    )

    # Create middleware with direct agent embedding
    adk_agent = ADKAgent(
        adk_agent=agent,
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
    )

    # Test input
    test_input = RunAgentInput(
        thread_id="test_thread",
        run_id="test_run",
        messages=[
            UserMessage(
                id="msg_1",
                role="user",
                content="Say hello in exactly 3 words."
            )
        ],
        state={},
        context=[],
        tools=[],
        forwarded_props={}
    )

    print("🚀 Running test request...")

    events = []
    text_message_events = []

    try:
        async for event in adk_agent.run(test_input):
            events.append(event)
            event_type = str(event.type)
            print(f"📧 {event_type}")

            # Track text message events specifically
            if "TEXT_MESSAGE" in event_type:
                text_message_events.append(event_type)

    except Exception as e:
        print(f"❌ Error during test: {e}")
        return False

    print(f"\n📊 Results:")
    print(f"   Total events: {len(events)}")
    print(f"   Text message events: {text_message_events}")

    # Analyze message event patterns
    start_count = text_message_events.count("EventType.TEXT_MESSAGE_START")
    end_count = text_message_events.count("EventType.TEXT_MESSAGE_END")
    content_count = text_message_events.count("EventType.TEXT_MESSAGE_CONTENT")

    print(f"   START events: {start_count}")
    print(f"   END events: {end_count}")
    print(f"   CONTENT events: {content_count}")

    pattern_is_valid = validate_message_event_pattern(start_count, end_count, content_count, text_message_events)
    if not pattern_is_valid:
        return False

    expected_text_events = [
        {
            "type": "EventType.TEXT_MESSAGE_START",
        },
        {
            "type": "EventType.TEXT_MESSAGE_CONTENT",
            "delta": event_message
        },
        {
            "type": "EventType.TEXT_MESSAGE_END",
        }
    ]
    return validate_message_events(events, expected_text_events)


def validate_message_events(events, expected_events):
    """Compare expected events by type and delta (if delta exists)."""
    # Filter events to only those specified in expected_events
    event_types_to_check = {expected["type"] for expected in expected_events}

    filtered_events = []
    for event in events:
        event_type_str = f"EventType.{event.type.value}"
        if event_type_str in event_types_to_check:
            filtered_events.append(event)

    if len(filtered_events) != len(expected_events):
        print(f"❌ Event count mismatch: expected {len(expected_events)}, got {len(filtered_events)}")
        return False

    for i, (event, expected) in enumerate(zip(filtered_events, expected_events)):
        # Check event type
        event_type_str = f"EventType.{event.type.value}"
        if event_type_str != expected["type"]:
            print(f"❌ Event {i}: type mismatch - expected {expected['type']}, got {event_type_str}")
            return False

        # Check delta if specified
        if "delta" in expected:
            if not hasattr(event, 'delta'):
                print(f"❌ Event {i}: expected delta field but event has none")
                return False
            if event.delta != expected["delta"]:
                print(f"❌ Event {i}: delta mismatch - expected '{expected['delta']}', got '{event.delta}'")
                return False

    print("✅ All expected events validated successfully")
    return True


def validate_message_event_pattern(start_count, end_count, content_count, text_message_events):
    """Validate that message events follow proper patterns."""

    # Check if we have any text message events at all
    if start_count == 0 and end_count == 0 and content_count == 0:
        print("⚠️ No text message events found - this may be expected for some responses")
        return True

    # Validate proper message boundaries
    if start_count > 0 or end_count > 0:
        # If we have START/END events, they must be balanced
        if start_count != end_count:
            print(f"❌ Unbalanced START/END events: {start_count} START, {end_count} END")
            return False

        # Each message should have: START -> CONTENT(s) -> END
        if start_count > 0 and content_count == 0:
            print("❌ Messages have START/END but no CONTENT events")
            return False

        # Validate sequence pattern
        if not validate_event_sequence(text_message_events):
            return False

        print(f"✅ Proper message event pattern: {start_count} messages with START/CONTENT/END")
        return True

    elif content_count > 0:
        # Only CONTENT events without START/END is not a valid pattern
        print("❌ Found CONTENT events without proper START/END boundaries")
        print("💡 Message events must have START and END boundaries for proper streaming")
        return False

    else:
        print("⚠️ Unexpected message event pattern")
        return False


def validate_event_sequence(text_message_events):
    """Validate that text message events follow proper START->CONTENT->END sequence."""
    if len(text_message_events) < 2:
        return True  # Too short to validate sequence

    # Check for invalid patterns
    prev_event = None
    for event in text_message_events:
        if event == "EventType.TEXT_MESSAGE_START":
            if prev_event == "EventType.TEXT_MESSAGE_START":
                print("❌ Found START->START pattern (invalid)")
                return False
        elif event == "EventType.TEXT_MESSAGE_END":
            if prev_event == "EventType.TEXT_MESSAGE_END":
                print("❌ Found END->END pattern (invalid)")
                return False
            if prev_event is None:
                print("❌ Found END without preceding START")
                return False

        prev_event = event

    print("✅ Event sequence validation passed")
    return True


async def test_with_mock():
    """Test with mock agent to verify basic structure."""
    print("🧪 Testing with mock agent (no API key)...")

    # Create real agent for structure
    agent = Agent(
        name="mock_test_agent",
        instruction="Mock agent for testing"
    )

    # Create middleware with direct agent embedding
    adk_agent = ADKAgent(
        adk_agent=agent,
        app_name="test_app",
        user_id="test_user",
        use_in_memory_services=True,
    )

    # Mock the runner to control output
    mock_runner = MagicMock()

    # Create mock ADK events that should produce proper START/CONTENT/END pattern
    mock_event_1 = MagicMock()
    mock_event_1.content = MagicMock()
    mock_event_1.content.parts = [MagicMock(text="Hello")]
    mock_event_1.author = "assistant"
    mock_event_1.partial = True
    mock_event_1.turn_complete = False
    mock_event_1.is_final_response = lambda: False
    mock_event_1.candidates = []

    mock_event_2 = MagicMock()
    mock_event_2.content = MagicMock()
    mock_event_2.content.parts = [MagicMock(text=" world")]
    mock_event_2.author = "assistant"
    mock_event_2.partial = True
    mock_event_2.turn_complete = False
    mock_event_2.is_final_response = lambda: False
    mock_event_2.candidates = []

    mock_event_3 = MagicMock()
    mock_event_3.content = MagicMock()
    mock_event_3.content.parts = [MagicMock(text="!")]
    mock_event_3.author = "assistant"
    mock_event_3.partial = False
    mock_event_3.turn_complete = True
    mock_event_3.is_final_response = lambda: True
    mock_event_3.candidates = [MagicMock(finish_reason="STOP")]

    async def mock_run_async(*args, **kwargs):
        yield mock_event_1
        yield mock_event_2
        yield mock_event_3

    mock_runner.run_async = mock_run_async
    adk_agent._get_or_create_runner = MagicMock(return_value=mock_runner)

    # Test input
    test_input = RunAgentInput(
        thread_id="mock_test",
        run_id="mock_run",
        messages=[
            UserMessage(
                id="msg_1",
                role="user",
                content="Test message"
            )
        ],
        state={},
        context=[],
        tools=[],
        forwarded_props={}
    )

    print("🚀 Running mock test...")

    events = []
    text_message_events = []

    try:
        async for event in adk_agent.run(test_input):
            events.append(event)
            event_type = str(event.type)

            # Track text message events specifically
            if "TEXT_MESSAGE" in event_type:
                text_message_events.append(event_type)
                print(f"📧 {event_type}")

    except Exception as e:
        print(f"❌ Error during mock test: {e}")
        return False

    print(f"\n📊 Mock Test Results:")
    print(f"   Total events: {len(events)}")
    print(f"   Text message events: {text_message_events}")

    # Validate the mock results
    start_count = text_message_events.count("EventType.TEXT_MESSAGE_START")
    end_count = text_message_events.count("EventType.TEXT_MESSAGE_END")
    content_count = text_message_events.count("EventType.TEXT_MESSAGE_CONTENT")

    print(f"   START events: {start_count}")
    print(f"   END events: {end_count}")
    print(f"   CONTENT events: {content_count}")

    if validate_message_event_pattern(start_count, end_count, content_count, text_message_events):
        print("✅ Mock test passed - proper event patterns generated")
        return True
    else:
        print("❌ Mock test failed - invalid event patterns")
        return False


async def test_edge_cases():
    """Test edge cases for message event patterns."""
    print("\n🧪 Testing edge cases...")

    # Test 1: Empty response (no text events expected)
    print("📝 Test case: Empty/no-text response")
    # This would simulate a case where agent doesn't produce text output
    text_message_events = []
    result1 = validate_message_event_pattern(0, 0, 0, text_message_events)
    print(f"   Empty response validation: {'✅ PASS' if result1 else '❌ FAIL'}")

    # Test 2: Single complete message
    print("📝 Test case: Single complete message")
    text_message_events = [
        "EventType.TEXT_MESSAGE_START",
        "EventType.TEXT_MESSAGE_CONTENT",
        "EventType.TEXT_MESSAGE_CONTENT",
        "EventType.TEXT_MESSAGE_END"
    ]
    result2 = validate_message_event_pattern(1, 1, 2, text_message_events)
    print(f"   Single message validation: {'✅ PASS' if result2 else '❌ FAIL'}")

    # Test 3: Invalid pattern - only CONTENT
    print("📝 Test case: Invalid pattern (only CONTENT events)")
    text_message_events = [
        "EventType.TEXT_MESSAGE_CONTENT",
        "EventType.TEXT_MESSAGE_CONTENT"
    ]
    result3 = validate_message_event_pattern(0, 0, 2, text_message_events)
    # This should fail
    print(f"   Content-only validation: {'✅ PASS (correctly rejected)' if not result3 else '❌ FAIL (should have been rejected)'}")

    # Test 4: Invalid pattern - unbalanced START/END
    print("📝 Test case: Invalid pattern (unbalanced START/END)")
    text_message_events = [
        "EventType.TEXT_MESSAGE_START",
        "EventType.TEXT_MESSAGE_CONTENT",
        "EventType.TEXT_MESSAGE_START"  # Missing END for first message
    ]
    result4 = validate_message_event_pattern(2, 0, 1, text_message_events)
    # This should fail
    print(f"   Unbalanced validation: {'✅ PASS (correctly rejected)' if not result4 else '❌ FAIL (should have been rejected)'}")

    # Return overall result
    return result1 and result2 and not result3 and not result4


@pytest.mark.asyncio
async def test_text_message_events(llmock_server):
    """Test that we get proper message events with correct START/CONTENT/END patterns."""
    result = await test_message_events()
    assert result, "Text message events test failed"


@pytest.mark.asyncio
async def test_text_message_events_from_before_agent_callback(llmock_server):
    """Test that we get proper message events with correct START/CONTENT/END patterns."""
    result = await test_message_events_from_before_agent_callback()
    assert result, "Text message events for before_agent_callback test failed"


@pytest.mark.asyncio
async def test_message_event_edge_cases():
    """Test edge cases for message event patterns."""
    result = await test_edge_cases()
    assert result, "Message event edge cases test failed"


# Keep the standalone script functionality for backwards compatibility
async def main():
    """Run all text message event tests."""
    print("🚀 Testing Text Message Event Patterns")
    print("=" * 45)

    tests = [
        ("Message Events", test_message_events),
        ("Edge Cases", test_edge_cases)
    ]

    results = []
    for test_name, test_func in tests:
        try:
            result = await test_func()
            results.append(result)
        except Exception as e:
            print(f"❌ Test {test_name} failed with exception: {e}")
            import traceback
            traceback.print_exc()
            results.append(False)

    print("\n" + "=" * 45)
    print("📊 Test Results:")

    for i, (test_name, result) in enumerate(zip([name for name, _ in tests], results), 1):
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"  {i}. {test_name}: {status}")

    passed = sum(results)
    total = len(results)

    if passed == total:
        print(f"\n🎉 All {total} text message event tests passed!")
        print("💡 Text message event patterns are working correctly")
    else:
        print(f"\n⚠️ {passed}/{total} tests passed")
        print("🔧 Review text message event implementation")

    return passed == total


if __name__ == "__main__":
    success = asyncio.run(main())
    import sys
    sys.exit(0 if success else 1)
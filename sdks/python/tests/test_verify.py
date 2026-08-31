import unittest

from ag_ui.core.events import (
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageChunkEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallChunkEvent,
    ToolCallResultEvent,
    StepStartedEvent,
    StepFinishedEvent,
    ThinkingStartEvent,
    ThinkingEndEvent,
    ThinkingTextMessageStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ReasoningStartEvent,
    ReasoningMessageStartEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageChunkEvent,
    ReasoningEndEvent,
    StateSnapshotEvent,
    StateDeltaEvent,
    MessagesSnapshotEvent,
    CustomEvent,
    RawEvent,
)
from ag_ui.verify import (
    EventSequenceError,
    EventSequenceValidator,
    validate_sequence,
    verify_events,
)


def _run_started(thread_id="t1", run_id="r1"):
    return RunStartedEvent(thread_id=thread_id, run_id=run_id)


def _run_finished(thread_id="t1", run_id="r1"):
    return RunFinishedEvent(thread_id=thread_id, run_id=run_id)


def _run_error(message="error"):
    return RunErrorEvent(message=message)


class TestRunLifecycle(unittest.TestCase):
    """Test run lifecycle validation rules."""

    def test_valid_run_lifecycle(self):
        validate_sequence([_run_started(), _run_finished()])

    def test_first_event_must_be_run_started_or_run_error(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                TextMessageStartEvent(message_id="m1", role="assistant"),
            ])

    def test_run_error_as_first_event(self):
        validate_sequence([_run_error()])

    def test_no_events_after_run_error(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                _run_error(),
                _run_finished(),
            ])

    def test_no_events_after_run_finished_except_run_started(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                _run_finished(),
                TextMessageStartEvent(message_id="m1", role="assistant"),
            ])

    def test_cannot_start_run_while_active(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                _run_started(),
            ])

    def test_run_error_allowed_after_run_finished(self):
        validate_sequence([
            _run_started(),
            _run_finished(),
            _run_error(),
        ])

    def test_multiple_sequential_runs(self):
        validate_sequence([
            _run_started(run_id="r1"),
            _run_finished(run_id="r1"),
            _run_started(run_id="r2"),
            _run_finished(run_id="r2"),
        ])


class TestTextMessageLifecycle(unittest.TestCase):
    """Test text message lifecycle validation rules."""

    def test_valid_message_lifecycle(self):
        validate_sequence([
            _run_started(),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="hello"),
            TextMessageEndEvent(message_id="m1"),
            _run_finished(),
        ])

    def test_duplicate_message_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                TextMessageStartEvent(message_id="m1", role="assistant"),
                TextMessageStartEvent(message_id="m1", role="assistant"),
            ])

    def test_content_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                TextMessageContentEvent(message_id="m1", delta="hello"),
            ])

    def test_end_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                TextMessageEndEvent(message_id="m1"),
            ])

    def test_concurrent_messages_different_ids(self):
        validate_sequence([
            _run_started(),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageStartEvent(message_id="m2", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="hello"),
            TextMessageContentEvent(message_id="m2", delta="world"),
            TextMessageEndEvent(message_id="m1"),
            TextMessageEndEvent(message_id="m2"),
            _run_finished(),
        ])

    def test_content_after_end(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                TextMessageStartEvent(message_id="m1", role="assistant"),
                TextMessageEndEvent(message_id="m1"),
                TextMessageContentEvent(message_id="m1", delta="hello"),
            ])

    def test_chunk_events_always_allowed(self):
        validate_sequence([
            _run_started(),
            TextMessageChunkEvent(message_id="m1", role="assistant", delta="hello"),
            _run_finished(),
        ])

    def test_multiple_sequential_messages(self):
        validate_sequence([
            _run_started(),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="first"),
            TextMessageEndEvent(message_id="m1"),
            TextMessageStartEvent(message_id="m2", role="assistant"),
            TextMessageContentEvent(message_id="m2", delta="second"),
            TextMessageEndEvent(message_id="m2"),
            _run_finished(),
        ])

    def test_tool_call_during_text_message(self):
        """Tool calls can start while a text message is active."""
        validate_sequence([
            _run_started(),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="searching..."),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallArgsEvent(tool_call_id="tc1", delta='{"q": "test"}'),
            ToolCallEndEvent(tool_call_id="tc1"),
            TextMessageContentEvent(message_id="m1", delta="done"),
            TextMessageEndEvent(message_id="m1"),
            _run_finished(),
        ])

    def test_pass_through_events_inside_text_message(self):
        """RAW, CUSTOM, STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT are allowed inside messages."""
        validate_sequence([
            _run_started(),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            RawEvent(event={"data": "raw"}),
            CustomEvent(name="custom", value=1),
            StateSnapshotEvent(snapshot={"key": "val"}),
            StateDeltaEvent(delta=[{"op": "replace", "path": "/k", "value": "v"}]),
            MessagesSnapshotEvent(messages=[]),
            TextMessageContentEvent(message_id="m1", delta="hello"),
            TextMessageEndEvent(message_id="m1"),
            _run_finished(),
        ])


class TestToolCallLifecycle(unittest.TestCase):
    """Test tool call lifecycle validation rules."""

    def test_valid_tool_call_lifecycle(self):
        validate_sequence([
            _run_started(),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallArgsEvent(tool_call_id="tc1", delta='{"q": "test"}'),
            ToolCallEndEvent(tool_call_id="tc1"),
            _run_finished(),
        ])

    def test_duplicate_tool_call_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
                ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ])

    def test_args_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ToolCallArgsEvent(tool_call_id="tc1", delta="{}"),
            ])

    def test_end_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ToolCallEndEvent(tool_call_id="tc1"),
            ])

    def test_concurrent_tool_calls(self):
        validate_sequence([
            _run_started(),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallStartEvent(tool_call_id="tc2", tool_call_name="fetch"),
            ToolCallArgsEvent(tool_call_id="tc1", delta='{"q": "a"}'),
            ToolCallArgsEvent(tool_call_id="tc2", delta='{"url": "b"}'),
            ToolCallEndEvent(tool_call_id="tc1"),
            ToolCallEndEvent(tool_call_id="tc2"),
            _run_finished(),
        ])

    def test_chunk_and_result_events_always_allowed(self):
        validate_sequence([
            _run_started(),
            ToolCallChunkEvent(tool_call_id="tc1", delta="hello"),
            ToolCallResultEvent(
                message_id="msg1", tool_call_id="tc1", content="result"
            ),
            _run_finished(),
        ])

    def test_multiple_sequential_tool_calls(self):
        validate_sequence([
            _run_started(),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallEndEvent(tool_call_id="tc1"),
            ToolCallStartEvent(tool_call_id="tc2", tool_call_name="fetch"),
            ToolCallEndEvent(tool_call_id="tc2"),
            _run_finished(),
        ])

    def test_text_message_during_tool_call(self):
        """Text messages can start while a tool call is active."""
        validate_sequence([
            _run_started(),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallArgsEvent(tool_call_id="tc1", delta='{"q": "test"}'),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="searching"),
            TextMessageEndEvent(message_id="m1"),
            ToolCallEndEvent(tool_call_id="tc1"),
            _run_finished(),
        ])

    def test_pass_through_events_inside_tool_call(self):
        """RAW, CUSTOM, STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT are allowed inside tool calls."""
        validate_sequence([
            _run_started(),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            RawEvent(event={"data": "raw"}),
            CustomEvent(name="custom", value=1),
            StateSnapshotEvent(snapshot={"key": "val"}),
            StateDeltaEvent(delta=[{"op": "replace", "path": "/k", "value": "v"}]),
            MessagesSnapshotEvent(messages=[]),
            ToolCallArgsEvent(tool_call_id="tc1", delta='{}'),
            ToolCallEndEvent(tool_call_id="tc1"),
            _run_finished(),
        ])


class TestStepLifecycle(unittest.TestCase):
    """Test step lifecycle validation rules."""

    def test_valid_step_lifecycle(self):
        validate_sequence([
            _run_started(),
            StepStartedEvent(step_name="step1"),
            StepFinishedEvent(step_name="step1"),
            _run_finished(),
        ])

    def test_duplicate_step_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                StepStartedEvent(step_name="step1"),
                StepStartedEvent(step_name="step1"),
            ])

    def test_finish_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                StepFinishedEvent(step_name="step1"),
            ])

    def test_concurrent_steps(self):
        validate_sequence([
            _run_started(),
            StepStartedEvent(step_name="step1"),
            StepStartedEvent(step_name="step2"),
            StepFinishedEvent(step_name="step1"),
            StepFinishedEvent(step_name="step2"),
            _run_finished(),
        ])


class TestThinkingLifecycle(unittest.TestCase):
    """Test thinking lifecycle validation rules."""

    def test_valid_thinking_lifecycle(self):
        validate_sequence([
            _run_started(),
            ThinkingStartEvent(),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta="thinking..."),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent(),
            _run_finished(),
        ])

    def test_duplicate_thinking_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ThinkingStartEvent(),
                ThinkingStartEvent(),
            ])

    def test_thinking_end_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ThinkingEndEvent(),
            ])

    def test_thinking_message_without_thinking_step(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ThinkingTextMessageStartEvent(),
            ])

    def test_duplicate_thinking_message_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ThinkingStartEvent(),
                ThinkingTextMessageStartEvent(),
                ThinkingTextMessageStartEvent(),
            ])

    def test_thinking_message_content_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ThinkingStartEvent(),
                ThinkingTextMessageContentEvent(delta="hello"),
            ])

    def test_thinking_message_end_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ThinkingStartEvent(),
                ThinkingTextMessageEndEvent(),
            ])


class TestReasoningMessageLifecycle(unittest.TestCase):
    """Test reasoning message lifecycle validation rules."""

    def test_valid_reasoning_message_lifecycle(self):
        validate_sequence([
            _run_started(),
            ReasoningStartEvent(message_id="r1"),
            ReasoningMessageStartEvent(message_id="rm1", role="reasoning"),
            ReasoningMessageContentEvent(message_id="rm1", delta="thinking..."),
            ReasoningMessageEndEvent(message_id="rm1"),
            ReasoningEndEvent(message_id="r1"),
            _run_finished(),
        ])

    def test_duplicate_reasoning_message_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ReasoningMessageStartEvent(message_id="rm1", role="reasoning"),
                ReasoningMessageStartEvent(message_id="rm1", role="reasoning"),
            ])

    def test_reasoning_content_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ReasoningMessageContentEvent(message_id="rm1", delta="hello"),
            ])

    def test_reasoning_end_without_start(self):
        with self.assertRaises(EventSequenceError):
            validate_sequence([
                _run_started(),
                ReasoningMessageEndEvent(message_id="rm1"),
            ])

    def test_concurrent_reasoning_messages(self):
        validate_sequence([
            _run_started(),
            ReasoningMessageStartEvent(message_id="rm1", role="reasoning"),
            ReasoningMessageStartEvent(message_id="rm2", role="reasoning"),
            ReasoningMessageContentEvent(message_id="rm1", delta="a"),
            ReasoningMessageContentEvent(message_id="rm2", delta="b"),
            ReasoningMessageEndEvent(message_id="rm1"),
            ReasoningMessageEndEvent(message_id="rm2"),
            _run_finished(),
        ])

    def test_chunk_events_always_allowed(self):
        validate_sequence([
            _run_started(),
            ReasoningMessageChunkEvent(message_id="rm1", delta="hello"),
            _run_finished(),
        ])


class TestRunFinishedGuards(unittest.TestCase):
    """Test that RUN_FINISHED is blocked when resources are still active."""

    def test_unfinished_step_blocks_run_finished(self):
        with self.assertRaises(EventSequenceError) as ctx:
            validate_sequence([
                _run_started(),
                StepStartedEvent(step_name="step1"),
                _run_finished(),
            ])
        self.assertIn("step1", str(ctx.exception))

    def test_unfinished_message_blocks_run_finished(self):
        with self.assertRaises(EventSequenceError) as ctx:
            validate_sequence([
                _run_started(),
                TextMessageStartEvent(message_id="m1", role="assistant"),
                _run_finished(),
            ])
        self.assertIn("m1", str(ctx.exception))

    def test_unfinished_tool_call_blocks_run_finished(self):
        with self.assertRaises(EventSequenceError) as ctx:
            validate_sequence([
                _run_started(),
                ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
                _run_finished(),
            ])
        self.assertIn("tc1", str(ctx.exception))

    def test_active_reasoning_does_not_block_run_finished(self):
        """Reasoning messages intentionally do not block RUN_FINISHED."""
        validate_sequence([
            _run_started(),
            ReasoningMessageStartEvent(message_id="rm1", role="reasoning"),
            _run_finished(),
        ])


class TestPassThroughEvents(unittest.TestCase):
    """Test that events without lifecycle rules always pass through."""

    def test_state_snapshot(self):
        validate_sequence([
            _run_started(),
            StateSnapshotEvent(snapshot={"key": "value"}),
            _run_finished(),
        ])

    def test_state_delta(self):
        validate_sequence([
            _run_started(),
            StateDeltaEvent(delta=[{"op": "replace", "path": "/key", "value": "v"}]),
            _run_finished(),
        ])

    def test_custom_event(self):
        validate_sequence([
            _run_started(),
            CustomEvent(name="my_event", value={"data": 123}),
            _run_finished(),
        ])

    def test_raw_event(self):
        validate_sequence([
            _run_started(),
            RawEvent(event={"arbitrary": "data"}),
            _run_finished(),
        ])

    def test_reasoning_start_end_pass_through(self):
        validate_sequence([
            _run_started(),
            ReasoningStartEvent(message_id="r1"),
            ReasoningEndEvent(message_id="r1"),
            _run_finished(),
        ])


class TestVerifyEventsIterator(unittest.TestCase):
    """Test the verify_events streaming iterator."""

    def test_yields_valid_events(self):
        events = [
            _run_started(),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="hello"),
            TextMessageEndEvent(message_id="m1"),
            _run_finished(),
        ]
        result = list(verify_events(events))
        self.assertEqual(len(result), 5)

    def test_raises_mid_stream(self):
        events = [
            _run_started(),
            TextMessageContentEvent(message_id="m1", delta="no start"),
        ]
        iterator = verify_events(events)
        next(iterator)  # RUN_STARTED should pass
        with self.assertRaises(EventSequenceError):
            next(iterator)  # TEXT_MESSAGE_CONTENT without start should fail

    def test_partial_consumption(self):
        """Events before the violation should have been yielded."""
        events = [
            _run_started(),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="hello"),
            TextMessageContentEvent(message_id="bad", delta="no start"),
        ]
        collected = []
        with self.assertRaises(EventSequenceError):
            for event in verify_events(events):
                collected.append(event)
        self.assertEqual(len(collected), 3)


class TestValidatorReset(unittest.TestCase):
    """Test the validator reset functionality."""

    def test_reset_allows_reuse(self):
        validator = EventSequenceValidator()
        validator.validate_event(_run_started())
        validator.validate_event(_run_finished())

        validator.reset()

        # Should work again after reset
        validator.validate_event(_run_started())
        validator.validate_event(_run_finished())


class TestComplexSequences(unittest.TestCase):
    """Test complex event sequences combining multiple lifecycles."""

    def test_full_agent_interaction(self):
        """Simulate a complete agent interaction with steps, messages, and tool calls."""
        validate_sequence([
            _run_started(),
            StepStartedEvent(step_name="planning"),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="Let me search for that."),
            TextMessageEndEvent(message_id="m1"),
            StepFinishedEvent(step_name="planning"),
            StepStartedEvent(step_name="execution"),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallArgsEvent(tool_call_id="tc1", delta='{"query": "test"}'),
            ToolCallEndEvent(tool_call_id="tc1"),
            TextMessageStartEvent(message_id="m2", role="assistant"),
            TextMessageContentEvent(message_id="m2", delta="Here are the results."),
            TextMessageEndEvent(message_id="m2"),
            StepFinishedEvent(step_name="execution"),
            _run_finished(),
        ])

    def test_empty_sequence(self):
        """An empty sequence should be valid."""
        validate_sequence([])

    def test_complex_concurrent_scenario(self):
        """Many overlapping messages, tool calls, and steps in one run."""
        validate_sequence([
            _run_started(),
            StepStartedEvent(step_name="plan"),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="I'll search"),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallArgsEvent(tool_call_id="tc1", delta='{"q": "a"}'),
            TextMessageStartEvent(message_id="m2", role="assistant"),
            TextMessageContentEvent(message_id="m2", delta="Also fetching"),
            ToolCallStartEvent(tool_call_id="tc2", tool_call_name="fetch"),
            ToolCallArgsEvent(tool_call_id="tc2", delta='{"url": "b"}'),
            StateSnapshotEvent(snapshot={"progress": 50}),
            ToolCallEndEvent(tool_call_id="tc1"),
            TextMessageEndEvent(message_id="m1"),
            ToolCallEndEvent(tool_call_id="tc2"),
            TextMessageEndEvent(message_id="m2"),
            StepFinishedEvent(step_name="plan"),
            _run_finished(),
        ])

    def test_multiple_runs_complex(self):
        """Complex scenario with multiple runs and various event types."""
        validate_sequence([
            _run_started(run_id="r1"),
            StepStartedEvent(step_name="step1"),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="hello"),
            TextMessageEndEvent(message_id="m1"),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallEndEvent(tool_call_id="tc1"),
            StepFinishedEvent(step_name="step1"),
            _run_finished(run_id="r1"),
            # Second run reuses all IDs
            _run_started(run_id="r2"),
            StepStartedEvent(step_name="step1"),
            TextMessageStartEvent(message_id="m1", role="assistant"),
            TextMessageContentEvent(message_id="m1", delta="world"),
            TextMessageEndEvent(message_id="m1"),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search"),
            ToolCallEndEvent(tool_call_id="tc1"),
            StepFinishedEvent(step_name="step1"),
            _run_finished(run_id="r2"),
        ])


if __name__ == "__main__":
    unittest.main()

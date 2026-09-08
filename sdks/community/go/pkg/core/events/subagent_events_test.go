package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestSubagentStartedEventRoundTrip verifies the spawning links survive a decode.
func TestSubagentStartedEventRoundTrip(t *testing.T) {
	event := NewSubagentStartedEvent(
		"sub-1",
		"researcher",
		WithSubagentDescription("looks things up"),
		WithParentSubagentRunID("sub-0"),
		WithParentToolCall("tc-1", "msg-1"),
	)
	require.NoError(t, event.Validate())

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	var wire map[string]any
	require.NoError(t, json.Unmarshal(encoded, &wire))
	assert.Equal(t, "SUBAGENT_STARTED", wire["type"])
	assert.Equal(t, "sub-1", wire["subagentRunId"])
	assert.Equal(t, "researcher", wire["name"])
	assert.Equal(t, "looks things up", wire["description"])
	assert.Equal(t, "sub-0", wire["parentSubagentRunId"])
	assert.Equal(t, "tc-1", wire["parentToolCallId"])
	assert.Equal(t, "msg-1", wire["parentMessageId"])

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)
	require.IsType(t, &SubagentStartedEvent{}, decoded)
	assert.Equal(t, event.ParentToolCallID, decoded.(*SubagentStartedEvent).ParentToolCallID)
}

// TestSubagentStartedEventValidation verifies the two required fields.
func TestSubagentStartedEventValidation(t *testing.T) {
	event := NewSubagentStartedEvent("", "researcher")
	assertErrorContains(t, event.Validate(), "subagentRunId field is required")

	event = NewSubagentStartedEvent("sub-1", "")
	assertErrorContains(t, event.Validate(), "name field is required")
}

// TestSubagentStartedEventOptionalFieldsOmitted verifies absent is the only spelling
// for a field with no value, since the subagent surface tolerates no nulls.
func TestSubagentStartedEventOptionalFieldsOmitted(t *testing.T) {
	encoded, err := NewSubagentStartedEvent("sub-1", "researcher").ToJSON()
	require.NoError(t, err)

	var wire map[string]any
	require.NoError(t, json.Unmarshal(encoded, &wire))
	for _, key := range []string{"description", "parentSubagentRunId", "parentToolCallId", "parentMessageId"} {
		assert.NotContains(t, wire, key)
	}
}

// TestSubagentFinishedEventSuspendedOutcome verifies the suspended variant carries
// the interrupts the subagent owns.
func TestSubagentFinishedEventSuspendedOutcome(t *testing.T) {
	event := NewSubagentFinishedEvent("sub-1", WithSubagentSuspendedOutcome([]string{"int-1"}))
	require.NoError(t, event.Validate())

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)

	finished, ok := decoded.(*SubagentFinishedEvent)
	require.True(t, ok)
	require.NotNil(t, finished.Outcome)
	assert.Equal(t, SubagentFinishedOutcomeTypeSuspended, finished.Outcome.Type)
	assert.Equal(t, []string{"int-1"}, finished.Outcome.InterruptIDs)
}

// TestSubagentFinishedEventSuccessOutcomeDropsInterruptIDs verifies a success outcome
// never carries interruptIds, which the TypeScript schema rejects outright.
func TestSubagentFinishedEventSuccessOutcomeDropsInterruptIDs(t *testing.T) {
	event := NewSubagentFinishedEvent("sub-1", WithSubagentResult(map[string]any{"answer": 42}))
	event.Outcome = &SubagentFinishedOutcome{
		Type:         SubagentFinishedOutcomeTypeSuccess,
		InterruptIDs: []string{"int-1"},
	}

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	var wire struct {
		Outcome map[string]any `json:"outcome"`
	}
	require.NoError(t, json.Unmarshal(encoded, &wire))
	assert.Equal(t, "success", wire.Outcome["type"])
	assert.NotContains(t, wire.Outcome, "interruptIds")
}

// TestSubagentFinishedEventOmittedOutcome verifies an absent outcome stays absent,
// which reads as legacy success.
func TestSubagentFinishedEventOmittedOutcome(t *testing.T) {
	encoded, err := NewSubagentFinishedEvent("sub-1").ToJSON()
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "outcome")

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)
	assert.Nil(t, decoded.(*SubagentFinishedEvent).Outcome)
}

// TestSubagentErrorEvent verifies the error event round-trips and validates.
func TestSubagentErrorEvent(t *testing.T) {
	event := NewSubagentErrorEvent("sub-1", "boom", WithSubagentErrorCode("E_TOOL"))
	require.NoError(t, event.Validate())

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)

	errored, ok := decoded.(*SubagentErrorEvent)
	require.True(t, ok)
	assert.Equal(t, "sub-1", errored.SubagentRunID)
	assert.Equal(t, "boom", errored.Message)
	require.NotNil(t, errored.Code)
	assert.Equal(t, "E_TOOL", *errored.Code)

	assertErrorContains(t, NewSubagentErrorEvent("sub-1", "").Validate(), "message field is required")
	assertErrorContains(t, NewSubagentErrorEvent("", "boom").Validate(), "subagentRunId field is required")
}

// TestSubagentRunIDAttribution verifies an ordinary event can be attributed to a
// subagent, and stays unattributed when it comes from the root agent.
func TestSubagentRunIDAttribution(t *testing.T) {
	event := NewTextMessageStartEvent("msg-1")
	event.SubagentRunID = "sub-1"

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)
	assert.Equal(t, "sub-1", decoded.(*TextMessageStartEvent).SubagentRunID)

	rootEncoded, err := NewTextMessageStartEvent("msg-2").ToJSON()
	require.NoError(t, err)
	assert.NotContains(t, string(rootEncoded), "subagentRunId")
}

// TestSubagentEventTypesAreValid verifies the three types are registered, so
// BaseEvent.Validate accepts them.
func TestSubagentEventTypesAreValid(t *testing.T) {
	for _, eventType := range []EventType{EventTypeSubagentStarted, EventTypeSubagentFinished, EventTypeSubagentError} {
		assert.True(t, isValidEventType(eventType), string(eventType))
	}
}

// TestValidateSequenceSubagentLifecycle verifies a subagent must start before it
// finishes, and cannot start twice.
func TestValidateSequenceSubagentLifecycle(t *testing.T) {
	valid := []Event{
		NewRunStartedEvent("thread-1", "run-1"),
		NewSubagentStartedEvent("sub-1", "researcher"),
		NewSubagentFinishedEvent("sub-1", WithSubagentSuccessOutcome()),
		NewRunFinishedEvent("thread-1", "run-1"),
	}
	assert.NoError(t, ValidateSequence(valid))

	finishWithoutStart := []Event{
		NewRunStartedEvent("thread-1", "run-1"),
		NewSubagentFinishedEvent("sub-1"),
	}
	assertErrorContains(t, ValidateSequence(finishWithoutStart), "cannot finish subagent sub-1 that was not started")

	startedTwice := []Event{
		NewRunStartedEvent("thread-1", "run-1"),
		NewSubagentStartedEvent("sub-1", "researcher"),
		NewSubagentStartedEvent("sub-1", "researcher"),
	}
	assertErrorContains(t, ValidateSequence(startedTwice), "subagent sub-1 already started")
}

// TestValidateSequenceSubagentErrorEndsInvocation verifies a subagent can error
// without having been announced, and that the error closes the invocation.
func TestValidateSequenceSubagentErrorEndsInvocation(t *testing.T) {
	unannounced := []Event{
		NewRunStartedEvent("thread-1", "run-1"),
		NewSubagentErrorEvent("sub-1", "boom"),
	}
	assert.NoError(t, ValidateSequence(unannounced))

	reused := []Event{
		NewRunStartedEvent("thread-1", "run-1"),
		NewSubagentStartedEvent("sub-1", "researcher"),
		NewSubagentErrorEvent("sub-1", "boom"),
		NewSubagentStartedEvent("sub-1", "researcher"),
	}
	assert.NoError(t, ValidateSequence(reused))
}

// assertErrorContains asserts err is non-nil and its message contains want. The
// module's testify version predates assert.ErrorContains.
func assertErrorContains(t *testing.T, err error, want string) {
	t.Helper()

	if assert.Error(t, err) {
		assert.Contains(t, err.Error(), want)
	}
}

package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

// TestRunFinishedSuccessOutcomeDropsInterrupts verifies a success outcome never
// carries interrupts, which the peer SDKs reject as an unknown key.
func TestRunFinishedSuccessOutcomeDropsInterrupts(t *testing.T) {
	event := NewRunFinishedEvent("thread-1", "run-1")
	event.Outcome = &RunFinishedOutcome{
		Type:       RunFinishedOutcomeTypeSuccess,
		Interrupts: []types.Interrupt{{ID: "int-1", Reason: "tool_call"}},
	}

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	var wire struct {
		Outcome map[string]any `json:"outcome"`
	}
	require.NoError(t, json.Unmarshal(encoded, &wire))
	assert.Equal(t, "success", wire.Outcome["type"])
	assert.NotContains(t, wire.Outcome, "interrupts")
}

// TestRunFinishedInterruptOutcomeKeepsInterrupts verifies the guard leaves the
// variant that owns the field alone.
func TestRunFinishedInterruptOutcomeKeepsInterrupts(t *testing.T) {
	interrupts := []types.Interrupt{{ID: "int-1", Reason: "tool_call"}}
	event := NewRunFinishedEventWithOptions("thread-1", "run-1", WithInterruptOutcome(interrupts))
	require.NoError(t, event.Validate())

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)

	finished, ok := decoded.(*RunFinishedEvent)
	require.True(t, ok)
	require.NotNil(t, finished.Outcome)
	assert.Equal(t, RunFinishedOutcomeTypeInterrupt, finished.Outcome.Type)
	require.Len(t, finished.Outcome.Interrupts, 1)
	assert.Equal(t, "int-1", finished.Outcome.Interrupts[0].ID)
}

// TestRunFinishedInterruptOutcomeRequiresInterrupts verifies an interrupt outcome
// with nothing in it is rejected, rather than emitting a bare {"type":"interrupt"}
// that the peer SDKs read as missing a required field.
func TestRunFinishedInterruptOutcomeRequiresInterrupts(t *testing.T) {
	empty := NewRunFinishedEventWithOptions("thread-1", "run-1", WithInterruptOutcome([]types.Interrupt{}))
	err := empty.Validate()
	if assert.Error(t, err) {
		assert.Contains(t, err.Error(), "outcome 'interrupt' requires at least one interrupt")
	}

	nilList := NewRunFinishedEventWithOptions("thread-1", "run-1", WithInterruptOutcome(nil))
	assert.Error(t, nilList.Validate())
}

// TestRunFinishedOutcomeUnaffectedCases verifies the guards leave every valid
// shape alone, including an omitted outcome.
func TestRunFinishedOutcomeUnaffectedCases(t *testing.T) {
	success := NewRunFinishedEventWithOptions("thread-1", "run-1", WithSuccessOutcome())
	require.NoError(t, success.Validate())

	encoded, err := success.ToJSON()
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"outcome":{"type":"success"}`)

	omitted := NewRunFinishedEvent("thread-1", "run-1")
	require.NoError(t, omitted.Validate())

	encoded, err = omitted.ToJSON()
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "outcome")
}

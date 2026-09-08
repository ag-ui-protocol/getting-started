package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestRunFinishedUsageRoundTrip verifies usage survives a decode with the wire
// names the peer SDKs use.
func TestRunFinishedUsageRoundTrip(t *testing.T) {
	usage := []TokenUsage{
		{
			Provider:          "google",
			Model:             "gemini-3.5-flash",
			InputTokens:       TokenCount(12),
			OutputTokens:      TokenCount(4),
			TotalTokens:       TokenCount(16),
			CachedInputTokens: TokenCount(0),
		},
		{Provider: "openai", Model: "gpt-5", InputTokens: TokenCount(7)},
	}

	event := NewRunFinishedEventWithOptions("thread-1", "run-1", WithUsage(usage))
	require.NoError(t, event.Validate())

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	var wire struct {
		Usage []map[string]any `json:"usage"`
	}
	require.NoError(t, json.Unmarshal(encoded, &wire))
	require.Len(t, wire.Usage, 2)
	assert.Equal(t, "google", wire.Usage[0]["provider"])
	assert.Equal(t, float64(12), wire.Usage[0]["inputTokens"])
	assert.Equal(t, float64(4), wire.Usage[0]["outputTokens"])

	// Zero is meaningful data, so it is written rather than dropped.
	assert.Equal(t, float64(0), wire.Usage[0]["cachedInputTokens"])

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)
	finished, ok := decoded.(*RunFinishedEvent)
	require.True(t, ok)
	assert.Equal(t, usage, finished.Usage)
}

// TestUsageOmittedWhenAbsent verifies a run with no usage writes no key.
func TestUsageOmittedWhenAbsent(t *testing.T) {
	encoded, err := NewRunFinishedEvent("thread-1", "run-1").ToJSON()
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "usage")

	encoded, err = NewRunErrorEvent("boom").ToJSON()
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "usage")
}

// TestUnreportedCountOmitted verifies an unreported count is absent rather than
// written as zero, which would claim the model produced none.
func TestUnreportedCountOmitted(t *testing.T) {
	event := NewRunFinishedEventWithOptions("thread-1", "run-1",
		WithUsage([]TokenUsage{{InputTokens: TokenCount(12)}}))

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	var wire struct {
		Usage []map[string]any `json:"usage"`
	}
	require.NoError(t, json.Unmarshal(encoded, &wire))
	require.Len(t, wire.Usage, 1)
	assert.Contains(t, wire.Usage[0], "inputTokens")
	assert.NotContains(t, wire.Usage[0], "outputTokens")
}

// TestRunErrorUsageRoundTrip verifies a failed run can report partial usage.
func TestRunErrorUsageRoundTrip(t *testing.T) {
	event := NewRunErrorEvent("boom", WithErrorUsage([]TokenUsage{{Provider: "google", InputTokens: TokenCount(12)}}))
	require.NoError(t, event.Validate())

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)
	errored, ok := decoded.(*RunErrorEvent)
	require.True(t, ok)
	require.Len(t, errored.Usage, 1)
	require.NotNil(t, errored.Usage[0].InputTokens)
	assert.Equal(t, int64(12), *errored.Usage[0].InputTokens)
}

// TestUsageRejectsNegativeCounts verifies a negative count is caught at the
// source, since the peer SDKs constrain every count to non-negative.
func TestUsageRejectsNegativeCounts(t *testing.T) {
	finished := NewRunFinishedEventWithOptions("thread-1", "run-1",
		WithUsage([]TokenUsage{{InputTokens: TokenCount(1)}, {OutputTokens: TokenCount(-1)}}))
	err := finished.Validate()
	if assert.Error(t, err) {
		assert.Contains(t, err.Error(), "usage[1]")
		assert.Contains(t, err.Error(), "outputTokens must not be negative")
	}

	errored := NewRunErrorEvent("boom", WithErrorUsage([]TokenUsage{{TotalTokens: TokenCount(-5)}}))
	assert.Error(t, errored.Validate())
}

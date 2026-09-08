package events

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

// TestEventMetadataRoundTrip verifies metadata declared on BaseEvent survives a
// marshal/unmarshal cycle on a concrete event.
func TestEventMetadataRoundTrip(t *testing.T) {
	event := NewTextMessageStartEvent("msg-1")
	event.Metadata = types.Metadata{
		types.AGUIMetadataKey: map[string]any{"nodePath": "root/child"},
		"tokenUsage":          map[string]any{"input": float64(12)},
	}

	encoded, err := event.ToJSON()
	require.NoError(t, err)

	decoded, err := EventFromJSON(encoded)
	require.NoError(t, err)

	assert.Equal(t, event.Metadata, decoded.GetBaseEvent().Metadata)
}

// TestEventUnmarshalMetadataNullAndAbsent verifies an explicit null metadata object
// decodes the same as an absent one, and neither is written back out.
func TestEventUnmarshalMetadataNullAndAbsent(t *testing.T) {
	for name, payload := range map[string]string{
		"null":   `{"type": "TEXT_MESSAGE_START", "messageId": "msg-1", "metadata": null}`,
		"absent": `{"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}`,
	} {
		t.Run(name, func(t *testing.T) {
			decoded, err := EventFromJSON([]byte(payload))
			require.NoError(t, err)
			assert.Nil(t, decoded.GetBaseEvent().Metadata)

			encoded, err := decoded.ToJSON()
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), "metadata")
		})
	}
}

// TestEventMetadataPreservesNullValues verifies a null under a key is data, unlike a
// null in place of the whole object.
func TestEventMetadataPreservesNullValues(t *testing.T) {
	payload := []byte(`{
		"type": "RUN_FINISHED",
		"threadId": "thread-1",
		"runId": "run-1",
		"metadata": {"finishReason": null}
	}`)

	decoded, err := EventFromJSON(payload)
	require.NoError(t, err)

	metadata := decoded.GetBaseEvent().Metadata
	require.NotNil(t, metadata)
	value, ok := metadata["finishReason"]
	assert.True(t, ok)
	assert.Nil(t, value)
}

// TestBaseEventToJSONIncludesMetadata verifies the hand-rolled BaseEvent serializer
// carries metadata, since it does not go through the struct tags.
func TestBaseEventToJSONIncludesMetadata(t *testing.T) {
	base := NewBaseEvent(EventTypeCustom)
	base.Metadata = types.Metadata{"traceId": "abc"}

	encoded, err := base.ToJSON()
	require.NoError(t, err)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	assert.Equal(t, map[string]any{"traceId": "abc"}, decoded["metadata"])
}

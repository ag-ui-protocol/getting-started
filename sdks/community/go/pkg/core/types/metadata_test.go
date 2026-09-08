package types

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMessageUnmarshalMetadata verifies a message carries metadata through a decode.
func TestMessageUnmarshalMetadata(t *testing.T) {
	payload := []byte(`{
		"id": "msg-1",
		"role": "assistant",
		"content": "hi",
		"metadata": {
			"ag-ui": {"source": "adk"},
			"tokenUsage": {"input": 12, "output": 4},
			"finishReason": null
		},
		"toolCalls": [
			{
				"id": "tc-1",
				"type": "function",
				"function": {"name": "tool", "arguments": "{}"},
				"metadata": {"traceId": "abc"}
			}
		]
	}`)

	var message Message
	require.NoError(t, json.Unmarshal(payload, &message))

	require.NotNil(t, message.Metadata)
	assert.Equal(t, map[string]any{"source": "adk"}, message.Metadata[AGUIMetadataKey])
	assert.Equal(t, map[string]any{"input": float64(12), "output": float64(4)}, message.Metadata["tokenUsage"])

	// A null value under a key is meaningful data and is preserved, unlike a
	// null in place of the whole object.
	value, ok := message.Metadata["finishReason"]
	assert.True(t, ok)
	assert.Nil(t, value)

	require.Len(t, message.ToolCalls, 1)
	assert.Equal(t, Metadata{"traceId": "abc"}, message.ToolCalls[0].Metadata)
}

// TestMessageUnmarshalMetadataNullAndAbsent verifies an explicit null metadata object
// decodes the same as an absent one, and neither is written back out.
func TestMessageUnmarshalMetadataNullAndAbsent(t *testing.T) {
	for name, payload := range map[string]string{
		"null":   `{"id": "msg-1", "role": "user", "content": "hi", "metadata": null}`,
		"absent": `{"id": "msg-1", "role": "user", "content": "hi"}`,
	} {
		t.Run(name, func(t *testing.T) {
			var message Message
			require.NoError(t, json.Unmarshal([]byte(payload), &message))
			assert.Nil(t, message.Metadata)

			encoded, err := json.Marshal(message)
			require.NoError(t, err)
			assert.NotContains(t, string(encoded), "metadata")
		})
	}
}

// TestMessageMetadataRoundTrip verifies metadata survives a marshal/unmarshal cycle.
func TestMessageMetadataRoundTrip(t *testing.T) {
	original := Message{
		ID:       "msg-1",
		Role:     RoleAssistant,
		Content:  "hi",
		Metadata: Metadata{AGUIMetadataKey: map[string]any{"nodePath": "root/child"}, "attempt": float64(2)},
		ToolCalls: []ToolCall{{
			ID:       "tc-1",
			Type:     ToolCallTypeFunction,
			Function: FunctionCall{Name: "tool", Arguments: "{}"},
			Metadata: Metadata{"traceId": "abc"},
		}},
	}

	encoded, err := json.Marshal(original)
	require.NoError(t, err)

	var decoded Message
	require.NoError(t, json.Unmarshal(encoded, &decoded))

	assert.Equal(t, original.Metadata, decoded.Metadata)
	require.Len(t, decoded.ToolCalls, 1)
	assert.Equal(t, original.ToolCalls[0].Metadata, decoded.ToolCalls[0].Metadata)
}

// TestRunAgentInputUnmarshalMetadataSnakeCase verifies metadata decodes alongside
// snake_case field names on the types that accept both spellings.
func TestRunAgentInputUnmarshalMetadataSnakeCase(t *testing.T) {
	payload := []byte(`{
		"thread_id": "thread-1",
		"run_id": "run-1",
		"state": {},
		"messages": [
			{
				"id": "msg-1",
				"role": "tool",
				"content": "done",
				"tool_call_id": "tc-1",
				"metadata": {"latencyMs": 12}
			}
		],
		"tools": [
			{
				"name": "tool",
				"description": "desc",
				"parameters": {"type": "object"},
				"metadata": {"a2ui": {"schema": "v1"}}
			}
		],
		"context": [],
		"forwarded_props": {},
		"resume": [
			{
				"interrupt_id": "int-1",
				"status": "resolved",
				"payload": {"approved": true},
				"metadata": {"signature": "sig-1"}
			}
		]
	}`)

	var input RunAgentInput
	require.NoError(t, json.Unmarshal(payload, &input))

	require.Len(t, input.Messages, 1)
	assert.Equal(t, Metadata{"latencyMs": float64(12)}, input.Messages[0].Metadata)

	require.Len(t, input.Tools, 1)
	assert.Equal(t, Metadata{"a2ui": map[string]any{"schema": "v1"}}, input.Tools[0].Metadata)

	require.Len(t, input.Resume, 1)
	assert.Equal(t, Metadata{"signature": "sig-1"}, input.Resume[0].Metadata)
}

// TestInterruptUnmarshalMetadata verifies interrupt metadata still decodes as a
// Metadata map after the named type replaced the inline map.
func TestInterruptUnmarshalMetadata(t *testing.T) {
	payload := []byte(`{
		"id": "int-1",
		"reason": "tool_call",
		"metadata": {"toolName": "search"}
	}`)

	var interrupt Interrupt
	require.NoError(t, json.Unmarshal(payload, &interrupt))
	assert.Equal(t, Metadata{"toolName": "search"}, interrupt.Metadata)
}

// TestMergeMetadata verifies the fold is last-write-wins and non-recursive.
func TestMergeMetadata(t *testing.T) {
	existing := Metadata{
		AGUIMetadataKey: map[string]any{"nodePath": "root"},
		"attempt":       1,
	}
	incoming := Metadata{
		AGUIMetadataKey: map[string]any{"tokenUsage": 12},
		"finishReason":  "stop",
	}

	merged := MergeMetadata(existing, incoming)

	// A key's value is replaced outright, so the reserved key is not blended.
	assert.Equal(t, map[string]any{"tokenUsage": 12}, merged[AGUIMetadataKey])
	assert.Equal(t, 1, merged["attempt"])
	assert.Equal(t, "stop", merged["finishReason"])

	// Neither argument is mutated.
	assert.Equal(t, map[string]any{"nodePath": "root"}, existing[AGUIMetadataKey])
	assert.Len(t, existing, 2)
	assert.Len(t, incoming, 2)
}

// TestMergeMetadataEmptyInputs verifies the absent and empty cases.
func TestMergeMetadataEmptyInputs(t *testing.T) {
	existing := Metadata{"attempt": 1}

	assert.Equal(t, existing, MergeMetadata(existing, nil))
	assert.Equal(t, existing, MergeMetadata(existing, Metadata{}))
	assert.Equal(t, Metadata{"attempt": 1}, MergeMetadata(nil, existing))
	assert.Nil(t, MergeMetadata(nil, nil))
}

// TestMessageUnmarshalSubagentRunID verifies subagent attribution decodes in both
// the camelCase and snake_case spellings.
func TestMessageUnmarshalSubagentRunID(t *testing.T) {
	for name, payload := range map[string]string{
		"camelCase":  `{"id": "msg-1", "role": "assistant", "subagentRunId": "sub-1"}`,
		"snake_case": `{"id": "msg-1", "role": "assistant", "subagent_run_id": "sub-1"}`,
	} {
		t.Run(name, func(t *testing.T) {
			var message Message
			require.NoError(t, json.Unmarshal([]byte(payload), &message))
			assert.Equal(t, "sub-1", message.SubagentRunID)
		})
	}
}

// TestInterruptUnmarshalSubagentRunID verifies the interrupt names the subagent that
// raised it, and stays unattributed when the root agent raised it.
func TestInterruptUnmarshalSubagentRunID(t *testing.T) {
	var interrupt Interrupt
	require.NoError(t, json.Unmarshal([]byte(`{
		"id": "int-1",
		"reason": "tool_call",
		"subagent_run_id": "sub-1"
	}`), &interrupt))
	assert.Equal(t, "sub-1", interrupt.SubagentRunID)

	var rootRaised Interrupt
	require.NoError(t, json.Unmarshal([]byte(`{"id": "int-2", "reason": "tool_call"}`), &rootRaised))
	assert.Empty(t, rootRaised.SubagentRunID)

	encoded, err := json.Marshal(rootRaised)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "subagentRunId")
}

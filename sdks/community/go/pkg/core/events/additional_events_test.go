package events

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBaseEventMethods(t *testing.T) {
	t.Run("ID_Method", func(t *testing.T) {
		base := NewBaseEvent(EventTypeRunStarted)

		// ID should return a generated ID for base events
		id := base.ID()
		assert.NotEmpty(t, id)
		assert.Contains(t, id, "RUN_STARTED")
	})

	t.Run("GetBaseEvent_Method", func(t *testing.T) {
		base := NewBaseEvent(EventTypeRunStarted)

		// GetBaseEvent should return itself
		result := base.GetBaseEvent()
		assert.Equal(t, base, result)
	})

	t.Run("ThreadID_Method", func(t *testing.T) {
		base := NewBaseEvent(EventTypeRunStarted)

		// ThreadID should return empty string for base events
		threadID := base.ThreadID()
		assert.Equal(t, "", threadID)
	})

	t.Run("RunID_Method", func(t *testing.T) {
		base := NewBaseEvent(EventTypeRunStarted)

		// RunID should return empty string for base events
		runID := base.RunID()
		assert.Equal(t, "", runID)
	})

	t.Run("ToJSON_Method", func(t *testing.T) {
		base := NewBaseEvent(EventTypeRunStarted)

		jsonData, err := base.ToJSON()
		require.NoError(t, err)
		assert.NotNil(t, jsonData)

		// Verify JSON structure
		var decoded map[string]interface{}
		err = json.Unmarshal(jsonData, &decoded)
		require.NoError(t, err)
		assert.Equal(t, string(EventTypeRunStarted), decoded["type"])
		assert.NotNil(t, decoded["timestamp"])
	})
}

func TestTextMessageChunkEvent(t *testing.T) {
	t.Run("NewTextMessageChunkEvent", func(t *testing.T) {
		messageID := "msg-123"
		role := "assistant"
		delta := "Hello"
		event := NewTextMessageChunkEvent(&messageID, &role, &delta)

		assert.Equal(t, EventTypeTextMessageChunk, event.Type())
		assert.Equal(t, messageID, *event.MessageID)
		assert.Equal(t, role, *event.Role)
		assert.Equal(t, delta, *event.Delta)
		assert.Nil(t, event.Name)
	})

	t.Run("WithChunkName", func(t *testing.T) {
		event := NewTextMessageChunkEvent(nil, nil, nil).WithChunkName("research-agent")

		assert.NotNil(t, event.Name)
		assert.Equal(t, "research-agent", *event.Name)
	})

	t.Run("Validate", func(t *testing.T) {
		messageID := "msg-123"
		role := "user"
		delta := "Hello"

		// Valid event with all fields
		event := NewTextMessageChunkEvent(&messageID, &role, &delta)
		assert.NoError(t, event.Validate())

		// Valid event with only delta
		event = NewTextMessageChunkEvent(nil, nil, &delta)
		assert.NoError(t, event.Validate())

		// Valid - messageID without delta is allowed for chunks
		event = NewTextMessageChunkEvent(&messageID, nil, nil)
		assert.NoError(t, event.Validate())

		// Valid - name alone is enough to identify the author of a chunk
		event = NewTextMessageChunkEvent(nil, nil, nil).WithChunkName("research-agent")
		assert.NoError(t, event.Validate())
	})

	t.Run("ToJSON", func(t *testing.T) {
		messageID := "msg-123"
		role := "assistant"
		delta := "Hello world"

		event := NewTextMessageChunkEvent(&messageID, &role, &delta).WithChunkName("research-agent")

		jsonData, err := event.ToJSON()
		require.NoError(t, err)

		var decoded map[string]interface{}
		err = json.Unmarshal(jsonData, &decoded)
		require.NoError(t, err)

		assert.Equal(t, string(EventTypeTextMessageChunk), decoded["type"])
		assert.Equal(t, "msg-123", decoded["messageId"])
		assert.Equal(t, "assistant", decoded["role"])
		assert.Equal(t, "Hello world", decoded["delta"])
		assert.Equal(t, "research-agent", decoded["name"])

		// Omitted name stays off the wire
		event = NewTextMessageChunkEvent(&messageID, &role, &delta)
		jsonData, err = event.ToJSON()
		require.NoError(t, err)

		decoded = map[string]interface{}{}
		require.NoError(t, json.Unmarshal(jsonData, &decoded))
		_, hasName := decoded["name"]
		assert.False(t, hasName, "expected \"name\" to be omitted when unset")
	})

	t.Run("DecodeRoundTrip", func(t *testing.T) {
		raw := []byte(`{"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-123","role":"assistant","delta":"Hello","name":"research-agent"}`)

		var decoded TextMessageChunkEvent
		require.NoError(t, json.Unmarshal(raw, &decoded))

		require.NotNil(t, decoded.Name)
		assert.Equal(t, "research-agent", *decoded.Name)
		assert.NoError(t, decoded.Validate())
	})
}

func TestToolCallChunkEvent(t *testing.T) {
	t.Run("NewToolCallChunkEvent", func(t *testing.T) {
		event := NewToolCallChunkEvent()

		assert.Equal(t, EventTypeToolCallChunk, event.Type())
		assert.Nil(t, event.ToolCallID)
		assert.Nil(t, event.ToolCallName)
		assert.Nil(t, event.Delta)
		assert.Nil(t, event.ParentMessageID)
	})

	t.Run("WithToolCallChunkID", func(t *testing.T) {
		event := NewToolCallChunkEvent().WithToolCallChunkID("tool-123")

		assert.NotNil(t, event.ToolCallID)
		assert.Equal(t, "tool-123", *event.ToolCallID)
	})

	t.Run("WithToolCallChunkName", func(t *testing.T) {
		event := NewToolCallChunkEvent().WithToolCallChunkName("get_weather")

		assert.NotNil(t, event.ToolCallName)
		assert.Equal(t, "get_weather", *event.ToolCallName)
	})

	t.Run("WithToolCallChunkDelta", func(t *testing.T) {
		event := NewToolCallChunkEvent().WithToolCallChunkDelta("{\"location\":")

		assert.NotNil(t, event.Delta)
		assert.Equal(t, "{\"location\":", *event.Delta)
	})

	t.Run("WithToolCallChunkParentMessageID", func(t *testing.T) {
		event := NewToolCallChunkEvent().WithToolCallChunkParentMessageID("msg-456")

		assert.NotNil(t, event.ParentMessageID)
		assert.Equal(t, "msg-456", *event.ParentMessageID)
	})

	t.Run("Validate", func(t *testing.T) {
		// Valid event with all fields
		event := NewToolCallChunkEvent().
			WithToolCallChunkID("tool-123").
			WithToolCallChunkName("get_weather").
			WithToolCallChunkDelta("{\"args\"}").
			WithToolCallChunkParentMessageID("msg-456")
		assert.NoError(t, event.Validate())

		// Valid event with minimal fields
		event = NewToolCallChunkEvent().WithToolCallChunkDelta("delta")
		assert.NoError(t, event.Validate())

		// Valid - ID without delta is allowed for chunks
		event = NewToolCallChunkEvent().WithToolCallChunkID("tool-123")
		assert.NoError(t, event.Validate())
	})

	t.Run("ToJSON", func(t *testing.T) {
		event := NewToolCallChunkEvent().
			WithToolCallChunkID("tool-123").
			WithToolCallChunkName("search").
			WithToolCallChunkDelta("{\"query\":").
			WithToolCallChunkParentMessageID("msg-789")

		jsonData, err := event.ToJSON()
		require.NoError(t, err)

		var decoded map[string]interface{}
		err = json.Unmarshal(jsonData, &decoded)
		require.NoError(t, err)

		assert.Equal(t, string(EventTypeToolCallChunk), decoded["type"])
		assert.Equal(t, "tool-123", decoded["toolCallId"])
		assert.Equal(t, "search", decoded["toolCallName"])
		assert.Equal(t, "{\"query\":", decoded["delta"])
		assert.Equal(t, "msg-789", decoded["parentMessageId"])
	})
}

func TestToolCallResultEvent(t *testing.T) {
	t.Run("NewToolCallResultEvent", func(t *testing.T) {
		event := NewToolCallResultEvent("msg-456", "tool-123", "Success")

		assert.Equal(t, EventTypeToolCallResult, event.Type())
		assert.Equal(t, "msg-456", event.MessageID)
		assert.Equal(t, "tool-123", event.ToolCallID)
		assert.Equal(t, "Success", event.Content)
		assert.NotNil(t, event.Role)
		assert.Equal(t, "tool", *event.Role)
	})

	t.Run("Validate", func(t *testing.T) {
		// Valid event
		event := NewToolCallResultEvent("msg-456", "tool-123", "Result")
		assert.NoError(t, event.Validate())

		// Invalid - empty message ID
		event.MessageID = ""
		assert.Error(t, event.Validate())

		// Invalid - empty tool call ID
		event = NewToolCallResultEvent("msg-456", "", "Result")
		assert.Error(t, event.Validate())

		// Invalid - empty content
		event = NewToolCallResultEvent("msg-456", "tool-123", "")
		assert.Error(t, event.Validate())
	})

	t.Run("ToJSON", func(t *testing.T) {
		event := NewToolCallResultEvent("msg-456", "tool-123", "Weather: Sunny, 72°F")

		jsonData, err := event.ToJSON()
		require.NoError(t, err)

		var decoded map[string]interface{}
		err = json.Unmarshal(jsonData, &decoded)
		require.NoError(t, err)

		assert.Equal(t, string(EventTypeToolCallResult), decoded["type"])
		assert.Equal(t, "msg-456", decoded["messageId"])
		assert.Equal(t, "tool-123", decoded["toolCallId"])
		assert.Equal(t, "Weather: Sunny, 72°F", decoded["content"])
		assert.Equal(t, "tool", decoded["role"])
	})
}

func TestAutoIDGeneration(t *testing.T) {
	t.Run("TextMessageStartEvent_WithAutoMessageID", func(t *testing.T) {
		event := NewTextMessageStartEvent("", WithAutoMessageID())

		assert.NotEmpty(t, event.MessageID)
		assert.True(t, strings.HasPrefix(event.MessageID, "msg-"))
	})

	t.Run("TextMessageContentEvent_WithAutoMessageIDContent", func(t *testing.T) {
		event := NewTextMessageContentEventWithOptions("", "Hello", WithAutoMessageIDContent())

		assert.NotEmpty(t, event.MessageID)
		assert.True(t, strings.HasPrefix(event.MessageID, "msg-"))
	})

	t.Run("TextMessageEndEvent_WithAutoMessageIDEnd", func(t *testing.T) {
		event := NewTextMessageEndEventWithOptions("", WithAutoMessageIDEnd())

		assert.NotEmpty(t, event.MessageID)
		assert.True(t, strings.HasPrefix(event.MessageID, "msg-"))
	})

	t.Run("ToolCallStartEvent_WithAutoToolCallID", func(t *testing.T) {
		event := NewToolCallStartEvent("", "get_weather", WithAutoToolCallID())

		assert.NotEmpty(t, event.ToolCallID)
		assert.True(t, strings.HasPrefix(event.ToolCallID, "tool-"))
	})

	t.Run("ToolCallArgsEvent_WithAutoToolCallIDArgs", func(t *testing.T) {
		event := NewToolCallArgsEventWithOptions("", "{}", WithAutoToolCallIDArgs())

		assert.NotEmpty(t, event.ToolCallID)
		assert.True(t, strings.HasPrefix(event.ToolCallID, "tool-"))
	})

	t.Run("ToolCallEndEvent_WithAutoToolCallIDEnd", func(t *testing.T) {
		event := NewToolCallEndEventWithOptions("", WithAutoToolCallIDEnd())

		assert.NotEmpty(t, event.ToolCallID)
		assert.True(t, strings.HasPrefix(event.ToolCallID, "tool-"))
	})

	t.Run("RunStartedEvent_WithAutoRunID", func(t *testing.T) {
		event := NewRunStartedEventWithOptions("thread-123", "", WithAutoRunID())

		assert.NotEmpty(t, event.RunIDValue)
		assert.True(t, strings.HasPrefix(event.RunIDValue, "run-"))
	})

	t.Run("RunStartedEvent_WithAutoThreadID", func(t *testing.T) {
		event := NewRunStartedEventWithOptions("", "run-123", WithAutoThreadID())

		assert.NotEmpty(t, event.ThreadIDValue)
		assert.True(t, strings.HasPrefix(event.ThreadIDValue, "thread-"))
	})

	t.Run("RunFinishedEvent_WithAutoRunIDFinished", func(t *testing.T) {
		event := NewRunFinishedEventWithOptions("thread-123", "", WithAutoRunIDFinished())

		assert.NotEmpty(t, event.RunIDValue)
		assert.True(t, strings.HasPrefix(event.RunIDValue, "run-"))
	})

	t.Run("RunFinishedEvent_WithAutoThreadIDFinished", func(t *testing.T) {
		event := NewRunFinishedEventWithOptions("", "run-123", WithAutoThreadIDFinished())

		assert.NotEmpty(t, event.ThreadIDValue)
		assert.True(t, strings.HasPrefix(event.ThreadIDValue, "thread-"))
	})

	t.Run("RunErrorEvent_WithAutoRunIDError", func(t *testing.T) {
		event := NewRunErrorEvent("Error", WithAutoRunIDError())

		assert.NotEmpty(t, event.RunIDValue)
		assert.True(t, strings.HasPrefix(event.RunIDValue, "run-"))
	})

	t.Run("StepStartedEvent_WithAutoStepName", func(t *testing.T) {
		event := NewStepStartedEventWithOptions("", WithAutoStepName())

		assert.NotEmpty(t, event.StepName)
		assert.True(t, strings.HasPrefix(event.StepName, "step-"))
	})

	t.Run("StepFinishedEvent_WithAutoStepNameFinished", func(t *testing.T) {
		event := NewStepFinishedEventWithOptions("", WithAutoStepNameFinished())

		assert.NotEmpty(t, event.StepName)
		assert.True(t, strings.HasPrefix(event.StepName, "step-"))
	})
}

func TestOptionalEventCreators(t *testing.T) {
	t.Run("NewTextMessageContentEventWithOptions", func(t *testing.T) {
		event := NewTextMessageContentEventWithOptions("msg-123", "Hello")

		assert.Equal(t, "msg-123", event.MessageID)
		assert.Equal(t, "Hello", event.Delta)
		assert.NoError(t, event.Validate())
	})

	t.Run("NewTextMessageEndEventWithOptions", func(t *testing.T) {
		event := NewTextMessageEndEventWithOptions("msg-123")

		assert.Equal(t, "msg-123", event.MessageID)
		assert.NoError(t, event.Validate())
	})

	t.Run("NewToolCallArgsEventWithOptions", func(t *testing.T) {
		event := NewToolCallArgsEventWithOptions("tool-123", "{}")

		assert.Equal(t, "tool-123", event.ToolCallID)
		assert.Equal(t, "{}", event.Delta)
		assert.NoError(t, event.Validate())
	})

	t.Run("NewToolCallEndEventWithOptions", func(t *testing.T) {
		event := NewToolCallEndEventWithOptions("tool-123")

		assert.Equal(t, "tool-123", event.ToolCallID)
		assert.NoError(t, event.Validate())
	})

	t.Run("NewRunStartedEventWithOptions", func(t *testing.T) {
		event := NewRunStartedEventWithOptions("thread-123", "run-456")

		assert.Equal(t, "thread-123", event.ThreadIDValue)
		assert.Equal(t, "run-456", event.RunIDValue)
		assert.NoError(t, event.Validate())
	})

	t.Run("NewRunFinishedEventWithOptions", func(t *testing.T) {
		event := NewRunFinishedEventWithOptions("thread-123", "run-456")

		assert.Equal(t, "thread-123", event.ThreadIDValue)
		assert.Equal(t, "run-456", event.RunIDValue)
		assert.NoError(t, event.Validate())
	})

	t.Run("NewStepStartedEventWithOptions", func(t *testing.T) {
		event := NewStepStartedEventWithOptions("step-1")

		assert.Equal(t, "step-1", event.StepName)
		assert.NoError(t, event.Validate())
	})

	t.Run("NewStepFinishedEventWithOptions", func(t *testing.T) {
		event := NewStepFinishedEventWithOptions("step-1")

		assert.Equal(t, "step-1", event.StepName)
		assert.NoError(t, event.Validate())
	})
}

func TestRunFinishedEvent_WithResult(t *testing.T) {
	result := map[string]interface{}{
		"status": "success",
		"data":   "completed",
	}
	event := NewRunFinishedEventWithOptions("thread-123", "run-456", WithResult(result))

	assert.Equal(t, result, event.Result)

	// Test JSON serialization with result
	jsonData, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(jsonData, &decoded)
	require.NoError(t, err)

	assert.NotNil(t, decoded["result"])
}

func TestStateDeltaEvent_ToJSON(t *testing.T) {
	delta := []JSONPatchOperation{
		{Op: "add", Path: "/field", Value: "value"},
	}
	event := NewStateDeltaEvent(delta)

	jsonData, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(jsonData, &decoded)
	require.NoError(t, err)

	assert.Equal(t, string(EventTypeStateDelta), decoded["type"])
	assert.NotNil(t, decoded["delta"])
}

func TestMessagesSnapshotEvent_ToJSON(t *testing.T) {
	messages := []Message{
		{
			ID:      "msg-1",
			Role:    "user",
			Content: strPtr("Hello"),
		},
	}
	event := NewMessagesSnapshotEvent(messages)

	jsonData, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(jsonData, &decoded)
	require.NoError(t, err)

	assert.Equal(t, string(EventTypeMessagesSnapshot), decoded["type"])
	assert.NotNil(t, decoded["messages"])
}

func TestRawEvent_ToJSON(t *testing.T) {
	eventData := map[string]interface{}{"key": "value"}
	source := "external"
	event := NewRawEvent(eventData, WithSource(source))

	jsonData, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(jsonData, &decoded)
	require.NoError(t, err)

	assert.Equal(t, string(EventTypeRaw), decoded["type"])
	assert.NotNil(t, decoded["event"])
	assert.Equal(t, source, decoded["source"])
}

func TestRunErrorEvent_ToJSON(t *testing.T) {
	message := "An error occurred"
	code := "ERR_001"
	runID := "run-456"
	event := NewRunErrorEvent(message, WithErrorCode(code), WithRunID(runID))

	jsonData, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(jsonData, &decoded)
	require.NoError(t, err)

	assert.Equal(t, string(EventTypeRunError), decoded["type"])
	assert.Equal(t, message, decoded["message"])
	assert.Equal(t, code, decoded["code"])
	assert.Equal(t, runID, decoded["runId"])
}

func TestStepEvents_ToJSON(t *testing.T) {
	t.Run("StepStartedEvent", func(t *testing.T) {
		event := NewStepStartedEvent("step-1")

		jsonData, err := event.ToJSON()
		require.NoError(t, err)

		var decoded map[string]interface{}
		err = json.Unmarshal(jsonData, &decoded)
		require.NoError(t, err)

		assert.Equal(t, string(EventTypeStepStarted), decoded["type"])
		assert.Equal(t, "step-1", decoded["stepName"])
	})

	t.Run("StepFinishedEvent", func(t *testing.T) {
		event := NewStepFinishedEvent("step-1")

		jsonData, err := event.ToJSON()
		require.NoError(t, err)

		var decoded map[string]interface{}
		err = json.Unmarshal(jsonData, &decoded)
		require.NoError(t, err)

		assert.Equal(t, string(EventTypeStepFinished), decoded["type"])
		assert.Equal(t, "step-1", decoded["stepName"])
	})
}

func TestTextMessageEndEvent_ToJSON(t *testing.T) {
	event := NewTextMessageEndEvent("msg-123")

	jsonData, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(jsonData, &decoded)
	require.NoError(t, err)

	assert.Equal(t, string(EventTypeTextMessageEnd), decoded["type"])
	assert.Equal(t, "msg-123", decoded["messageId"])
}

func TestToolCallArgsEvent_ToJSON(t *testing.T) {
	event := NewToolCallArgsEvent("tool-123", "{\"arg\": \"value\"}")

	jsonData, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(jsonData, &decoded)
	require.NoError(t, err)

	assert.Equal(t, string(EventTypeToolCallArgs), decoded["type"])
	assert.Equal(t, "tool-123", decoded["toolCallId"])
	assert.Equal(t, "{\"arg\": \"value\"}", decoded["delta"])
}

func TestToolCallEndEvent_ToJSON(t *testing.T) {
	event := NewToolCallEndEvent("tool-123")

	jsonData, err := event.ToJSON()
	require.NoError(t, err)

	var decoded map[string]interface{}
	err = json.Unmarshal(jsonData, &decoded)
	require.NoError(t, err)

	assert.Equal(t, string(EventTypeToolCallEnd), decoded["type"])
	assert.Equal(t, "tool-123", decoded["toolCallId"])
}

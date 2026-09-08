package events

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

// EventType represents the type of AG-UI event.
type EventType string

// Event type constants match the AG-UI protocol specification.
const (
	EventTypeTextMessageStart   EventType = "TEXT_MESSAGE_START"
	EventTypeTextMessageContent EventType = "TEXT_MESSAGE_CONTENT"
	EventTypeTextMessageEnd     EventType = "TEXT_MESSAGE_END"
	EventTypeTextMessageChunk   EventType = "TEXT_MESSAGE_CHUNK"
	EventTypeToolCallStart      EventType = "TOOL_CALL_START"
	EventTypeToolCallArgs       EventType = "TOOL_CALL_ARGS"
	EventTypeToolCallEnd        EventType = "TOOL_CALL_END"
	EventTypeToolCallChunk      EventType = "TOOL_CALL_CHUNK"
	EventTypeToolCallResult     EventType = "TOOL_CALL_RESULT"
	EventTypeStateSnapshot      EventType = "STATE_SNAPSHOT"
	EventTypeStateDelta         EventType = "STATE_DELTA"
	EventTypeMessagesSnapshot   EventType = "MESSAGES_SNAPSHOT"
	EventTypeActivitySnapshot   EventType = "ACTIVITY_SNAPSHOT"
	EventTypeActivityDelta      EventType = "ACTIVITY_DELTA"
	EventTypeRaw                EventType = "RAW"
	EventTypeCustom             EventType = "CUSTOM"
	EventTypeRunStarted         EventType = "RUN_STARTED"
	EventTypeRunFinished        EventType = "RUN_FINISHED"
	EventTypeRunError           EventType = "RUN_ERROR"
	EventTypeStepStarted        EventType = "STEP_STARTED"
	EventTypeStepFinished       EventType = "STEP_FINISHED"

	// Thinking events are kept for backward compatibility.
	// Deprecated: Use the REASONING_* event types instead.
	// EventTypeThinkingStart indicates the start of a thinking phase.
	// Deprecated: Use EventTypeReasoningStart instead.
	EventTypeThinkingStart EventType = "THINKING_START"
	// EventTypeThinkingEnd indicates the end of a thinking phase.
	// Deprecated: Use EventTypeReasoningEnd instead.
	EventTypeThinkingEnd EventType = "THINKING_END"
	// EventTypeThinkingTextMessageStart indicates the start of a thinking text message.
	// Deprecated: Use EventTypeReasoningMessageStart instead.
	EventTypeThinkingTextMessageStart EventType = "THINKING_TEXT_MESSAGE_START"
	// EventTypeThinkingTextMessageContent contains streaming thinking text content.
	// Deprecated: Use EventTypeReasoningMessageContent instead.
	EventTypeThinkingTextMessageContent EventType = "THINKING_TEXT_MESSAGE_CONTENT"
	// EventTypeThinkingTextMessageEnd indicates the end of a thinking text message.
	// Deprecated: Use EventTypeReasoningMessageEnd instead.
	EventTypeThinkingTextMessageEnd EventType = "THINKING_TEXT_MESSAGE_END"

	// Reasoning events support the reasoning message lifecycle.
	// EventTypeReasoningStart marks the start of a reasoning phase.
	EventTypeReasoningStart              EventType = "REASONING_START"
	// EventTypeReasoningMessageStart signals the start of a reasoning message.
	EventTypeReasoningMessageStart       EventType = "REASONING_MESSAGE_START"
	// EventTypeReasoningMessageContent represents a chunk of reasoning message content.
	EventTypeReasoningMessageContent     EventType = "REASONING_MESSAGE_CONTENT"
	// EventTypeReasoningMessageEnd signals the end of a reasoning message.
	EventTypeReasoningMessageEnd         EventType = "REASONING_MESSAGE_END"
	// EventTypeReasoningMessageChunk is a convenience event that streams reasoning message chunks.
	EventTypeReasoningMessageChunk       EventType = "REASONING_MESSAGE_CHUNK"
	// EventTypeReasoningEnd marks the end of a reasoning phase.
	EventTypeReasoningEnd                EventType = "REASONING_END"
	// EventTypeReasoningEncryptedValue attaches an encrypted reasoning value.
	EventTypeReasoningEncryptedValue     EventType = "REASONING_ENCRYPTED_VALUE"

	// EventTypeUnknown represents an unrecognized event type
	EventTypeUnknown EventType = "UNKNOWN"
)

// validEventTypes is a map for O(1) lookup of valid event types
var validEventTypes = map[EventType]bool{
	EventTypeTextMessageStart:           true,
	EventTypeTextMessageContent:         true,
	EventTypeTextMessageEnd:             true,
	EventTypeTextMessageChunk:           true,
	EventTypeToolCallStart:              true,
	EventTypeToolCallArgs:               true,
	EventTypeToolCallEnd:                true,
	EventTypeToolCallChunk:              true,
	EventTypeToolCallResult:             true,
	EventTypeStateSnapshot:              true,
	EventTypeStateDelta:                 true,
	EventTypeMessagesSnapshot:           true,
	EventTypeActivitySnapshot:           true,
	EventTypeActivityDelta:              true,
	EventTypeRaw:                        true,
	EventTypeCustom:                     true,
	EventTypeRunStarted:                 true,
	EventTypeRunFinished:                true,
	EventTypeRunError:                   true,
	EventTypeStepStarted:                true,
	EventTypeStepFinished:               true,
	EventTypeThinkingStart:              true,
	EventTypeThinkingEnd:                true,
	EventTypeThinkingTextMessageStart:   true,
	EventTypeThinkingTextMessageContent: true,
	EventTypeThinkingTextMessageEnd:     true,
	EventTypeReasoningStart:             true,
	EventTypeReasoningMessageStart:      true,
	EventTypeReasoningMessageContent:    true,
	EventTypeReasoningMessageEnd:        true,
	EventTypeReasoningMessageChunk:      true,
	EventTypeReasoningEnd:               true,
	EventTypeReasoningEncryptedValue:    true,
}

// Event defines the common interface for all AG-UI events
type Event interface {
	// Type returns the event type
	Type() EventType

	// Timestamp returns the event timestamp (Unix milliseconds)
	Timestamp() *int64

	// SetTimestamp sets the event timestamp
	SetTimestamp(timestamp int64)

	// ThreadID returns the thread ID associated with this event
	ThreadID() string

	// RunID returns the run ID associated with this event
	RunID() string

	// Validate validates the event structure and content
	Validate() error

	// ToJSON serializes the event to JSON for cross-SDK compatibility
	ToJSON() ([]byte, error)

	// GetBaseEvent returns the underlying base event
	GetBaseEvent() *BaseEvent
}

// BaseEvent provides common fields and functionality for all events
type BaseEvent struct {
	EventType   EventType `json:"type"`
	TimestampMs *int64    `json:"timestamp,omitempty"`
	RawEvent    any       `json:"rawEvent,omitempty"`
	// Metadata is declared here rather than per event, so every event type
	// carries it. Reach it through GetBaseEvent on the Event interface, which
	// stays unchanged so existing implementations keep compiling.
	Metadata types.Metadata `json:"metadata,omitempty"`
}

// Type returns the event type
func (b *BaseEvent) Type() EventType {
	return b.EventType
}

// Timestamp returns the event timestamp
func (b *BaseEvent) Timestamp() *int64 {
	return b.TimestampMs
}

// SetTimestamp sets the event timestamp
func (b *BaseEvent) SetTimestamp(timestamp int64) {
	b.TimestampMs = &timestamp
}

// ID returns the unique identifier for this event
func (b *BaseEvent) ID() string {
	// Generate a unique ID based on event type and timestamp
	if b.TimestampMs != nil {
		return fmt.Sprintf("%s_%d", b.EventType, *b.TimestampMs)
	}
	return fmt.Sprintf("%s_%d", b.EventType, time.Now().UnixMilli())
}

// ToJSON serializes the base event to JSON
func (b *BaseEvent) ToJSON() ([]byte, error) {
	eventData := map[string]interface{}{
		"type": b.EventType,
	}

	if b.TimestampMs != nil {
		eventData["timestamp"] = *b.TimestampMs
	}

	if b.RawEvent != nil {
		eventData["data"] = b.RawEvent
	}

	if len(b.Metadata) > 0 {
		eventData["metadata"] = b.Metadata
	}

	return json.Marshal(eventData)
}

// GetBaseEvent returns the base event
func (b *BaseEvent) GetBaseEvent() *BaseEvent {
	return b
}

// ThreadID returns the thread ID (default implementation returns empty string)
func (b *BaseEvent) ThreadID() string {
	return ""
}

// RunID returns the run ID (default implementation returns empty string)
func (b *BaseEvent) RunID() string {
	return ""
}

// NewBaseEvent creates a new base event with the given type and current timestamp
func NewBaseEvent(eventType EventType) *BaseEvent {
	now := time.Now().UnixMilli()
	return &BaseEvent{
		EventType:   eventType,
		TimestampMs: &now,
	}
}

// Validate validates the base event structure
func (b *BaseEvent) Validate() error {
	if b.EventType == "" {
		return fmt.Errorf("BaseEvent validation failed: type field is required")
	}

	if !isValidEventType(b.EventType) {
		return fmt.Errorf("BaseEvent validation failed: invalid event type '%s'", b.EventType)
	}

	return nil
}

// isValidEventType checks if the given event type is valid
func isValidEventType(eventType EventType) bool {
	return validEventTypes[eventType]
}

// ValidateSequence validates a sequence of events according to AG-UI protocol rules
func ValidateSequence(events []Event) error {
	if len(events) == 0 {
		return nil
	}

	// Track active runs, messages, tool calls, and steps
	activeRuns := make(map[string]bool)
	activeMessages := make(map[string]bool)
	activeReasoningMessages := make(map[string]bool)
	activeToolCalls := make(map[string]bool)
	activeSteps := make(map[string]bool)
	finishedRuns := make(map[string]bool)

	for i, event := range events {
		if err := event.Validate(); err != nil {
			return fmt.Errorf("event %d validation failed: %w", i, err)
		}

		// Check sequence-specific validation rules
		switch event.Type() {
		case EventTypeRunStarted:
			if runEvent, ok := event.(*RunStartedEvent); ok {
				if activeRuns[runEvent.RunID()] {
					return fmt.Errorf("run %s already started", runEvent.RunID())
				}
				if finishedRuns[runEvent.RunID()] {
					return fmt.Errorf("cannot restart finished run %s", runEvent.RunID())
				}
				activeRuns[runEvent.RunID()] = true
			}

		case EventTypeRunFinished:
			if runEvent, ok := event.(*RunFinishedEvent); ok {
				if !activeRuns[runEvent.RunID()] {
					return fmt.Errorf("cannot finish run %s that was not started", runEvent.RunID())
				}
				delete(activeRuns, runEvent.RunID())
				finishedRuns[runEvent.RunID()] = true
			}

		case EventTypeRunError:
			if runEvent, ok := event.(*RunErrorEvent); ok {
				if runEvent.RunID() != "" && !activeRuns[runEvent.RunID()] {
					return fmt.Errorf("cannot error run %s that was not started", runEvent.RunID())
				}
				if runEvent.RunID() != "" {
					delete(activeRuns, runEvent.RunID())
					finishedRuns[runEvent.RunID()] = true
				}
			}

		case EventTypeStepStarted:
			if stepEvent, ok := event.(*StepStartedEvent); ok {
				if activeSteps[stepEvent.StepName] {
					return fmt.Errorf("step %s already started", stepEvent.StepName)
				}
				activeSteps[stepEvent.StepName] = true
			}

		case EventTypeStepFinished:
			if stepEvent, ok := event.(*StepFinishedEvent); ok {
				if !activeSteps[stepEvent.StepName] {
					return fmt.Errorf("cannot finish step %s that was not started", stepEvent.StepName)
				}
				delete(activeSteps, stepEvent.StepName)
			}

		case EventTypeTextMessageStart:
			if msgEvent, ok := event.(*TextMessageStartEvent); ok {
				if activeMessages[msgEvent.MessageID] {
					return fmt.Errorf("message %s already started", msgEvent.MessageID)
				}
				activeMessages[msgEvent.MessageID] = true
			}

		case EventTypeTextMessageContent:
			if msgEvent, ok := event.(*TextMessageContentEvent); ok {
				if !activeMessages[msgEvent.MessageID] {
					return fmt.Errorf("cannot add content to message %s that was not started", msgEvent.MessageID)
				}
				// Content events are valid between start and end
			}

		case EventTypeTextMessageEnd:
			if msgEvent, ok := event.(*TextMessageEndEvent); ok {
				if !activeMessages[msgEvent.MessageID] {
					return fmt.Errorf("cannot end message %s that was not started", msgEvent.MessageID)
				}
				delete(activeMessages, msgEvent.MessageID)
			}

		case EventTypeTextMessageChunk:
			// Chunk events are always valid in sequence context.

		case EventTypeToolCallStart:
			if toolEvent, ok := event.(*ToolCallStartEvent); ok {
				if activeToolCalls[toolEvent.ToolCallID] {
					return fmt.Errorf("tool call %s already started", toolEvent.ToolCallID)
				}
				activeToolCalls[toolEvent.ToolCallID] = true
			}

		case EventTypeToolCallArgs:
			if toolEvent, ok := event.(*ToolCallArgsEvent); ok {
				if !activeToolCalls[toolEvent.ToolCallID] {
					return fmt.Errorf("cannot add args to tool call %s that was not started", toolEvent.ToolCallID)
				}
				// Args events are valid between start and end
			}

		case EventTypeToolCallEnd:
			if toolEvent, ok := event.(*ToolCallEndEvent); ok {
				if !activeToolCalls[toolEvent.ToolCallID] {
					return fmt.Errorf("cannot end tool call %s that was not started", toolEvent.ToolCallID)
				}
				delete(activeToolCalls, toolEvent.ToolCallID)
			}

		case EventTypeToolCallChunk:
			// Chunk events are always valid in sequence context.

		case EventTypeToolCallResult:
			// Tool call result events are always valid in sequence context.

		case EventTypeThinkingStart, EventTypeThinkingEnd, EventTypeThinkingTextMessageStart, EventTypeThinkingTextMessageContent, EventTypeThinkingTextMessageEnd:
			// Thinking events are always valid in sequence context.

		case EventTypeReasoningStart:
			// Reasoning events are always valid in sequence context.

		case EventTypeReasoningMessageStart:
			if msgEvent, ok := event.(*ReasoningMessageStartEvent); ok {
				if activeReasoningMessages[msgEvent.MessageID] {
					return fmt.Errorf("reasoning message %s already started", msgEvent.MessageID)
				}
				activeReasoningMessages[msgEvent.MessageID] = true
			}

		case EventTypeReasoningMessageContent:
			if msgEvent, ok := event.(*ReasoningMessageContentEvent); ok {
				if !activeReasoningMessages[msgEvent.MessageID] {
					return fmt.Errorf("cannot add content to reasoning message %s that was not started", msgEvent.MessageID)
				}
			}

		case EventTypeReasoningMessageEnd:
			if msgEvent, ok := event.(*ReasoningMessageEndEvent); ok {
				if !activeReasoningMessages[msgEvent.MessageID] {
					return fmt.Errorf("cannot end reasoning message %s that was not started", msgEvent.MessageID)
				}
				delete(activeReasoningMessages, msgEvent.MessageID)
			}

		case EventTypeReasoningMessageChunk:
			// Chunk events are always valid in sequence context.

		case EventTypeReasoningEncryptedValue:
			// Encrypted value events are always valid in sequence context.

		case EventTypeReasoningEnd:
			// Reasoning events are always valid in sequence context.

		case EventTypeStateSnapshot:
			// State snapshot events are always valid in sequence context
			// They represent complete state at any point in time
			// Additional validation could be added if needed (e.g., frequency limits)

		case EventTypeStateDelta:
			// State delta events are always valid in sequence context
			// They represent incremental changes at any point in time
			// Additional validation could be added if needed (e.g., conflict detection)

		case EventTypeMessagesSnapshot:
			// Message snapshot events are always valid in sequence context
			// They represent complete message state at any point in time
			// Additional validation could be added if needed (e.g., consistency checks)

		case EventTypeActivitySnapshot:
			// Activity snapshot events are always valid in sequence context
			// They represent complete activity state at any point in time

		case EventTypeActivityDelta:
			// Activity delta events are always valid in sequence context
			// They represent incremental activity changes at any point in time

		case EventTypeRaw:
			// Raw events are always valid in sequence context
			// They contain external data that should be passed through
			// Additional validation could be added via custom validators

		case EventTypeCustom:
			// Custom events are always valid in sequence context
			// They contain application-specific data
			// Additional validation could be added via custom validators

		default:
			// This should not happen due to prior validation, but add safety check
			return fmt.Errorf("unknown event type in sequence: %s", event.Type())
		}
	}

	return nil
}

// EventFromJSON parses an event from JSON data
func EventFromJSON(data []byte) (Event, error) {
	// First, parse the base event to determine the type
	var base struct {
		Type EventType `json:"type"`
	}

	if err := json.Unmarshal(data, &base); err != nil {
		return nil, fmt.Errorf("failed to parse event type: %w", err)
	}

	// Create the appropriate event type based on the type field
	var event Event
	switch base.Type {
	case EventTypeRunStarted:
		event = &RunStartedEvent{}
	case EventTypeRunFinished:
		event = &RunFinishedEvent{}
	case EventTypeRunError:
		event = &RunErrorEvent{}
	case EventTypeStepStarted:
		event = &StepStartedEvent{}
	case EventTypeStepFinished:
		event = &StepFinishedEvent{}
	case EventTypeTextMessageStart:
		event = &TextMessageStartEvent{}
	case EventTypeTextMessageContent:
		event = &TextMessageContentEvent{}
	case EventTypeTextMessageChunk:
		event = &TextMessageChunkEvent{}
	case EventTypeTextMessageEnd:
		event = &TextMessageEndEvent{}
	case EventTypeToolCallStart:
		event = &ToolCallStartEvent{}
	case EventTypeToolCallArgs:
		event = &ToolCallArgsEvent{}
	case EventTypeToolCallEnd:
		event = &ToolCallEndEvent{}
	case EventTypeToolCallResult:
		event = &ToolCallResultEvent{}
	case EventTypeStateSnapshot:
		event = &StateSnapshotEvent{}
	case EventTypeStateDelta:
		event = &StateDeltaEvent{}
	case EventTypeMessagesSnapshot:
		event = &MessagesSnapshotEvent{}
	case EventTypeActivitySnapshot:
		event = &ActivitySnapshotEvent{}
	case EventTypeActivityDelta:
		event = &ActivityDeltaEvent{}
	case EventTypeRaw:
		event = &RawEvent{}
	case EventTypeCustom:
		event = &CustomEvent{}
	case EventTypeReasoningStart:
		event = &ReasoningStartEvent{}
	case EventTypeReasoningMessageStart:
		event = &ReasoningMessageStartEvent{}
	case EventTypeReasoningMessageContent:
		event = &ReasoningMessageContentEvent{}
	case EventTypeReasoningMessageEnd:
		event = &ReasoningMessageEndEvent{}
	case EventTypeReasoningMessageChunk:
		event = &ReasoningMessageChunkEvent{}
	case EventTypeReasoningEnd:
		event = &ReasoningEndEvent{}
	case EventTypeReasoningEncryptedValue:
		event = &ReasoningEncryptedValueEvent{}
	default:
		return nil, fmt.Errorf("unknown event type: %s", base.Type)
	}

	// Unmarshal into the specific event type
	if err := json.Unmarshal(data, event); err != nil {
		return nil, fmt.Errorf("failed to unmarshal event: %w", err)
	}

	return event, nil
}

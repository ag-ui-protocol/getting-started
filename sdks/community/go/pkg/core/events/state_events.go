package events

import (
	"encoding/json"
	"fmt"

	coretypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

// validJSONPatchOps contains the valid JSON Patch operations for efficient lookup
var validJSONPatchOps = map[string]bool{
	"add":     true,
	"remove":  true,
	"replace": true,
	"move":    true,
	"copy":    true,
	"test":    true,
}

// RoleActivity is the role for activity messages
const RoleActivity = "activity"

type Message = coretypes.Message

type ToolCall = coretypes.ToolCall

type Function = coretypes.FunctionCall

// StateSnapshotEvent contains a complete snapshot of the state
type StateSnapshotEvent struct {
	*BaseEvent
	Snapshot any `json:"snapshot"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewStateSnapshotEvent creates a new state snapshot event
func NewStateSnapshotEvent(snapshot any) *StateSnapshotEvent {
	return &StateSnapshotEvent{
		BaseEvent: NewBaseEvent(EventTypeStateSnapshot),
		Snapshot:  snapshot,
	}
}

// Validate validates the state snapshot event
func (e *StateSnapshotEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Snapshot == nil {
		return fmt.Errorf("StateSnapshotEvent validation failed: snapshot field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StateSnapshotEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// JSONPatchOperation represents a JSON Patch operation (RFC 6902)
type JSONPatchOperation struct {
	Op    string `json:"op"`              // "add", "remove", "replace", "move", "copy", "test"
	Path  string `json:"path"`            // JSON Pointer path
	Value any    `json:"value,omitempty"` // Value for add, replace, test operations
	From  string `json:"from,omitempty"`  // Source path for move, copy operations
}

// StateDeltaEvent contains incremental state changes using JSON Patch
type StateDeltaEvent struct {
	*BaseEvent
	Delta []JSONPatchOperation `json:"delta"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewStateDeltaEvent creates a new state delta event
func NewStateDeltaEvent(delta []JSONPatchOperation) *StateDeltaEvent {
	return &StateDeltaEvent{
		BaseEvent: NewBaseEvent(EventTypeStateDelta),
		Delta:     delta,
	}
}

// Validate validates the state delta event
func (e *StateDeltaEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if len(e.Delta) == 0 {
		return fmt.Errorf("StateDeltaEvent validation failed: delta field must contain at least one operation")
	}

	// Validate each JSON patch operation
	for i, op := range e.Delta {
		if err := validateJSONPatchOperation(op); err != nil {
			return fmt.Errorf("StateDeltaEvent validation failed: invalid operation at index %d: %w", i, err)
		}
	}

	return nil
}

// validateJSONPatchOperation validates a single JSON patch operation
func validateJSONPatchOperation(op JSONPatchOperation) error {
	// Validate operation type using map lookup for better performance
	if !validJSONPatchOps[op.Op] {
		return fmt.Errorf("op field must be one of: add, remove, replace, move, copy, test, got: %s", op.Op)
	}

	// Validate path
	if op.Path == "" {
		return fmt.Errorf("path field is required")
	}

	// Validate value for operations that require it
	if (op.Op == "add" || op.Op == "replace" || op.Op == "test") && op.Value == nil {
		return fmt.Errorf("value field is required for %s operation", op.Op)
	}

	// Validate from for operations that require it
	if (op.Op == "move" || op.Op == "copy") && op.From == "" {
		return fmt.Errorf("from field is required for %s operation", op.Op)
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StateDeltaEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// MessagesSnapshotEvent contains a snapshot of all messages
type MessagesSnapshotEvent struct {
	*BaseEvent
	Messages []Message `json:"messages"`
}

// NewMessagesSnapshotEvent creates a new messages snapshot event
func NewMessagesSnapshotEvent(messages []Message) *MessagesSnapshotEvent {
	return &MessagesSnapshotEvent{
		BaseEvent: NewBaseEvent(EventTypeMessagesSnapshot),
		Messages:  messages,
	}
}

// Validate validates the messages snapshot event
func (e *MessagesSnapshotEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	// Validate each message
	for i, msg := range e.Messages {
		if err := validateMessage(msg); err != nil {
			return fmt.Errorf("invalid message at index %d: %w", i, err)
		}
	}

	return nil
}

// validateMessage validates a single message
func validateMessage(msg Message) error {
	if msg.ID == "" {
		return fmt.Errorf("message id field is required")
	}

	if msg.Role == "" {
		return fmt.Errorf("message role field is required")
	}

	if msg.ActivityType != "" && msg.Role != coretypes.RoleActivity {
		return fmt.Errorf("activityType is only valid for activity messages")
	}

	switch msg.Role {
	case coretypes.RoleDeveloper, coretypes.RoleSystem:
		if _, ok := msg.ContentString(); !ok {
			return fmt.Errorf("content field must be a string for %s messages", msg.Role)
		}
	case coretypes.RoleAssistant:
		if msg.Content != nil {
			if _, ok := msg.ContentString(); !ok {
				return fmt.Errorf("content field must be a string for assistant messages")
			}
		}
	case coretypes.RoleReasoning:
		if _, ok := msg.ContentString(); !ok {
			return fmt.Errorf("content field must be a string for reasoning messages")
		}
	case coretypes.RoleUser:
		if _, ok := msg.ContentString(); ok {
			break
		}
		if _, ok := msg.ContentInputContents(); ok {
			break
		}
		return fmt.Errorf("content field must be a string or input content array for user messages")
	case coretypes.RoleTool:
		if _, ok := msg.ContentString(); !ok {
			return fmt.Errorf("content field must be a string for tool messages")
		}
		if msg.ToolCallID == "" {
			return fmt.Errorf("toolCallId field is required for tool messages")
		}
	case coretypes.RoleActivity:
		if msg.ActivityType == "" {
			return fmt.Errorf("activityType field is required for activity messages")
		}
		if _, ok := msg.ContentActivity(); !ok {
			return fmt.Errorf("content field must be a map for activity messages")
		}
	default:
		return fmt.Errorf("unsupported message role: %s", msg.Role)
	}

	if msg.Role != coretypes.RoleAssistant && len(msg.ToolCalls) > 0 {
		return fmt.Errorf("toolCalls are only valid for assistant messages")
	}

	if msg.Role != coretypes.RoleTool {
		if msg.ToolCallID != "" {
			return fmt.Errorf("toolCallId is only valid for tool messages")
		}
		if msg.Error != "" {
			return fmt.Errorf("error is only valid for tool messages")
		}
	}

	// Validate tool calls if present
	for i, toolCall := range msg.ToolCalls {
		if err := validateToolCall(toolCall); err != nil {
			return fmt.Errorf("invalid tool call at index %d: %w", i, err)
		}
	}

	return nil
}

// validateToolCall validates a single tool call
func validateToolCall(toolCall ToolCall) error {
	if toolCall.ID == "" {
		return fmt.Errorf("tool call id field is required")
	}

	if toolCall.Type == "" {
		return fmt.Errorf("tool call type field is required")
	}

	if toolCall.Function.Name == "" {
		return fmt.Errorf("function name field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *MessagesSnapshotEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

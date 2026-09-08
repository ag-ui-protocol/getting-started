package events

import (
	"encoding/json"
	"fmt"
)

// ReasoningStartEvent marks the start of a reasoning phase.
type ReasoningStartEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewReasoningStartEvent creates a new reasoning start event.
func NewReasoningStartEvent(messageID string) *ReasoningStartEvent {
	return &ReasoningStartEvent{
		BaseEvent: NewBaseEvent(EventTypeReasoningStart),
		MessageID: messageID,
	}
}

// Validate validates the reasoning start event.
func (e *ReasoningStartEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}
	if e.MessageID == "" {
		return fmt.Errorf("ReasoningStartEvent validation failed: messageId field is required")
	}
	return nil
}

// ToJSON serializes the event to JSON.
func (e *ReasoningStartEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ReasoningEndEvent marks the end of a reasoning phase.
type ReasoningEndEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewReasoningEndEvent creates a new reasoning end event.
func NewReasoningEndEvent(messageID string) *ReasoningEndEvent {
	return &ReasoningEndEvent{
		BaseEvent: NewBaseEvent(EventTypeReasoningEnd),
		MessageID: messageID,
	}
}

// Validate validates the reasoning end event.
func (e *ReasoningEndEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}
	if e.MessageID == "" {
		return fmt.Errorf("ReasoningEndEvent validation failed: messageId field is required")
	}
	return nil
}

// ToJSON serializes the event to JSON.
func (e *ReasoningEndEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ReasoningMessageStartEvent indicates the start of a streaming reasoning message.
type ReasoningMessageStartEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
	Role      string `json:"role"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewReasoningMessageStartEvent creates a new reasoning message start event.
func NewReasoningMessageStartEvent(messageID, role string) *ReasoningMessageStartEvent {
	return &ReasoningMessageStartEvent{
		BaseEvent: NewBaseEvent(EventTypeReasoningMessageStart),
		MessageID: messageID,
		Role:      role,
	}
}

// Validate validates the reasoning message start event.
func (e *ReasoningMessageStartEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}
	if e.MessageID == "" {
		return fmt.Errorf("ReasoningMessageStartEvent validation failed: messageId field is required")
	}
	if e.Role == "" {
		return fmt.Errorf("ReasoningMessageStartEvent validation failed: role field is required")
	}
	return nil
}

// ToJSON serializes the event to JSON.
func (e *ReasoningMessageStartEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ReasoningMessageContentEvent contains streaming reasoning content.
type ReasoningMessageContentEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
	Delta     string `json:"delta"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewReasoningMessageContentEvent creates a new reasoning message content event.
func NewReasoningMessageContentEvent(messageID, delta string) *ReasoningMessageContentEvent {
	return &ReasoningMessageContentEvent{
		BaseEvent: NewBaseEvent(EventTypeReasoningMessageContent),
		MessageID: messageID,
		Delta:     delta,
	}
}

// Validate validates the reasoning message content event.
func (e *ReasoningMessageContentEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}
	if e.MessageID == "" {
		return fmt.Errorf("ReasoningMessageContentEvent validation failed: messageId field is required")
	}
	if e.Delta == "" {
		return fmt.Errorf("ReasoningMessageContentEvent validation failed: delta field must not be empty")
	}
	return nil
}

// ToJSON serializes the event to JSON.
func (e *ReasoningMessageContentEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ReasoningMessageEndEvent indicates the end of a streaming reasoning message.
type ReasoningMessageEndEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewReasoningMessageEndEvent creates a new reasoning message end event.
func NewReasoningMessageEndEvent(messageID string) *ReasoningMessageEndEvent {
	return &ReasoningMessageEndEvent{
		BaseEvent: NewBaseEvent(EventTypeReasoningMessageEnd),
		MessageID: messageID,
	}
}

// Validate validates the reasoning message end event.
func (e *ReasoningMessageEndEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}
	if e.MessageID == "" {
		return fmt.Errorf("ReasoningMessageEndEvent validation failed: messageId field is required")
	}
	return nil
}

// ToJSON serializes the event to JSON.
func (e *ReasoningMessageEndEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ReasoningMessageChunkEvent represents a chunk of reasoning message data.
type ReasoningMessageChunkEvent struct {
	*BaseEvent
	MessageID *string `json:"messageId,omitempty"`
	Delta     *string `json:"delta,omitempty"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewReasoningMessageChunkEvent creates a new reasoning message chunk event.
func NewReasoningMessageChunkEvent(messageID, delta *string) *ReasoningMessageChunkEvent {
	return &ReasoningMessageChunkEvent{
		BaseEvent: NewBaseEvent(EventTypeReasoningMessageChunk),
		MessageID: messageID,
		Delta:     delta,
	}
}

// WithChunkMessageID sets the message ID for the chunk.
func (e *ReasoningMessageChunkEvent) WithChunkMessageID(id string) *ReasoningMessageChunkEvent {
	e.MessageID = &id
	return e
}

// WithChunkDelta sets the delta content for the chunk.
func (e *ReasoningMessageChunkEvent) WithChunkDelta(delta string) *ReasoningMessageChunkEvent {
	e.Delta = &delta
	return e
}

// Validate validates the reasoning message chunk event.
func (e *ReasoningMessageChunkEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == nil && e.Delta == nil {
		return fmt.Errorf("ReasoningMessageChunkEvent validation failed: at least one of messageId or delta must be present")
	}

	if e.MessageID != nil && *e.MessageID == "" {
		return fmt.Errorf("ReasoningMessageChunkEvent validation failed: messageId field must not be empty when provided")
	}

	return nil
}

// ToJSON serializes the event to JSON.
func (e *ReasoningMessageChunkEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ReasoningEncryptedValueSubtype represents the entity type associated with an encrypted reasoning value.
type ReasoningEncryptedValueSubtype string

const (
	// ReasoningEncryptedValueSubtypeToolCall indicates the encrypted value is attached to a tool call.
	ReasoningEncryptedValueSubtypeToolCall ReasoningEncryptedValueSubtype = "tool-call"
	// ReasoningEncryptedValueSubtypeMessage indicates the encrypted value is attached to a message.
	ReasoningEncryptedValueSubtypeMessage  ReasoningEncryptedValueSubtype = "message"
)

// ReasoningEncryptedValueEvent attaches an encrypted reasoning value to a message or tool call.
type ReasoningEncryptedValueEvent struct {
	*BaseEvent
	Subtype        ReasoningEncryptedValueSubtype `json:"subtype"`
	EntityID       string                         `json:"entityId"`
	EncryptedValue string                         `json:"encryptedValue"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewReasoningEncryptedValueEvent creates a new reasoning encrypted value event.
func NewReasoningEncryptedValueEvent(subtype ReasoningEncryptedValueSubtype, entityID, encryptedValue string) *ReasoningEncryptedValueEvent {
	return &ReasoningEncryptedValueEvent{
		BaseEvent:      NewBaseEvent(EventTypeReasoningEncryptedValue),
		Subtype:        subtype,
		EntityID:       entityID,
		EncryptedValue: encryptedValue,
	}
}

// Validate validates the reasoning encrypted value event.
func (e *ReasoningEncryptedValueEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Subtype != ReasoningEncryptedValueSubtypeToolCall && e.Subtype != ReasoningEncryptedValueSubtypeMessage {
		return fmt.Errorf("ReasoningEncryptedValueEvent validation failed: subtype must be 'tool-call' or 'message'")
	}

	if e.EntityID == "" {
		return fmt.Errorf("ReasoningEncryptedValueEvent validation failed: entityId field is required")
	}

	if e.EncryptedValue == "" {
		return fmt.Errorf("ReasoningEncryptedValueEvent validation failed: encryptedValue field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON.
func (e *ReasoningEncryptedValueEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

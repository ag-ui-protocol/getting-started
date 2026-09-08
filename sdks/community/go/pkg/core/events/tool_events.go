package events

import (
	"encoding/json"
	"fmt"
)

// ToolCallStartEvent indicates the start of a tool call
type ToolCallStartEvent struct {
	*BaseEvent
	ToolCallID      string  `json:"toolCallId"`
	ToolCallName    string  `json:"toolCallName"`
	ParentMessageID *string `json:"parentMessageId,omitempty"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewToolCallStartEvent creates a new tool call start event
func NewToolCallStartEvent(toolCallID, toolCallName string, options ...ToolCallStartOption) *ToolCallStartEvent {
	event := &ToolCallStartEvent{
		BaseEvent:    NewBaseEvent(EventTypeToolCallStart),
		ToolCallID:   toolCallID,
		ToolCallName: toolCallName,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// ToolCallStartOption defines options for creating tool call start events
type ToolCallStartOption func(*ToolCallStartEvent)

// WithParentMessageID sets the parent message ID for the tool call
func WithParentMessageID(parentMessageID string) ToolCallStartOption {
	return func(e *ToolCallStartEvent) {
		e.ParentMessageID = &parentMessageID
	}
}

// WithAutoToolCallID automatically generates a unique tool call ID if the provided toolCallID is empty
func WithAutoToolCallID() ToolCallStartOption {
	return func(e *ToolCallStartEvent) {
		if e.ToolCallID == "" {
			e.ToolCallID = GenerateToolCallID()
		}
	}
}

// Validate validates the tool call start event
func (e *ToolCallStartEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ToolCallID == "" {
		return fmt.Errorf("ToolCallStartEvent validation failed: toolCallId field is required")
	}

	if e.ToolCallName == "" {
		return fmt.Errorf("ToolCallStartEvent validation failed: toolCallName field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *ToolCallStartEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToolCallArgsEvent contains streaming tool call arguments
type ToolCallArgsEvent struct {
	*BaseEvent
	ToolCallID string `json:"toolCallId"`
	Delta      string `json:"delta"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewToolCallArgsEvent creates a new tool call args event
func NewToolCallArgsEvent(toolCallID, delta string) *ToolCallArgsEvent {
	return &ToolCallArgsEvent{
		BaseEvent:  NewBaseEvent(EventTypeToolCallArgs),
		ToolCallID: toolCallID,
		Delta:      delta,
	}
}

// NewToolCallArgsEventWithOptions creates a new tool call args event with options
func NewToolCallArgsEventWithOptions(toolCallID, delta string, options ...ToolCallArgsOption) *ToolCallArgsEvent {
	event := &ToolCallArgsEvent{
		BaseEvent:  NewBaseEvent(EventTypeToolCallArgs),
		ToolCallID: toolCallID,
		Delta:      delta,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// ToolCallArgsOption defines options for creating tool call args events
type ToolCallArgsOption func(*ToolCallArgsEvent)

// WithAutoToolCallIDArgs automatically generates a unique tool call ID if the provided toolCallID is empty
func WithAutoToolCallIDArgs() ToolCallArgsOption {
	return func(e *ToolCallArgsEvent) {
		if e.ToolCallID == "" {
			e.ToolCallID = GenerateToolCallID()
		}
	}
}

// Validate validates the tool call args event
func (e *ToolCallArgsEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ToolCallID == "" {
		return fmt.Errorf("ToolCallArgsEvent validation failed: toolCallId field is required")
	}

	if e.Delta == "" {
		return fmt.Errorf("ToolCallArgsEvent validation failed: delta field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *ToolCallArgsEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToolCallEndEvent indicates the end of a tool call
type ToolCallEndEvent struct {
	*BaseEvent
	ToolCallID string `json:"toolCallId"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewToolCallEndEvent creates a new tool call end event
func NewToolCallEndEvent(toolCallID string) *ToolCallEndEvent {
	return &ToolCallEndEvent{
		BaseEvent:  NewBaseEvent(EventTypeToolCallEnd),
		ToolCallID: toolCallID,
	}
}

// NewToolCallEndEventWithOptions creates a new tool call end event with options
func NewToolCallEndEventWithOptions(toolCallID string, options ...ToolCallEndOption) *ToolCallEndEvent {
	event := &ToolCallEndEvent{
		BaseEvent:  NewBaseEvent(EventTypeToolCallEnd),
		ToolCallID: toolCallID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// ToolCallEndOption defines options for creating tool call end events
type ToolCallEndOption func(*ToolCallEndEvent)

// WithAutoToolCallIDEnd automatically generates a unique tool call ID if the provided toolCallID is empty
func WithAutoToolCallIDEnd() ToolCallEndOption {
	return func(e *ToolCallEndEvent) {
		if e.ToolCallID == "" {
			e.ToolCallID = GenerateToolCallID()
		}
	}
}

// Validate validates the tool call end event
func (e *ToolCallEndEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ToolCallID == "" {
		return fmt.Errorf("ToolCallEndEvent validation failed: toolCallId field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *ToolCallEndEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToolCallResultEvent represents the result of a tool call execution
type ToolCallResultEvent struct {
	*BaseEvent
	MessageID  string  `json:"messageId"`
	ToolCallID string  `json:"toolCallId"`
	Content    string  `json:"content"`
	Role       *string `json:"role,omitempty"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewToolCallResultEvent creates a new tool call result event
func NewToolCallResultEvent(messageID, toolCallID, content string) *ToolCallResultEvent {
	role := "tool"
	return &ToolCallResultEvent{
		BaseEvent:  NewBaseEvent(EventTypeToolCallResult),
		MessageID:  messageID,
		ToolCallID: toolCallID,
		Content:    content,
		Role:       &role,
	}
}

// Validate validates the tool call result event
func (e *ToolCallResultEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("ToolCallResultEvent validation failed: messageId field is required")
	}

	if e.ToolCallID == "" {
		return fmt.Errorf("ToolCallResultEvent validation failed: toolCallId field is required")
	}

	if e.Content == "" {
		return fmt.Errorf("ToolCallResultEvent validation failed: content field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *ToolCallResultEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ToolCallChunkEvent represents a chunk of tool call data
type ToolCallChunkEvent struct {
	*BaseEvent
	ToolCallID      *string `json:"toolCallId,omitempty"`
	ToolCallName    *string `json:"toolCallName,omitempty"`
	ParentMessageID *string `json:"parentMessageId,omitempty"`
	Delta           *string `json:"delta,omitempty"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewToolCallChunkEvent creates a new tool call chunk event
func NewToolCallChunkEvent() *ToolCallChunkEvent {
	return &ToolCallChunkEvent{
		BaseEvent: NewBaseEvent(EventTypeToolCallChunk),
	}
}

// WithToolCallChunkID sets the tool call ID for the chunk
func (e *ToolCallChunkEvent) WithToolCallChunkID(id string) *ToolCallChunkEvent {
	e.ToolCallID = &id
	return e
}

// WithToolCallChunkName sets the tool call name for the chunk
func (e *ToolCallChunkEvent) WithToolCallChunkName(name string) *ToolCallChunkEvent {
	e.ToolCallName = &name
	return e
}

// WithToolCallChunkDelta sets the delta content for the chunk
func (e *ToolCallChunkEvent) WithToolCallChunkDelta(delta string) *ToolCallChunkEvent {
	e.Delta = &delta
	return e
}

// WithToolCallChunkParentMessageID sets the parent message ID for the chunk
func (e *ToolCallChunkEvent) WithToolCallChunkParentMessageID(parentMessageID string) *ToolCallChunkEvent {
	e.ParentMessageID = &parentMessageID
	return e
}

// Validate validates the tool call chunk event
func (e *ToolCallChunkEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	// At least one field should be present
	if e.ToolCallID == nil && e.ToolCallName == nil && e.Delta == nil {
		return fmt.Errorf("ToolCallChunkEvent validation failed: at least one of toolCallId, toolCallName, or delta must be present")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *ToolCallChunkEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

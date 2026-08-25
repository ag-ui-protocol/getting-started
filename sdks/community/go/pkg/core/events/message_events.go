package events

import (
	"encoding/json"
	"fmt"
)

// TextMessageStartEvent indicates the start of a streaming text message
type TextMessageStartEvent struct {
	*BaseEvent
	MessageID string  `json:"messageId"`
	Role      *string `json:"role,omitempty"`
	Name      string  `json:"name,omitempty"`
}

// NewTextMessageStartEvent creates a new text message start event
func NewTextMessageStartEvent(messageID string, options ...TextMessageStartOption) *TextMessageStartEvent {
	event := &TextMessageStartEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageStart),
		MessageID: messageID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// TextMessageStartOption defines options for creating text message start events
type TextMessageStartOption func(*TextMessageStartEvent)

// WithRole sets the role for the message
func WithRole(role string) TextMessageStartOption {
	return func(e *TextMessageStartEvent) {
		e.Role = &role
	}
}

// WithName sets the sender name for the message (e.g. a sub-agent author).
func WithName(name string) TextMessageStartOption {
	return func(e *TextMessageStartEvent) {
		e.Name = name
	}
}

// WithAutoMessageID automatically generates a unique message ID if the provided messageID is empty
func WithAutoMessageID() TextMessageStartOption {
	return func(e *TextMessageStartEvent) {
		if e.MessageID == "" {
			e.MessageID = GenerateMessageID()
		}
	}
}

// Validate validates the text message start event
func (e *TextMessageStartEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("TextMessageStartEvent validation failed: messageId field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *TextMessageStartEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// TextMessageContentEvent contains a piece of streaming text message content
type TextMessageContentEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
	Delta     string `json:"delta"`
}

// NewTextMessageContentEvent creates a new text message content event
func NewTextMessageContentEvent(messageID, delta string) *TextMessageContentEvent {
	return &TextMessageContentEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageContent),
		MessageID: messageID,
		Delta:     delta,
	}
}

// NewTextMessageContentEventWithOptions creates a new text message content event with options
func NewTextMessageContentEventWithOptions(messageID, delta string, options ...TextMessageContentOption) *TextMessageContentEvent {
	event := &TextMessageContentEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageContent),
		MessageID: messageID,
		Delta:     delta,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// TextMessageContentOption defines options for creating text message content events
type TextMessageContentOption func(*TextMessageContentEvent)

// WithAutoMessageIDContent automatically generates a unique message ID if the provided messageID is empty
func WithAutoMessageIDContent() TextMessageContentOption {
	return func(e *TextMessageContentEvent) {
		if e.MessageID == "" {
			e.MessageID = GenerateMessageID()
		}
	}
}

// Validate validates the text message content event
func (e *TextMessageContentEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("TextMessageContentEvent validation failed: messageId field is required")
	}

	if e.Delta == "" {
		return fmt.Errorf("TextMessageContentEvent validation failed: delta field must not be empty")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *TextMessageContentEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// TextMessageEndEvent indicates the end of a streaming text message
type TextMessageEndEvent struct {
	*BaseEvent
	MessageID string `json:"messageId"`
}

// NewTextMessageEndEvent creates a new text message end event
func NewTextMessageEndEvent(messageID string) *TextMessageEndEvent {
	return &TextMessageEndEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageEnd),
		MessageID: messageID,
	}
}

// NewTextMessageEndEventWithOptions creates a new text message end event with options
func NewTextMessageEndEventWithOptions(messageID string, options ...TextMessageEndOption) *TextMessageEndEvent {
	event := &TextMessageEndEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageEnd),
		MessageID: messageID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// TextMessageEndOption defines options for creating text message end events
type TextMessageEndOption func(*TextMessageEndEvent)

// WithAutoMessageIDEnd automatically generates a unique message ID if the provided messageID is empty
func WithAutoMessageIDEnd() TextMessageEndOption {
	return func(e *TextMessageEndEvent) {
		if e.MessageID == "" {
			e.MessageID = GenerateMessageID()
		}
	}
}

// Validate validates the text message end event
func (e *TextMessageEndEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("TextMessageEndEvent validation failed: messageId field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *TextMessageEndEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// TextMessageChunkEvent represents a chunk of text message data
type TextMessageChunkEvent struct {
	*BaseEvent
	MessageID *string `json:"messageId,omitempty"`
	Role      *string `json:"role,omitempty"`
	Delta     *string `json:"delta,omitempty"`
	Name      *string `json:"name,omitempty"`
}

// NewTextMessageChunkEvent creates a new text message chunk event
func NewTextMessageChunkEvent(messageID, role, delta *string) *TextMessageChunkEvent {
	return &TextMessageChunkEvent{
		BaseEvent: NewBaseEvent(EventTypeTextMessageChunk),
		MessageID: messageID,
		Role:      role,
		Delta:     delta,
	}
}

// WithChunkMessageID sets the message ID for the chunk
func (e *TextMessageChunkEvent) WithChunkMessageID(id string) *TextMessageChunkEvent {
	e.MessageID = &id
	return e
}

// WithChunkRole sets the role for the chunk
func (e *TextMessageChunkEvent) WithChunkRole(role string) *TextMessageChunkEvent {
	e.Role = &role
	return e
}

// WithChunkDelta sets the delta content for the chunk
func (e *TextMessageChunkEvent) WithChunkDelta(delta string) *TextMessageChunkEvent {
	e.Delta = &delta
	return e
}

// WithChunkName sets the sender name for the chunk.
func (e *TextMessageChunkEvent) WithChunkName(name string) *TextMessageChunkEvent {
	e.Name = &name
	return e
}

// Validate validates the text message chunk event
func (e *TextMessageChunkEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	// At least one field should be present
	if e.MessageID == nil && e.Role == nil && e.Delta == nil && e.Name == nil {
		return fmt.Errorf("TextMessageChunkEvent validation failed: at least one of messageId, role, delta, or name must be present")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *TextMessageChunkEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

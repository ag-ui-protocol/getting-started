package events

import (
	"encoding/json"
	"fmt"
)

// RawEvent contains raw event data that should be passed through without processing
type RawEvent struct {
	*BaseEvent
	Event  any     `json:"event"`
	Source *string `json:"source,omitempty"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewRawEvent creates a new raw event
func NewRawEvent(event any, options ...RawEventOption) *RawEvent {
	rawEvent := &RawEvent{
		BaseEvent: NewBaseEvent(EventTypeRaw),
		Event:     event,
	}

	for _, opt := range options {
		opt(rawEvent)
	}

	return rawEvent
}

// RawEventOption defines options for creating raw events
type RawEventOption func(*RawEvent)

// WithSource sets the source for the raw event
func WithSource(source string) RawEventOption {
	return func(e *RawEvent) {
		e.Source = &source
	}
}

// Validate validates the raw event
func (e *RawEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Event == nil {
		return fmt.Errorf("RawEvent validation failed: event field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *RawEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// CustomEvent contains custom application-specific event data
type CustomEvent struct {
	*BaseEvent
	Name  string `json:"name"`
	Value any    `json:"value,omitempty"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewCustomEvent creates a new custom event
func NewCustomEvent(name string, options ...CustomEventOption) *CustomEvent {
	event := &CustomEvent{
		BaseEvent: NewBaseEvent(EventTypeCustom),
		Name:      name,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// CustomEventOption defines options for creating custom events
type CustomEventOption func(*CustomEvent)

// WithValue sets the value for the custom event
func WithValue(value any) CustomEventOption {
	return func(e *CustomEvent) {
		e.Value = value
	}
}

// Validate validates the custom event
func (e *CustomEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Name == "" {
		return fmt.Errorf("CustomEvent validation failed: name field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *CustomEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

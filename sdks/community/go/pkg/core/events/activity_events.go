package events

import (
	"encoding/json"
	"fmt"
)

// ActivitySnapshotEvent contains a snapshot of an activity message.
type ActivitySnapshotEvent struct {
	*BaseEvent
	MessageID    string `json:"messageId"`
	ActivityType string `json:"activityType"`
	Content      any    `json:"content"`
	Replace      *bool  `json:"replace,omitempty"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewActivitySnapshotEvent creates a new activity snapshot event.
func NewActivitySnapshotEvent(messageID, activityType string, content any) *ActivitySnapshotEvent {
	replace := true
	return &ActivitySnapshotEvent{
		BaseEvent:    NewBaseEvent(EventTypeActivitySnapshot),
		MessageID:    messageID,
		ActivityType: activityType,
		Content:      content,
		Replace:      &replace,
	}
}

// WithReplace sets the replace flag for the snapshot event.
func (e *ActivitySnapshotEvent) WithReplace(replace bool) *ActivitySnapshotEvent {
	e.Replace = &replace
	return e
}

// Validate validates the activity snapshot event.
func (e *ActivitySnapshotEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("ActivitySnapshotEvent validation failed: messageId field is required")
	}

	if e.ActivityType == "" {
		return fmt.Errorf("ActivitySnapshotEvent validation failed: activityType field is required")
	}

	if e.Content == nil {
		return fmt.Errorf("ActivitySnapshotEvent validation failed: content field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON.
func (e *ActivitySnapshotEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// ActivityDeltaEvent contains incremental updates for an activity message.
type ActivityDeltaEvent struct {
	*BaseEvent
	MessageID    string               `json:"messageId"`
	ActivityType string               `json:"activityType"`
	Patch        []JSONPatchOperation `json:"patch"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewActivityDeltaEvent creates a new activity delta event.
func NewActivityDeltaEvent(messageID, activityType string, patch []JSONPatchOperation) *ActivityDeltaEvent {
	return &ActivityDeltaEvent{
		BaseEvent:    NewBaseEvent(EventTypeActivityDelta),
		MessageID:    messageID,
		ActivityType: activityType,
		Patch:        patch,
	}
}

// Validate validates the activity delta event.
func (e *ActivityDeltaEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.MessageID == "" {
		return fmt.Errorf("ActivityDeltaEvent validation failed: messageId field is required")
	}

	if e.ActivityType == "" {
		return fmt.Errorf("ActivityDeltaEvent validation failed: activityType field is required")
	}

	if len(e.Patch) == 0 {
		return fmt.Errorf("ActivityDeltaEvent validation failed: patch field must contain at least one operation")
	}

	for i, op := range e.Patch {
		if err := validateJSONPatchOperation(op); err != nil {
			return fmt.Errorf("ActivityDeltaEvent validation failed: invalid patch operation at index %d: %w", i, err)
		}
	}

	return nil
}

// ToJSON serializes the event to JSON.
func (e *ActivityDeltaEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

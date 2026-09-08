package events

import (
	"encoding/json"
	"fmt"
)

// SubagentStartedEvent indicates a subagent has started within the run
type SubagentStartedEvent struct {
	*BaseEvent
	SubagentRunID string `json:"subagentRunId"`
	Name          string `json:"name"`
	Description   string `json:"description,omitempty"`
	// ParentSubagentRunID is the subagent that spawned this one, for nesting.
	ParentSubagentRunID string `json:"parentSubagentRunId,omitempty"`
	// ParentToolCallID links back to the tool call that spawned this subagent,
	// for the agents-as-tools pattern. It lets a consumer correlate the
	// subagent to its spawning call without inspecting the raw event.
	ParentToolCallID string `json:"parentToolCallId,omitempty"`
	// ParentMessageID is the message that held the spawning tool call.
	ParentMessageID string `json:"parentMessageId,omitempty"`
}

// NewSubagentStartedEvent creates a new subagent started event
func NewSubagentStartedEvent(subagentRunID, name string, options ...SubagentStartedOption) *SubagentStartedEvent {
	event := &SubagentStartedEvent{
		BaseEvent:     NewBaseEvent(EventTypeSubagentStarted),
		SubagentRunID: subagentRunID,
		Name:          name,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// SubagentStartedOption defines options for creating subagent started events
type SubagentStartedOption func(*SubagentStartedEvent)

// WithSubagentDescription sets the description for the subagent
func WithSubagentDescription(description string) SubagentStartedOption {
	return func(e *SubagentStartedEvent) {
		e.Description = description
	}
}

// WithParentSubagentRunID sets the subagent that spawned this one
func WithParentSubagentRunID(parentSubagentRunID string) SubagentStartedOption {
	return func(e *SubagentStartedEvent) {
		e.ParentSubagentRunID = parentSubagentRunID
	}
}

// WithParentToolCall sets the tool call, and the message that held it, that spawned this subagent
func WithParentToolCall(parentToolCallID, parentMessageID string) SubagentStartedOption {
	return func(e *SubagentStartedEvent) {
		e.ParentToolCallID = parentToolCallID
		e.ParentMessageID = parentMessageID
	}
}

// Validate validates the subagent started event
func (e *SubagentStartedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.SubagentRunID == "" {
		return fmt.Errorf("SubagentStartedEvent validation failed: subagentRunId field is required")
	}

	if e.Name == "" {
		return fmt.Errorf("SubagentStartedEvent validation failed: name field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *SubagentStartedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// SubagentFinishedOutcomeType discriminates between outcome variants.
type SubagentFinishedOutcomeType string

const (
	// SubagentFinishedOutcomeTypeSuccess indicates the subagent completed its work.
	SubagentFinishedOutcomeTypeSuccess SubagentFinishedOutcomeType = "success"
	// SubagentFinishedOutcomeTypeSuspended indicates the subagent is paused awaiting outside input.
	SubagentFinishedOutcomeTypeSuspended SubagentFinishedOutcomeType = "suspended"
)

// SubagentFinishedOutcome represents the outcome of a finished subagent.
// Type discriminates between success and suspended variants.
//
// This mirrors RunFinishedOutcome one level down: a subagent's terminal event
// closes its stream segment for THIS run either because the work completed
// ("success") or because the workflow is paused awaiting outside input
// ("suspended" — the run ends with an interrupt outcome, and on resume the same
// subagentRunId is re-announced as a continuation of the suspended invocation).
// An omitted outcome means legacy success. Without this, a paused subagent was
// indistinguishable from a completed one.
type SubagentFinishedOutcome struct {
	// Type is the outcome discriminator ("success" or "suspended").
	Type SubagentFinishedOutcomeType `json:"type"`
	// InterruptIDs names the run-level interrupts this subagent directly owns.
	// Only populated when Type is "suspended", and it may be empty even then:
	// an ancestor subagent suspended because a descendant interrupted owns no
	// interrupt itself.
	InterruptIDs []string `json:"interruptIds,omitempty"`
}

// MarshalJSON implements json.Marshaler.
//
// InterruptIDs belongs only to the suspended variant. TypeScript parses the
// outcome as a strict discriminated union, so a success outcome carrying the
// key is rejected outright; dropping it here means a caller that sets both
// cannot put an unparseable event on the wire.
func (o SubagentFinishedOutcome) MarshalJSON() ([]byte, error) {
	// Alias the type so marshalling does not recurse into this method.
	type outcome SubagentFinishedOutcome

	if o.Type != SubagentFinishedOutcomeTypeSuspended {
		o.InterruptIDs = nil
	}

	return json.Marshal(outcome(o))
}

// SubagentFinishedEvent indicates a subagent has finished
type SubagentFinishedEvent struct {
	*BaseEvent
	SubagentRunID string `json:"subagentRunId"`
	// Result is the subagent's completion payload, mirroring RunFinishedEvent.Result.
	Result  any                      `json:"result,omitempty"`
	Outcome *SubagentFinishedOutcome `json:"outcome,omitempty"`
}

// NewSubagentFinishedEvent creates a new subagent finished event
func NewSubagentFinishedEvent(subagentRunID string, options ...SubagentFinishedOption) *SubagentFinishedEvent {
	event := &SubagentFinishedEvent{
		BaseEvent:     NewBaseEvent(EventTypeSubagentFinished),
		SubagentRunID: subagentRunID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// SubagentFinishedOption defines options for creating subagent finished events
type SubagentFinishedOption func(*SubagentFinishedEvent)

// WithSubagentResult sets the completion payload for the subagent
func WithSubagentResult(result any) SubagentFinishedOption {
	return func(e *SubagentFinishedEvent) {
		e.Result = result
	}
}

// WithSubagentSuccessOutcome sets the outcome to success for the subagent finished event
func WithSubagentSuccessOutcome() SubagentFinishedOption {
	return func(e *SubagentFinishedEvent) {
		e.Outcome = &SubagentFinishedOutcome{Type: SubagentFinishedOutcomeTypeSuccess}
	}
}

// WithSubagentSuspendedOutcome sets the outcome to suspended with the interrupts the subagent owns
func WithSubagentSuspendedOutcome(interruptIDs []string) SubagentFinishedOption {
	return func(e *SubagentFinishedEvent) {
		e.Outcome = &SubagentFinishedOutcome{
			Type:         SubagentFinishedOutcomeTypeSuspended,
			InterruptIDs: interruptIDs,
		}
	}
}

// Validate validates the subagent finished event
func (e *SubagentFinishedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.SubagentRunID == "" {
		return fmt.Errorf("SubagentFinishedEvent validation failed: subagentRunId field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *SubagentFinishedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// SubagentErrorEvent indicates a subagent has errored, independent of the run
type SubagentErrorEvent struct {
	*BaseEvent
	SubagentRunID string  `json:"subagentRunId"`
	Message       string  `json:"message"`
	Code          *string `json:"code,omitempty"`
}

// NewSubagentErrorEvent creates a new subagent error event
func NewSubagentErrorEvent(subagentRunID, message string, options ...SubagentErrorOption) *SubagentErrorEvent {
	event := &SubagentErrorEvent{
		BaseEvent:     NewBaseEvent(EventTypeSubagentError),
		SubagentRunID: subagentRunID,
		Message:       message,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// SubagentErrorOption defines options for creating subagent error events
type SubagentErrorOption func(*SubagentErrorEvent)

// WithSubagentErrorCode sets the error code for the subagent error event
func WithSubagentErrorCode(code string) SubagentErrorOption {
	return func(e *SubagentErrorEvent) {
		e.Code = &code
	}
}

// Validate validates the subagent error event
func (e *SubagentErrorEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.SubagentRunID == "" {
		return fmt.Errorf("SubagentErrorEvent validation failed: subagentRunId field is required")
	}

	if e.Message == "" {
		return fmt.Errorf("SubagentErrorEvent validation failed: message field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *SubagentErrorEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

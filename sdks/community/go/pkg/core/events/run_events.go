package events

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

// RunStartedEvent indicates that an agent run has started
type RunStartedEvent struct {
	*BaseEvent
	ThreadIDValue string `json:"threadId"`
	RunIDValue    string `json:"runId"`
}

// NewRunStartedEvent creates a new run started event
func NewRunStartedEvent(threadID, runID string) *RunStartedEvent {
	return &RunStartedEvent{
		BaseEvent:     NewBaseEvent(EventTypeRunStarted),
		ThreadIDValue: threadID,
		RunIDValue:    runID,
	}
}

// NewRunStartedEventWithOptions creates a new run started event with options
func NewRunStartedEventWithOptions(threadID, runID string, options ...RunStartedOption) *RunStartedEvent {
	event := &RunStartedEvent{
		BaseEvent:     NewBaseEvent(EventTypeRunStarted),
		ThreadIDValue: threadID,
		RunIDValue:    runID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// RunStartedOption defines options for creating run started events
type RunStartedOption func(*RunStartedEvent)

// WithAutoRunID automatically generates a unique run ID if the provided runID is empty
func WithAutoRunID() RunStartedOption {
	return func(e *RunStartedEvent) {
		if e.RunIDValue == "" {
			e.RunIDValue = GenerateRunID()
		}
	}
}

// WithAutoThreadID automatically generates a unique thread ID if the provided threadID is empty
func WithAutoThreadID() RunStartedOption {
	return func(e *RunStartedEvent) {
		if e.ThreadIDValue == "" {
			e.ThreadIDValue = GenerateThreadID()
		}
	}
}

// Validate validates the run started event
func (e *RunStartedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ThreadIDValue == "" {
		return fmt.Errorf("RunStartedEvent validation failed: threadId field is required")
	}

	if e.RunIDValue == "" {
		return fmt.Errorf("RunStartedEvent validation failed: runId field is required")
	}

	return nil
}

// ThreadID returns the thread ID
func (e *RunStartedEvent) ThreadID() string {
	return e.ThreadIDValue
}

// RunID returns the run ID
func (e *RunStartedEvent) RunID() string {
	return e.RunIDValue
}

// ToJSON serializes the event to JSON
func (e *RunStartedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// RunFinishedOutcomeType discriminates between outcome variants.
type RunFinishedOutcomeType string

const (
	// RunFinishedOutcomeTypeSuccess indicates the run completed normally.
	RunFinishedOutcomeTypeSuccess RunFinishedOutcomeType = "success"
	// RunFinishedOutcomeTypeInterrupt indicates the run paused on one or more interrupts.
	RunFinishedOutcomeTypeInterrupt RunFinishedOutcomeType = "interrupt"
)

// RunFinishedOutcome represents the outcome of a finished run.
// Type discriminates between success and interrupt variants.
type RunFinishedOutcome struct {
	// Type is the outcome discriminator ("success" or "interrupt").
	Type RunFinishedOutcomeType `json:"type"`
	// Interrupts is the list of interrupts that caused the run to pause.
	// Only populated when Type is "interrupt". Must contain at least one entry.
	Interrupts []types.Interrupt `json:"interrupts,omitempty"`
}

// MarshalJSON implements json.Marshaler.
//
// Interrupts belongs only to the interrupt variant. TypeScript parses the
// outcome as a strict discriminated union and Python models each variant as its
// own type, so a success outcome carrying the key is rejected by both; dropping
// it here means a caller that sets both cannot put an unparseable event on the
// wire.
func (o RunFinishedOutcome) MarshalJSON() ([]byte, error) {
	// Alias the type so marshalling does not recurse into this method.
	type outcome RunFinishedOutcome

	if o.Type != RunFinishedOutcomeTypeInterrupt {
		o.Interrupts = nil
	}

	return json.Marshal(outcome(o))
}

// RunFinishedEvent indicates that an agent run has finished successfully
type RunFinishedEvent struct {
	*BaseEvent
	ThreadIDValue string              `json:"threadId"`
	RunIDValue    string              `json:"runId"`
	Result        interface{}         `json:"result,omitempty"`
	Outcome       *RunFinishedOutcome `json:"outcome,omitempty"`
	// Usage is optional per-(provider, model) token usage for the completed run.
	// A list so runs that invoke multiple models keep them separate for
	// downstream display; consumers that only need totals sum across entries.
	Usage []TokenUsage `json:"usage,omitempty"`
}

// NewRunFinishedEvent creates a new run finished event
func NewRunFinishedEvent(threadID, runID string) *RunFinishedEvent {
	return &RunFinishedEvent{
		BaseEvent:     NewBaseEvent(EventTypeRunFinished),
		ThreadIDValue: threadID,
		RunIDValue:    runID,
	}
}

// NewRunFinishedEventWithOptions creates a new run finished event with options
func NewRunFinishedEventWithOptions(threadID, runID string, options ...RunFinishedOption) *RunFinishedEvent {
	event := &RunFinishedEvent{
		BaseEvent:     NewBaseEvent(EventTypeRunFinished),
		ThreadIDValue: threadID,
		RunIDValue:    runID,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// RunFinishedOption defines options for creating run finished events
type RunFinishedOption func(*RunFinishedEvent)

// WithAutoRunIDFinished automatically generates a unique run ID if the provided runID is empty
func WithAutoRunIDFinished() RunFinishedOption {
	return func(e *RunFinishedEvent) {
		if e.RunIDValue == "" {
			e.RunIDValue = GenerateRunID()
		}
	}
}

// WithAutoThreadIDFinished automatically generates a unique thread ID if the provided threadID is empty
func WithAutoThreadIDFinished() RunFinishedOption {
	return func(e *RunFinishedEvent) {
		if e.ThreadIDValue == "" {
			e.ThreadIDValue = GenerateThreadID()
		}
	}
}

// WithResult sets the result for the run finished event
func WithResult(result interface{}) RunFinishedOption {
	return func(e *RunFinishedEvent) {
		e.Result = result
	}
}

// WithOutcome sets the outcome for the run finished event
func WithOutcome(outcome RunFinishedOutcome) RunFinishedOption {
	return func(e *RunFinishedEvent) {
		e.Outcome = &outcome
	}
}

// WithUsage sets the token usage for the run finished event
func WithUsage(usage []TokenUsage) RunFinishedOption {
	return func(e *RunFinishedEvent) {
		e.Usage = usage
	}
}

// WithSuccessOutcome sets the outcome to success for the run finished event
func WithSuccessOutcome() RunFinishedOption {
	return func(e *RunFinishedEvent) {
		e.Outcome = &RunFinishedOutcome{Type: RunFinishedOutcomeTypeSuccess}
	}
}

// WithInterruptOutcome sets the outcome to interrupt with the given interrupts
func WithInterruptOutcome(interrupts []types.Interrupt) RunFinishedOption {
	return func(e *RunFinishedEvent) {
		e.Outcome = &RunFinishedOutcome{
			Type:       RunFinishedOutcomeTypeInterrupt,
			Interrupts: interrupts,
		}
	}
}

// Validate validates the run finished event
func (e *RunFinishedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.ThreadIDValue == "" {
		return fmt.Errorf("RunFinishedEvent validation failed: threadId field is required")
	}

	if e.RunIDValue == "" {
		return fmt.Errorf("RunFinishedEvent validation failed: runId field is required")
	}

	// The peer SDKs require at least one interrupt on this variant: TypeScript
	// with `.min(1)`, Python with a non-empty validator. Go's `omitempty` would
	// otherwise drop an empty list and emit a bare {"type": "interrupt"}, which
	// both reject as missing a required field.
	if e.Outcome != nil && e.Outcome.Type == RunFinishedOutcomeTypeInterrupt && len(e.Outcome.Interrupts) == 0 {
		return fmt.Errorf("RunFinishedEvent validation failed: outcome 'interrupt' requires at least one interrupt")
	}

	if err := validateUsage("RunFinished", e.Usage); err != nil {
		return err
	}

	return nil
}

// ThreadID returns the thread ID
func (e *RunFinishedEvent) ThreadID() string {
	return e.ThreadIDValue
}

// RunID returns the run ID
func (e *RunFinishedEvent) RunID() string {
	return e.RunIDValue
}

// ToJSON serializes the event to JSON
func (e *RunFinishedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// RunErrorEvent indicates that an agent run has encountered an error
type RunErrorEvent struct {
	*BaseEvent
	Code       *string `json:"code,omitempty"`
	Message    string  `json:"message"`
	RunIDValue string  `json:"runId,omitempty"`
	// Usage is optional partial token usage for a run that failed after one or
	// more model calls completed. Same numeric-only shape as RUN_FINISHED.
	Usage []TokenUsage `json:"usage,omitempty"`
}

// NewRunErrorEvent creates a new run error event
func NewRunErrorEvent(message string, options ...RunErrorOption) *RunErrorEvent {
	event := &RunErrorEvent{
		BaseEvent: NewBaseEvent(EventTypeRunError),
		Message:   message,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// RunErrorOption defines options for creating run error events
type RunErrorOption func(*RunErrorEvent)

// WithErrorCode sets the error code
func WithErrorCode(code string) RunErrorOption {
	return func(e *RunErrorEvent) {
		e.Code = &code
	}
}

// WithErrorUsage sets the partial token usage for the run error event
func WithErrorUsage(usage []TokenUsage) RunErrorOption {
	return func(e *RunErrorEvent) {
		e.Usage = usage
	}
}

// WithRunID sets the run ID for the error
func WithRunID(runID string) RunErrorOption {
	return func(e *RunErrorEvent) {
		e.RunIDValue = runID
	}
}

// WithAutoRunIDError automatically generates a unique run ID if the provided runID is empty
func WithAutoRunIDError() RunErrorOption {
	return func(e *RunErrorEvent) {
		if e.RunIDValue == "" {
			e.RunIDValue = GenerateRunID()
		}
	}
}

// Validate validates the run error event
func (e *RunErrorEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.Message == "" {
		return fmt.Errorf("RunErrorEvent validation failed: message field is required")
	}

	if err := validateUsage("RunError", e.Usage); err != nil {
		return err
	}

	return nil
}

// RunID returns the run ID
func (e *RunErrorEvent) RunID() string {
	return e.RunIDValue
}

// ToJSON serializes the event to JSON
func (e *RunErrorEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// StepStartedEvent indicates that an agent step has started
type StepStartedEvent struct {
	*BaseEvent
	StepName string `json:"stepName"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewStepStartedEvent creates a new step started event
func NewStepStartedEvent(stepName string) *StepStartedEvent {
	return &StepStartedEvent{
		BaseEvent: NewBaseEvent(EventTypeStepStarted),
		StepName:  stepName,
	}
}

// NewStepStartedEventWithOptions creates a new step started event with options
func NewStepStartedEventWithOptions(stepName string, options ...StepStartedOption) *StepStartedEvent {
	event := &StepStartedEvent{
		BaseEvent: NewBaseEvent(EventTypeStepStarted),
		StepName:  stepName,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// StepStartedOption defines options for creating step started events
type StepStartedOption func(*StepStartedEvent)

// WithAutoStepName automatically generates a unique step name if the provided stepName is empty
func WithAutoStepName() StepStartedOption {
	return func(e *StepStartedEvent) {
		if e.StepName == "" {
			e.StepName = GenerateStepID()
		}
	}
}

// Validate validates the step started event
func (e *StepStartedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.StepName == "" {
		return fmt.Errorf("StepStartedEvent validation failed: stepName field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StepStartedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

// StepFinishedEvent indicates that an agent step has finished
type StepFinishedEvent struct {
	*BaseEvent
	StepName string `json:"stepName"`
	// SubagentRunID attributes this event to a subagent invocation.
	// Empty when the event comes from the root agent.
	SubagentRunID string `json:"subagentRunId,omitempty"`
}

// NewStepFinishedEvent creates a new step finished event
func NewStepFinishedEvent(stepName string) *StepFinishedEvent {
	return &StepFinishedEvent{
		BaseEvent: NewBaseEvent(EventTypeStepFinished),
		StepName:  stepName,
	}
}

// NewStepFinishedEventWithOptions creates a new step finished event with options
func NewStepFinishedEventWithOptions(stepName string, options ...StepFinishedOption) *StepFinishedEvent {
	event := &StepFinishedEvent{
		BaseEvent: NewBaseEvent(EventTypeStepFinished),
		StepName:  stepName,
	}

	for _, opt := range options {
		opt(event)
	}

	return event
}

// StepFinishedOption defines options for creating step finished events
type StepFinishedOption func(*StepFinishedEvent)

// WithAutoStepNameFinished automatically generates a unique step name if the provided stepName is empty
func WithAutoStepNameFinished() StepFinishedOption {
	return func(e *StepFinishedEvent) {
		if e.StepName == "" {
			e.StepName = GenerateStepID()
		}
	}
}

// Validate validates the step finished event
func (e *StepFinishedEvent) Validate() error {
	if err := e.BaseEvent.Validate(); err != nil {
		return err
	}

	if e.StepName == "" {
		return fmt.Errorf("StepFinishedEvent validation failed: stepName field is required")
	}

	return nil
}

// ToJSON serializes the event to JSON
func (e *StepFinishedEvent) ToJSON() ([]byte, error) {
	return json.Marshal(e)
}

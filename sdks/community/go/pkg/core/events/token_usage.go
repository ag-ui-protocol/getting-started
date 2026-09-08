package events

import "fmt"

// TokenUsage is a numeric-only, per-(provider, model) token usage summary.
//
// Deliberately carries no content-bearing or identifying fields — no prompts,
// completions, messages, or thread/run/user IDs — only provider and model
// labels and numeric counts. Usage feeds anonymous telemetry, so nothing that
// could carry user content may be added here.
//
// Counts are pointers because zero is meaningful data: a call that produced no
// output tokens is not the same as a call that did not report the figure.
// int64 matches the protobuf `int64` and the .NET `long?` bindings.
type TokenUsage struct {
	// Provider is the model provider label (e.g. "openai", "google").
	Provider string `json:"provider,omitempty"`
	// Model is the model label (e.g. "gemini-3.5-flash").
	Model string `json:"model,omitempty"`
	// InputTokens is the number of tokens in the prompt.
	InputTokens *int64 `json:"inputTokens,omitempty"`
	// OutputTokens is the number of tokens in the completion.
	OutputTokens *int64 `json:"outputTokens,omitempty"`
	// TotalTokens is the total across input and output.
	TotalTokens *int64 `json:"totalTokens,omitempty"`
	// ReasoningTokens is the number of tokens spent on reasoning.
	ReasoningTokens *int64 `json:"reasoningTokens,omitempty"`
	// CachedInputTokens is the number of prompt tokens served from cache.
	CachedInputTokens *int64 `json:"cachedInputTokens,omitempty"`
}

// Validate validates a token usage entry.
//
// The peer SDKs constrain every count to a non-negative integer — TypeScript
// with `z.number().int().nonnegative()`, .NET with an unsigned reading of
// `long?` — and the protobuf transport writes them through an int64 writer.
// Rejecting a negative here turns a bad producer value into an error at the
// source rather than a rejected event, or a mid-stream crash, at the receiver.
func (u TokenUsage) Validate() error {
	for _, count := range []struct {
		name  string
		value *int64
	}{
		{"inputTokens", u.InputTokens},
		{"outputTokens", u.OutputTokens},
		{"totalTokens", u.TotalTokens},
		{"reasoningTokens", u.ReasoningTokens},
		{"cachedInputTokens", u.CachedInputTokens},
	} {
		if count.value != nil && *count.value < 0 {
			return fmt.Errorf("TokenUsage validation failed: %s must not be negative", count.name)
		}
	}

	return nil
}

// validateUsage validates every entry in a usage list, naming the event that
// carries it so the message matches the rest of the package.
func validateUsage(eventName string, usage []TokenUsage) error {
	for i, entry := range usage {
		if err := entry.Validate(); err != nil {
			return fmt.Errorf("%sEvent validation failed: usage[%d]: %w", eventName, i, err)
		}
	}

	return nil
}

// TokenCount returns a pointer to the given count, for populating a TokenUsage.
func TokenCount(count int64) *int64 {
	return &count
}

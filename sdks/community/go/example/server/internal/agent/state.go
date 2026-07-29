package agent

import (
	"encoding/json"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
)

// State is the agent's shared state, surfaced to the UI via AG-UI STATE_SNAPSHOT
// and incremental STATE_DELTA (RFC-6902 JSON Patch) events.
type State struct {
	Status    string
	FilesRead []string
	ToolCalls int
	extra     map[string]any // arbitrary client-seeded state
}

// NewState returns a fresh running state.
func NewState() *State {
	return &State{Status: "running", FilesRead: []string{}, extra: map[string]any{}}
}

// StateFromSnapshot rebuilds a State from a persisted snapshot (used on resume).
// The keys "status", "filesRead", and "toolCalls" are reserved for the agent
// lifecycle; client-seeded values under those keys are coerced into the typed
// fields, not preserved as extra.
func StateFromSnapshot(m map[string]any) *State {
	s := NewState()
	if m == nil {
		return s
	}
	for k, v := range m {
		switch k {
		case "status":
			if str, ok := v.(string); ok {
				s.Status = str
			}
		case "filesRead":
			s.FilesRead = toStringSlice(v)
		case "toolCalls":
			s.ToolCalls = toInt(v)
		default:
			s.extra[k] = v
		}
	}
	return s
}

// Seed merges client-supplied state (from RunAgentInput.State) into extra keys.
func (s *State) Seed(v any) {
	if m, ok := v.(map[string]any); ok {
		for k, val := range m {
			s.extra[k] = val
		}
	}
}

// Snapshot returns the full state as a plain map for STATE_SNAPSHOT / persistence.
// FilesRead is copied so the returned map (which may be stored in runstore) does
// not alias the live backing slice. extra values are copied shallowly — fine today
// because nothing mutates a seeded value after Seed; if extra ever becomes mutable,
// deep-copy here to avoid aliasing the snapshot held by the SSE encoder and runstore.
func (s *State) Snapshot() map[string]any {
	m := map[string]any{}
	for k, v := range s.extra {
		m[k] = v
	}
	files := make([]string, len(s.FilesRead))
	copy(files, s.FilesRead)
	m["status"] = s.Status
	m["filesRead"] = files
	m["toolCalls"] = s.ToolCalls
	return m
}

// RecordFileRead mutates state for a completed file read and returns the JSON
// Patch describing the change (for a STATE_DELTA event). filesRead is an append-log,
// not a set: the same path read twice appears twice (mirroring the toolCalls count).
func (s *State) RecordFileRead(path string) []events.JSONPatchOperation {
	s.ToolCalls++
	s.FilesRead = append(s.FilesRead, path)
	s.Status = "reading"
	return []events.JSONPatchOperation{
		{Op: "replace", Path: "/status", Value: "reading"},
		{Op: "replace", Path: "/toolCalls", Value: s.ToolCalls},
		{Op: "add", Path: "/filesRead/-", Value: path},
	}
}

// SetStatus mutates the status and returns the JSON Patch for it.
func (s *State) SetStatus(status string) []events.JSONPatchOperation {
	s.Status = status
	return []events.JSONPatchOperation{{Op: "replace", Path: "/status", Value: status}}
}

// toStringSlice and toInt are intentionally lenient: a client that seeds a reserved
// key (status/filesRead/toolCalls) with the wrong JSON type gets a zero value rather
// than an error, since the agent owns those keys and overwrites them anyway.
func toStringSlice(v any) []string {
	switch t := v.(type) {
	case []string:
		// Copy so a caller-owned slice can't be mutated by a later RecordFileRead append.
		out := make([]string, len(t))
		copy(out, t)
		return out
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return []string{}
}

func toInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case float64:
		return int(t)
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return int(n)
		}
	}
	return 0
}

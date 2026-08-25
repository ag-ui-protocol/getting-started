package agent

import (
	"encoding/json"
	"fmt"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	jsonpatch "github.com/evanphx/json-patch"
)

// DocState is a minimal collaborative-document state container for the feature
// routes (agentic_generative_ui, shared_state, predictive_state_updates).
//
// Unlike the lifecycle State (internal/agent/state.go), it snapshots the raw
// document verbatim — there are NO reserved status/filesRead/toolCalls keys. The
// document is whatever shape the route owns (e.g. {"steps":[...]} or
// {"recipe":{...}}), and STATE_DELTA patches target paths inside it directly.
//
// DocState keeps the in-memory document and the emitted RFC-6902 deltas in lock
// step: Apply mutates the document by applying the same patch the caller will emit
// as a STATE_DELTA, so a later Snapshot reflects every delta and a client that
// replays snapshot+deltas reproduces the server's state.
type DocState struct {
	doc map[string]any
}

// NewDocState builds a DocState from a seed document (deep-copied so the caller's
// map is never aliased or mutated). A nil seed yields an empty document.
func NewDocState(seed map[string]any) *DocState {
	return &DocState{doc: deepCopyJSONMap(seed)}
}

// Snapshot returns a deep copy of the document for STATE_SNAPSHOT / persistence,
// so the returned value never aliases the live backing document.
func (d *DocState) Snapshot() map[string]any {
	return deepCopyJSONMap(d.doc)
}

// Apply applies an RFC-6902 patch to the document, keeping it consistent so a
// later Snapshot reflects the change. It returns an error (without mutating the
// document) if the patch is malformed or does not apply — callers surface that as
// RUN_ERROR rather than emitting a STATE_DELTA the snapshot can't reproduce.
func (d *DocState) Apply(ops []events.JSONPatchOperation) error {
	if len(ops) == 0 {
		return nil
	}
	patchJSON, err := json.Marshal(ops)
	if err != nil {
		return fmt.Errorf("marshal patch: %w", err)
	}
	patch, err := jsonpatch.DecodePatch(patchJSON)
	if err != nil {
		return fmt.Errorf("decode patch: %w", err)
	}
	docJSON, err := json.Marshal(d.doc)
	if err != nil {
		return fmt.Errorf("marshal document: %w", err)
	}
	out, err := patch.Apply(docJSON)
	if err != nil {
		return fmt.Errorf("apply patch: %w", err)
	}
	var next map[string]any
	if err := json.Unmarshal(out, &next); err != nil {
		return fmt.Errorf("unmarshal patched document: %w", err)
	}
	if next == nil {
		next = map[string]any{}
	}
	d.doc = next
	return nil
}

// deepCopyJSONMap deep-copies an arbitrary JSON-ish map by round-tripping through
// JSON. This is the same value space the document lives in (it came from / goes to
// JSON over the wire), so it is faithful and avoids aliasing the snapshot held by
// the SSE encoder. A nil or unmarshalable input yields a fresh empty map.
func deepCopyJSONMap(m map[string]any) map[string]any {
	if len(m) == 0 {
		return map[string]any{}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

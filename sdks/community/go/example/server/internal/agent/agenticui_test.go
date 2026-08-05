package agent

import (
	"bufio"
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
)

// runAgenticUI drives AgenticGenerativeUI.Run with an instant pace and returns the
// raw SSE the client would receive.
func runAgenticUI(t *testing.T, in *aguitypes.RunAgentInput) string {
	t.Helper()
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), in.ThreadID, in.RunID, nil)
	AgenticGenerativeUI{Pace: 0}.Run(context.Background(), emit, in, in.ThreadID, in.RunID)
	_ = w.Flush()
	return buf.String()
}

func TestAgenticGenerativeUI_Sequence(t *testing.T) {
	in := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r", Messages: []aguitypes.Message{
		{ID: "u1", Role: aguitypes.RoleUser, Content: "Plan a trip"},
	}}
	out := runAgenticUI(t, in)

	// Lifecycle + steps brackets.
	for _, want := range []string{
		`"type":"RUN_STARTED"`,
		`"type":"STEP_STARTED"`,
		`"stepName":"plan"`,
		`"type":"STATE_SNAPSHOT"`,
		`"stepName":"execute"`,
		`"type":"STATE_DELTA"`,
		`"type":"TEXT_MESSAGE_CONTENT"`,
		"All steps complete.",
		`"type":"RUN_FINISHED"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("unexpected RUN_ERROR:\n%s", out)
	}

	// Snapshot starts all pending; deltas advance step 0 through in_progress→completed.
	snapIdx := strings.Index(out, `"type":"STATE_SNAPSHOT"`)
	if snapIdx < 0 || !strings.Contains(out[snapIdx:snapIdx+400], `"status":"pending"`) {
		t.Errorf("snapshot should carry pending steps:\n%s", out)
	}
	if !strings.Contains(out, `"path":"/steps/0/status"`) {
		t.Errorf("expected a /steps/0/status delta:\n%s", out)
	}
	if !strings.Contains(out, `"value":"in_progress"`) || !strings.Contains(out, `"value":"completed"`) {
		t.Errorf("expected in_progress and completed transitions:\n%s", out)
	}
	// The prompt-aware first step.
	if !strings.Contains(out, "Understand the request") {
		t.Errorf("expected prompt-aware first step:\n%s", out)
	}
}

func TestAgenticGenerativeUI_CancelStops(t *testing.T) {
	in := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled before the run
	emit := NewEmitter(ctx, w, sse.NewSSEWriter(), in.ThreadID, in.RunID, nil)
	AgenticGenerativeUI{Pace: 0}.Run(ctx, emit, in, in.ThreadID, in.RunID)
	_ = w.Flush()
	out := buf.String()
	// It may emit the initial snapshot, but must not run to completion.
	if strings.Contains(out, "All steps complete.") {
		t.Errorf("a cancelled run should not reach completion:\n%s", out)
	}
}

func TestDocState_ApplyReproducesState(t *testing.T) {
	doc := NewDocState(map[string]any{"steps": []any{
		map[string]any{"description": "a", "status": "pending"},
		map[string]any{"description": "b", "status": "pending"},
	}})
	if err := doc.Apply(opsReplace("/steps/1/status", "completed")); err != nil {
		t.Fatalf("apply: %v", err)
	}
	snap := doc.Snapshot()
	steps, ok := snap["steps"].([]any)
	if !ok || len(steps) != 2 {
		t.Fatalf("bad steps: %#v", snap["steps"])
	}
	if got := steps[1].(map[string]any)["status"]; got != "completed" {
		t.Errorf("step 1 status = %v, want completed", got)
	}
	// Snapshot must be a copy — mutating it must not affect the doc.
	steps[0].(map[string]any)["status"] = "mutated"
	if doc.Snapshot()["steps"].([]any)[0].(map[string]any)["status"] != "pending" {
		t.Errorf("Snapshot must not alias the live document")
	}
}

func opsReplace(path string, value any) []events.JSONPatchOperation {
	return []events.JSONPatchOperation{{Op: "replace", Path: path, Value: value}}
}

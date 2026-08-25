package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
	jsonpatch "github.com/evanphx/json-patch"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
)

func runPredictive(t *testing.T, cm model.ToolCallingChatModel, in *aguitypes.RunAgentInput) string {
	t.Helper()
	return runPredictiveWithContext(t, context.Background(), cm, in)
}

func runPredictiveWithContext(t *testing.T, runCtx context.Context, cm model.ToolCallingChatModel, in *aguitypes.RunAgentInput) string {
	t.Helper()
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	// Keep the encoder context live so cancellation tests can observe whether Run
	// itself attempts a terminal event after the separate run context is canceled.
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), in.ThreadID, in.RunID, nil)
	tools, err := NewReadOnlyToolset(t.TempDir())
	if err != nil {
		t.Fatalf("NewReadOnlyToolset: %v", err)
	}
	deps := &Deps{
		Model: cm, BaseModel: cm, Tools: tools,
		Store: runstore.New(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MaxIterations: 8,
	}
	PredictiveState{Deps: deps}.Run(runCtx, emit, in, in.ThreadID, in.RunID)
	_ = w.Flush()
	return buf.String()
}

type predictiveFailureModel struct {
	startErr error
	chunks   []*schema.Message
	recvErr  error
}

func (m predictiveFailureModel) Generate(context.Context, []*schema.Message, ...model.Option) (*schema.Message, error) {
	return nil, errors.New("unused")
}

func (m predictiveFailureModel) WithTools([]*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	return m, nil
}

func (m predictiveFailureModel) Stream(context.Context, []*schema.Message, ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	if m.startErr != nil {
		return nil, m.startErr
	}
	sr, sw := schema.Pipe[*schema.Message](len(m.chunks) + 2)
	go func() {
		defer sw.Close()
		for _, chunk := range m.chunks {
			sw.Send(chunk, nil)
		}
		if m.recvErr != nil {
			sw.Send(nil, m.recvErr)
		}
	}()
	return sr, nil
}

func TestPredictiveState_PredictThenCommit(t *testing.T) {
	// The steps generation streams over several text chunks.
	m := &scriptedModel{turns: [][]*schema.Message{{
		textChunk("Boil the pasta.\n"),
		textChunk("Mince the garlic.\n"),
		textChunk("Combine and serve."),
	}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Rewrite the steps."}},
		State:    seededRecipeState(),
	}
	out := runPredictive(t, m, in)

	// Predictive deltas under /_predictive (multiple, as the draft grows).
	if c := strings.Count(out, `"path":"/_predictive"`); c < 2 {
		t.Errorf("expected multiple predictive /_predictive deltas, got %d:\n%s", c, out)
	}
	// A committed delta on the real path, and the draft cleared.
	if !strings.Contains(out, `"path":"/recipe/steps"`) {
		t.Errorf("expected a committed /recipe/steps delta:\n%s", out)
	}
	if !strings.Contains(out, `"op":"remove","path":"/_predictive"`) {
		t.Errorf("expected the predictive draft to be cleared:\n%s", out)
	}
	if !strings.Contains(out, `"type":"RUN_FINISHED"`) || strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("expected a clean finish:\n%s", out)
	}
}

func TestPredictiveState_ModelFailureEndsAfterClosingStep(t *testing.T) {
	tests := []struct {
		name                string
		model               model.ToolCallingChatModel
		wantPredictiveDelta bool
	}{
		{
			name:  "stream start",
			model: predictiveFailureModel{startErr: errors.New("provider rejected request")},
		},
		{
			name:  "provider canceled while run active",
			model: predictiveFailureModel{startErr: context.Canceled},
		},
		{
			name:  "provider deadline while run active",
			model: predictiveFailureModel{startErr: context.DeadlineExceeded},
		},
		{
			name: "mid stream",
			model: predictiveFailureModel{
				chunks:  []*schema.Message{textChunk("Boil the pasta.\n")},
				recvErr: errors.New("provider stream dropped"),
			},
			wantPredictiveDelta: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := &aguitypes.RunAgentInput{
				ThreadID: "t", RunID: "r",
				Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Rewrite the steps."}},
				State:    seededRecipeState(),
			}
			out := runPredictive(t, tt.model, in)
			evs := sseData(t, out)
			if len(evs) < 2 {
				t.Fatalf("expected terminal STEP_FINISHED and RUN_ERROR events:\n%s", out)
			}

			stepFinished, runError := evs[len(evs)-2], evs[len(evs)-1]
			if stepFinished["type"] != "STEP_FINISHED" || stepFinished["stepName"] != "llm" {
				t.Errorf("penultimate event = %#v, want STEP_FINISHED(llm)", stepFinished)
			}
			if runError["type"] != "RUN_ERROR" {
				t.Errorf("final event = %#v, want RUN_ERROR", runError)
			}

			runErrors := 0
			predictiveDeltas := 0
			for _, ev := range evs {
				switch ev["type"] {
				case "RUN_ERROR":
					runErrors++
				case "RUN_FINISHED", "MESSAGES_SNAPSHOT":
					t.Errorf("failure path must not continue into settlement; got %#v", ev)
				case "STATE_DELTA":
					raw, _ := json.Marshal(ev["delta"])
					if strings.Contains(string(raw), predictiveDraftPath) {
						predictiveDeltas++
					}
					if strings.Contains(string(raw), "/recipe/steps") {
						t.Errorf("failure path must not commit recipe steps; got %#v", ev)
					}
				}
			}
			if runErrors != 1 {
				t.Errorf("RUN_ERROR count = %d, want 1:\n%s", runErrors, out)
			}
			if tt.wantPredictiveDelta && predictiveDeltas == 0 {
				t.Errorf("mid-stream failure must occur after at least one predictive delta:\n%s", out)
			}
		})
	}
}

func TestPredictiveState_CancellationDoesNotEmitTerminalEvent(t *testing.T) {
	tests := []struct {
		name       string
		newContext func() (context.Context, context.CancelFunc)
	}{
		{
			name: "canceled run context",
			newContext: func() (context.Context, context.CancelFunc) {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx, cancel
			},
		},
		{
			name: "expired run deadline",
			newContext: func() (context.Context, context.CancelFunc) {
				return context.WithTimeout(context.Background(), 0)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := tt.newContext()
			defer cancel()
			in := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r", State: seededRecipeState()}
			out := runPredictiveWithContext(t, ctx, predictiveFailureModel{startErr: ctx.Err()}, in)
			for _, ev := range sseData(t, out) {
				if ev["type"] == "RUN_ERROR" || ev["type"] == "RUN_FINISHED" {
					t.Errorf("canceled run must not emit a terminal run event; got %#v", ev)
				}
			}
		})
	}
}

// TestPredictiveState_DropPredictionsInvariant proves that a client which ignores
// every /_predictive delta still reaches the correct committed state: applying only
// the committed (non-/_predictive) deltas to the initial snapshot yields the final
// steps.
func TestPredictiveState_DropPredictionsInvariant(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{{
		textChunk("Boil the pasta.\n"),
		textChunk("Mince the garlic.\n"),
		textChunk("Combine and serve."),
	}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Rewrite the steps."}},
		State:    seededRecipeState(),
	}
	out := runPredictive(t, m, in)

	snapshot := firstSnapshot(t, out)
	committed := committedDeltas(t, out) // excludes everything under /_predictive

	doc, _ := json.Marshal(snapshot)
	for _, ops := range committed {
		patchJSON, _ := json.Marshal(ops)
		patch, err := jsonpatch.DecodePatch(patchJSON)
		if err != nil {
			t.Fatalf("decode committed patch: %v", err)
		}
		doc, err = patch.Apply(doc)
		if err != nil {
			t.Fatalf("apply committed patch %s: %v", patchJSON, err)
		}
	}
	var final map[string]any
	if err := json.Unmarshal(doc, &final); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	recipe := final["recipe"].(map[string]any)
	steps, _ := recipe["steps"].([]any)
	if len(steps) != 3 || steps[0] != "Boil the pasta." || steps[2] != "Combine and serve." {
		t.Errorf("dropping predictions must still yield the committed steps; got %#v", recipe["steps"])
	}
	// And no leftover /_predictive in the committed-only view.
	if _, leftover := final["_predictive"]; leftover {
		t.Errorf("committed-only state must not contain /_predictive: %#v", final)
	}
}

// --- SSE parsing helpers (parse the data: lines into events) ---

func sseData(t *testing.T, out string) []map[string]any {
	t.Helper()
	var evs []map[string]any
	for _, line := range strings.Split(out, "\n") {
		rest, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(rest), &ev); err != nil {
			t.Fatalf("decode SSE data line %q: %v", line, err)
		}
		evs = append(evs, ev)
	}
	return evs
}

func firstSnapshot(t *testing.T, out string) map[string]any {
	t.Helper()
	for _, ev := range sseData(t, out) {
		if ev["type"] == "STATE_SNAPSHOT" {
			return ev["snapshot"].(map[string]any)
		}
	}
	t.Fatal("no STATE_SNAPSHOT found")
	return nil
}

// committedDeltas returns the JSON-patch op lists of every STATE_DELTA whose ops
// do NOT touch the /_predictive namespace (i.e. the committed deltas only).
func committedDeltas(t *testing.T, out string) [][]events.JSONPatchOperation {
	t.Helper()
	var committed [][]events.JSONPatchOperation
	for _, ev := range sseData(t, out) {
		if ev["type"] != "STATE_DELTA" {
			continue
		}
		raw, _ := json.Marshal(ev["delta"])
		var ops []events.JSONPatchOperation
		if json.Unmarshal(raw, &ops) != nil {
			continue
		}
		predictive := false
		for _, op := range ops {
			if strings.HasPrefix(op.Path, predictiveDraftPath) {
				predictive = true
				break
			}
		}
		if !predictive {
			committed = append(committed, ops)
		}
	}
	return committed
}

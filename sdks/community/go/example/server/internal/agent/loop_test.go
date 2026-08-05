package agent

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
)

// scriptedModel returns a queued sequence of turns, one per Stream call. The queue
// persists across Run calls (the same model instance is reused), which lets a single
// test drive a multi-turn loop and an interrupt->resume cycle.
type scriptedModel struct {
	mu    sync.Mutex
	turns [][]*schema.Message
}

func (m *scriptedModel) next() []*schema.Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.turns) == 0 {
		return nil
	}
	t := m.turns[0]
	m.turns = m.turns[1:]
	return t
}

func (m *scriptedModel) Generate(_ context.Context, _ []*schema.Message, _ ...model.Option) (*schema.Message, error) {
	return schema.ConcatMessages(m.next())
}

func (m *scriptedModel) Stream(_ context.Context, _ []*schema.Message, _ ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	chunks := m.next()
	sr, sw := schema.Pipe[*schema.Message](len(chunks) + 1)
	go func() {
		defer sw.Close()
		for _, c := range chunks {
			sw.Send(c, nil)
		}
	}()
	return sr, nil
}

func (m *scriptedModel) WithTools(_ []*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	return m, nil
}

func toolCallChunk(id, name, args string) *schema.Message {
	return &schema.Message{
		Role: schema.Assistant,
		ToolCalls: []schema.ToolCall{{
			ID:       id,
			Type:     "function",
			Function: schema.FunctionCall{Name: name, Arguments: args},
		}},
	}
}

func textChunk(s string) *schema.Message {
	return &schema.Message{Role: schema.Assistant, Content: s}
}

// runWithModel drives one Run against the scripted model and returns the raw SSE
// stream the client would receive.
func runWithModel(t *testing.T, cm model.ToolCallingChatModel, in *aguitypes.RunAgentInput, store *runstore.Store, autoApprove bool, maxIter int) string {
	t.Helper()
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), in.ThreadID, in.RunID, nil)
	tools, err := NewReadOnlyToolset(t.TempDir())
	if err != nil {
		t.Fatalf("NewReadOnlyToolset: %v", err)
	}
	deps := &Deps{
		Model:         cm,
		Tools:         tools,
		Store:         store,
		AutoApprove:   autoApprove,
		MaxIterations: maxIter,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	Run(context.Background(), emit, in, deps, DefaultRunConfig(), in.ThreadID, in.RunID)
	_ = w.Flush()
	return buf.String()
}

func TestRunRecoversFromEmptyNameToolCall(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("call1", "", `{}`)}, // malformed: empty function name
		{textChunk("all done")},            // final answer on the retry
	}}
	in := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}
	out := runWithModel(t, m, in, runstore.New(), true, 8)

	if strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("empty-name tool call must not error the run:\n%s", out)
	}
	if !strings.Contains(out, `"type":"RUN_FINISHED"`) {
		t.Errorf("expected RUN_FINISHED:\n%s", out)
	}
	if !strings.Contains(out, "empty function name") {
		t.Errorf("expected a corrective tool result for the empty name:\n%s", out)
	}
}

func TestRunReportsNonConvergence(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("c1", "file_read", `{"path":"a"}`)},
		{toolCallChunk("c2", "file_read", `{"path":"b"}`)},
		{toolCallChunk("c3", "file_read", `{"path":"c"}`)},
	}}
	in := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}
	out := runWithModel(t, m, in, runstore.New(), true, 2) // cap below the script length

	if !strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("expected RUN_ERROR on non-convergence:\n%s", out)
	}
	if !strings.Contains(out, "did not converge") {
		t.Errorf("expected a non-convergence message:\n%s", out)
	}
}

func TestRunErrorsOnEmptyModelStream(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{{}}} // a turn with no chunks
	in := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}
	out := runWithModel(t, m, in, runstore.New(), true, 8)

	if !strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("expected RUN_ERROR on an empty model stream:\n%s", out)
	}
}

func TestInterruptThenResumeApprove(t *testing.T) {
	store := runstore.New()
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("call1", "file_read", `{"path":"x"}`)}, // turn 1: propose a tool
		{textChunk("read complete")},                          // turn 2: final answer after resume
	}}

	in1 := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}
	out1 := runWithModel(t, m, in1, store, false, 8)
	if !strings.Contains(out1, `"type":"RUN_FINISHED"`) {
		t.Fatalf("expected an interrupt RUN_FINISHED on the first run:\n%s", out1)
	}
	if _, ok := store.Load(runstore.Key("t", "r")); !ok {
		t.Fatal("expected a saved paused run after the interrupt")
	}

	in2 := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Resume: []aguitypes.ResumeEntry{{
			InterruptID: "call1",
			Status:      aguitypes.ResumeStatusResolved,
			Payload:     map[string]any{"approved": true},
		}},
	}
	out2 := runWithModel(t, m, in2, store, false, 8)
	if strings.Contains(out2, `"type":"RUN_ERROR"`) {
		t.Errorf("resume-approve should not error:\n%s", out2)
	}
	if !strings.Contains(out2, `"type":"TOOL_CALL_START"`) {
		t.Errorf("resume should re-emit the tool proposal (TOOL_CALL_START):\n%s", out2)
	}
	if !strings.Contains(out2, `"type":"RUN_FINISHED"`) {
		t.Errorf("resume-approve should finish the run:\n%s", out2)
	}
}

func TestInterruptThenResumeDeny(t *testing.T) {
	store := runstore.New()
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("call1", "file_read", `{"path":"x"}`)},
		{textChunk("okay, skipping that")},
	}}

	in1 := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}
	runWithModel(t, m, in1, store, false, 8)

	in2 := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Resume: []aguitypes.ResumeEntry{{
			InterruptID: "call1",
			Status:      aguitypes.ResumeStatusResolved,
			Payload:     map[string]any{"approved": false},
		}},
	}
	out2 := runWithModel(t, m, in2, store, false, 8)
	if !strings.Contains(out2, "did not approve") {
		t.Errorf("expected the denial result threaded back:\n%s", out2)
	}
	if !strings.Contains(out2, `"type":"RUN_FINISHED"`) {
		t.Errorf("resume-deny should still finish the run:\n%s", out2)
	}
}

// TestStreamTurnConcurrentSharedModel guards the assumption in main.go that one
// tool-bound model can be shared across concurrent /agentic requests: concurrent
// streamTurn calls against a single model must be race-free. Meaningful under -race.
func TestStreamTurnConcurrentSharedModel(t *testing.T) {
	shared := &fakeModel{chunks: []*schema.Message{
		{Role: schema.Assistant, Content: "hello"},
	}}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var buf bytes.Buffer
			w := bufio.NewWriter(&buf)
			emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), "t", "r", nil)
			msg, err := streamTurn(context.Background(), emit, shared, nil, false)
			if err != nil {
				t.Errorf("streamTurn: %v", err)
				return
			}
			if msg.Content != "hello" {
				t.Errorf("content = %q, want hello", msg.Content)
			}
		}()
	}
	wg.Wait()
}

// TestFailedResumePreservesPausedRunForRetry is the regression guard for the
// resume-claim fix: a resume that fails validation must NOT destroy the paused
// run, so the client can re-submit a corrected resume. (Before the fix the path
// claimed the run with LoadAndDelete before validating, so any bad resume was
// unrecoverable.)
func TestFailedResumePreservesPausedRunForRetry(t *testing.T) {
	store := runstore.New()
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("call1", "file_read", `{"path":"x"}`)}, // propose -> interrupt
		{textChunk("read complete")},                          // final answer after a corrected resume
	}}

	in1 := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}
	runWithModel(t, m, in1, store, false, 8)
	key := runstore.Key("t", "r")
	if _, ok := store.Load(key); !ok {
		t.Fatal("expected a saved paused run after the interrupt")
	}

	// A resume that addresses no pending call fails validation.
	badResume := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Resume: []aguitypes.ResumeEntry{{
			InterruptID: "does-not-exist",
			Status:      aguitypes.ResumeStatusResolved,
			Payload:     map[string]any{"approved": true},
		}},
	}
	out := runWithModel(t, m, badResume, store, false, 8)
	if !strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Fatalf("expected RUN_ERROR for an unmatched resume:\n%s", out)
	}
	if _, ok := store.Load(key); !ok {
		t.Fatal("a failed-validation resume must leave the paused run intact for a retry")
	}

	// A corrected resume then succeeds and drives the run to completion.
	goodResume := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Resume: []aguitypes.ResumeEntry{{
			InterruptID: "call1",
			Status:      aguitypes.ResumeStatusResolved,
			Payload:     map[string]any{"approved": true},
		}},
	}
	out2 := runWithModel(t, m, goodResume, store, false, 8)
	if strings.Contains(out2, `"type":"RUN_ERROR"`) {
		t.Errorf("the corrected resume should not error:\n%s", out2)
	}
	if !strings.Contains(out2, `"type":"RUN_FINISHED"`) {
		t.Errorf("the corrected resume should finish the run:\n%s", out2)
	}
	if _, ok := store.Load(key); ok {
		t.Error("the paused run should be claimed (deleted) after a successful resume")
	}
}

func TestResumeWithUnmatchedEntryErrors(t *testing.T) {
	store := runstore.New()
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("call1", "file_read", `{"path":"x"}`)},
	}}

	in1 := &aguitypes.RunAgentInput{ThreadID: "t", RunID: "r"}
	runWithModel(t, m, in1, store, false, 8)

	in2 := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Resume: []aguitypes.ResumeEntry{{
			InterruptID: "does-not-exist",
			Status:      aguitypes.ResumeStatusResolved,
			Payload:     map[string]any{"approved": true},
		}},
	}
	out2 := runWithModel(t, m, in2, store, false, 8)
	if !strings.Contains(out2, `"type":"RUN_ERROR"`) {
		t.Errorf("expected RUN_ERROR for an unmatched resume entry:\n%s", out2)
	}
	if !strings.Contains(out2, "do not match any pending") {
		t.Errorf("expected the clearer unmatched-entry message:\n%s", out2)
	}
}

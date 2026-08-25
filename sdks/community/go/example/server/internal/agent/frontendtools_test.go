package agent

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/cloudwego/eino/schema"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
)

// runChat drives one agentic_chat run (ClientTools + streaming tap) against the
// scripted model and returns the raw SSE. BaseModel is set so per-request
// WithTools binding works (scriptedModel.WithTools returns itself).
func runChat(t *testing.T, cm *scriptedModel, in *aguitypes.RunAgentInput) string {
	t.Helper()
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), in.ThreadID, in.RunID, nil)
	tools, err := NewReadOnlyToolset(t.TempDir())
	if err != nil {
		t.Fatalf("NewReadOnlyToolset: %v", err)
	}
	deps := &Deps{
		Model:     cm,
		BaseModel: cm,
		Tools:     tools,
		Store:     runstore.New(),
		Logger:    slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	Run(context.Background(), emit, in, deps, AgenticChatConfig(), in.ThreadID, in.RunID)
	_ = w.Flush()
	return buf.String()
}

// streaming tool-call chunks with a stable Index, mirroring the shipped provider.
func tcOpen(idx int, id, name string) *schema.Message {
	i := idx
	return &schema.Message{Role: schema.Assistant, ToolCalls: []schema.ToolCall{{
		Index: &i, ID: id, Type: "function", Function: schema.FunctionCall{Name: name},
	}}}
}

func tcArg(idx int, id, name, frag string) *schema.Message {
	i := idx
	return &schema.Message{Role: schema.Assistant, ToolCalls: []schema.ToolCall{{
		Index: &i, ID: id, Type: "function", Function: schema.FunctionCall{Name: name, Arguments: frag},
	}}}
}

func confirmBookingTool() aguitypes.Tool {
	return aguitypes.Tool{
		Name:        "confirm_booking",
		Description: "Confirm a flight booking with the user before finalizing.",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{"flight": map[string]any{"type": "string"}},
			"required":   []any{"flight"},
		},
	}
}

func count(s, sub string) int { return strings.Count(s, sub) }

func TestAgenticChat_ClientToolHandBack(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{{
		tcOpen(0, "call_1", "confirm_booking"),
		tcArg(0, "call_1", "confirm_booking", `{"flight":`),
		tcArg(0, "call_1", "confirm_booking", `"AA9"}`),
		tcArg(0, "call_1", "confirm_booking", ""), // CLOSE: empty-args backfill
	}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t1", RunID: "r1",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Book the 9am flight."}},
		Tools:    []aguitypes.Tool{confirmBookingTool()},
	}
	out := runChat(t, m, in)

	// Streamed tool call: exactly one START, args fragments, exactly one END.
	if c := count(out, `"type":"TOOL_CALL_START"`); c != 1 {
		t.Errorf("TOOL_CALL_START count = %d, want 1 (no double-emit):\n%s", c, out)
	}
	if c := count(out, `"type":"TOOL_CALL_END"`); c != 1 {
		t.Errorf("TOOL_CALL_END count = %d, want 1:\n%s", c, out)
	}
	if !strings.Contains(out, `"toolCallName":"confirm_booking"`) {
		t.Errorf("expected confirm_booking START:\n%s", out)
	}
	if c := count(out, `"type":"TOOL_CALL_ARGS"`); c < 2 {
		t.Errorf("expected >=2 TOOL_CALL_ARGS deltas, got %d:\n%s", c, out)
	}
	// Plain finish, no interrupt.
	if !strings.Contains(out, `"type":"RUN_FINISHED"`) {
		t.Errorf("expected RUN_FINISHED:\n%s", out)
	}
	if strings.Contains(out, "INTERRUPT") || strings.Contains(out, `"interrupts"`) {
		t.Errorf("hand-back must be a plain RUN_FINISHED, not an interrupt:\n%s", out)
	}
	if strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("unexpected RUN_ERROR:\n%s", out)
	}
	// The assistant tool-call message is in the snapshot.
	if !strings.Contains(out, `"type":"MESSAGES_SNAPSHOT"`) {
		t.Errorf("expected MESSAGES_SNAPSHOT:\n%s", out)
	}
}

func TestAgenticChat_RunBContinues(t *testing.T) {
	// Run B: history carries the assistant tool-call + the role:tool result; the
	// model now returns a final text answer.
	m := &scriptedModel{turns: [][]*schema.Message{{textChunk("Done — your 9am flight is booked.")}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t1", RunID: "r2",
		Messages: []aguitypes.Message{
			{ID: "u1", Role: aguitypes.RoleUser, Content: "Book the 9am flight."},
			{ID: "a1", Role: aguitypes.RoleAssistant, ToolCalls: []aguitypes.ToolCall{{
				ID: "call_1", Type: aguitypes.ToolCallTypeFunction,
				Function: aguitypes.FunctionCall{Name: "confirm_booking", Arguments: `{"flight":"AA9"}`},
			}}},
			{ID: "t1m", Role: aguitypes.RoleTool, ToolCallID: "call_1", Content: `{"confirmed":true}`},
		},
		Tools: []aguitypes.Tool{confirmBookingTool()},
	}
	out := runChat(t, m, in)
	if !strings.Contains(out, "your 9am flight is booked") {
		t.Errorf("expected the continued text answer:\n%s", out)
	}
	if !strings.Contains(out, `"type":"RUN_FINISHED"`) || strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("expected clean RUN_FINISHED:\n%s", out)
	}
}

func TestAgenticChat_NoToolsPlainChat(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{{textChunk("Hello there.")}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "hi"}},
		Tools:    []aguitypes.Tool{}, // no tools
	}
	out := runChat(t, m, in)
	if !strings.Contains(out, "Hello there.") || !strings.Contains(out, `"type":"RUN_FINISHED"`) {
		t.Errorf("tools:[] should behave like a plain chat turn:\n%s", out)
	}
	if strings.Contains(out, `"type":"TOOL_CALL_START"`) {
		t.Errorf("no tool call expected:\n%s", out)
	}
}

func TestAgenticChat_EmptyIDOpenBuffersUntilClose(t *testing.T) {
	// OPEN carries an empty call_id; the authoritative id arrives at CLOSE. The tap
	// must NOT emit a START/ARGS with an empty toolCallId (the SDK would drop it).
	m := &scriptedModel{turns: [][]*schema.Message{{
		tcOpen(0, "", "confirm_booking"),                    // empty id
		tcArg(0, "", "confirm_booking", `{"flight":"AA9"}`), // delta, still no id
		tcArg(0, "call_late", "confirm_booking", ""),        // CLOSE backfills id
	}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Book it."}},
		Tools:    []aguitypes.Tool{confirmBookingTool()},
	}
	out := runChat(t, m, in)
	if c := count(out, `"type":"TOOL_CALL_START"`); c != 1 {
		t.Errorf("TOOL_CALL_START count = %d, want exactly 1:\n%s", c, out)
	}
	if !strings.Contains(out, `"toolCallId":"call_late"`) {
		t.Errorf("START must use the CLOSE-backfilled id:\n%s", out)
	}
	if !strings.Contains(out, `AA9`) {
		t.Errorf("buffered arg fragment must be flushed:\n%s", out)
	}
	if strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("unexpected RUN_ERROR:\n%s", out)
	}
}

func TestAgenticChat_MalformedToolsError(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{{textChunk("unused")}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "hi"}},
		Tools:    []aguitypes.Tool{{Name: "", Description: "no name"}}, // empty name
	}
	out := runChat(t, m, in)
	if !strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("malformed tools must yield RUN_ERROR:\n%s", out)
	}
}

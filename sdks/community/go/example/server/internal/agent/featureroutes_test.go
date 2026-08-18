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

// runCfg drives one run against the scripted model with an explicit RunConfig.
func runCfg(t *testing.T, cm *scriptedModel, in *aguitypes.RunAgentInput, cfg RunConfig) string {
	t.Helper()
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), in.ThreadID, in.RunID, nil)
	tools, err := NewReadOnlyToolset(t.TempDir())
	if err != nil {
		t.Fatalf("NewReadOnlyToolset: %v", err)
	}
	deps := &Deps{
		Model: cm, BaseModel: cm, Tools: tools,
		Store: runstore.New(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	Run(context.Background(), emit, in, deps, cfg, in.ThreadID, in.RunID)
	_ = w.Flush()
	return buf.String()
}

// --- 02: tool-based generative UI ---

func TestToolBasedGenUI_MultiDeltaStream(t *testing.T) {
	// render_haiku streamed as several arg fragments (the progressive-rendering case).
	m := &scriptedModel{turns: [][]*schema.Message{{
		tcOpen(0, "call_h", "render_haiku"),
		tcArg(0, "call_h", "render_haiku", `{"title":"Tides",`),
		tcArg(0, "call_h", "render_haiku", `"lines":["a","b","c"],`),
		tcArg(0, "call_h", "render_haiku", `"mood":"calm"}`),
		tcArg(0, "call_h", "render_haiku", ""), // CLOSE
	}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Write a haiku about the ocean."}},
		Tools: []aguitypes.Tool{{
			Name: "render_haiku", Description: "Render a haiku as a UI card.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"title": map[string]any{"type": "string"},
					"lines": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
					"mood":  map[string]any{"type": "string", "enum": []any{"calm", "joyful", "somber"}},
				},
				"required": []any{"lines"},
			},
		}},
	}
	out := runCfg(t, m, in, ToolBasedGenerativeUIConfig())

	if c := count(out, `"type":"TOOL_CALL_START"`); c != 1 {
		t.Errorf("TOOL_CALL_START = %d, want 1:\n%s", c, out)
	}
	if c := count(out, `"type":"TOOL_CALL_ARGS"`); c < 3 {
		t.Errorf("expected >=3 progressive TOOL_CALL_ARGS deltas, got %d:\n%s", c, out)
	}
	if c := count(out, `"type":"TOOL_CALL_END"`); c != 1 {
		t.Errorf("TOOL_CALL_END = %d, want 1:\n%s", c, out)
	}
	if !strings.Contains(out, `"toolCallName":"render_haiku"`) || !strings.Contains(out, `"type":"RUN_FINISHED"`) {
		t.Errorf("expected a clean render_haiku hand-back:\n%s", out)
	}
}

// --- 03: human-in-the-loop ---

func TestHumanInTheLoop_ConfigToggle(t *testing.T) {
	on := HumanInTheLoopConfig("")     // default → gated
	off := HumanInTheLoopConfig("off") // ungated
	if !strings.Contains(on.SystemPrompt, "approval") {
		t.Errorf("default HITL config should carry the approval-gate prompt")
	}
	if strings.Contains(off.SystemPrompt, "approval tool") {
		t.Errorf("approval=off should fall back to the plain agentic-chat prompt")
	}
	// Header value case-insensitivity.
	if HumanInTheLoopConfig("OFF").SystemPrompt != off.SystemPrompt {
		t.Errorf("approval toggle must be case-insensitive")
	}
}

func TestHumanInTheLoop_ProposeThenReject(t *testing.T) {
	// Run A: agent proposes confirm_action (streamed, handed back).
	mA := &scriptedModel{turns: [][]*schema.Message{{
		tcOpen(0, "call_1", "confirm_action"),
		tcArg(0, "call_1", "confirm_action", `{"summary":"Delete 3 completed todos"}`),
		tcArg(0, "call_1", "confirm_action", ""),
	}}}
	approvalTool := aguitypes.Tool{
		Name: "confirm_action", Description: "Ask the user to approve an action before performing it.",
		Parameters: map[string]any{"type": "object",
			"properties": map[string]any{"summary": map[string]any{"type": "string"}},
			"required":   []any{"summary"}},
	}
	inA := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "rA",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Delete all completed todos."}},
		Tools:    []aguitypes.Tool{approvalTool},
	}
	outA := runCfg(t, mA, inA, HumanInTheLoopConfig(""))
	if !strings.Contains(outA, `"toolCallName":"confirm_action"`) || !strings.Contains(outA, `"type":"RUN_FINISHED"`) {
		t.Errorf("Run A should propose confirm_action and finish plainly:\n%s", outA)
	}
	if strings.Contains(outA, `"interrupts"`) {
		t.Errorf("Run A must NOT use the interrupt path:\n%s", outA)
	}

	// Run B: client returns {"approved":false}; the agent acknowledges, no action.
	mB := &scriptedModel{turns: [][]*schema.Message{{textChunk("Okay, I won't delete them.")}}}
	inB := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "rB",
		Messages: []aguitypes.Message{
			{ID: "u1", Role: aguitypes.RoleUser, Content: "Delete all completed todos."},
			{ID: "a1", Role: aguitypes.RoleAssistant, ToolCalls: []aguitypes.ToolCall{{
				ID: "call_1", Type: aguitypes.ToolCallTypeFunction,
				Function: aguitypes.FunctionCall{Name: "confirm_action", Arguments: `{"summary":"Delete 3 completed todos"}`},
			}}},
			{ID: "t1m", Role: aguitypes.RoleTool, ToolCallID: "call_1", Content: `{"approved":false}`},
		},
		Tools: []aguitypes.Tool{approvalTool},
	}
	outB := runCfg(t, mB, inB, HumanInTheLoopConfig(""))
	if !strings.Contains(outB, "won't delete") || !strings.Contains(outB, `"type":"RUN_FINISHED"`) {
		t.Errorf("Run B reject should acknowledge without acting:\n%s", outB)
	}
}

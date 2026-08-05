package agent

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
)

// --- I2 / IMPORTANT 1: splitSteps must not corrupt legitimate step text ---

func TestSplitSteps_PreservesLeadingDigitsAndHyphens(t *testing.T) {
	got := splitSteps("2 cups flour, sifted\n- Whisk the eggs\n1. Boil water\n3-4 minutes until golden\n350F bake")
	want := []string{"2 cups flour, sifted", "Whisk the eggs", "Boil water", "3-4 minutes until golden", "350F bake"}
	if len(got) != len(want) {
		t.Fatalf("got %d steps %#v, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i].(string) != want[i] {
			t.Errorf("step %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// --- IMPORTANT 2: servings as a JSON float must not void the edit batch ---

func TestSharedState_ServingsAsFloatApplies(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("c1", "apply_recipe_changes", `{"servings":4.0,"add_ingredients":[{"name":"garlic"}]}`)},
		{textChunk("Scaled to 4 and added garlic.")},
	}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "serve 4, add garlic"}},
		State:    seededRecipeState(),
	}
	out := runSharedState(t, m, in)
	if !strings.Contains(out, `"path":"/recipe/servings"`) || !strings.Contains(out, `"value":4`) {
		t.Errorf("servings:4.0 must still apply as a servings delta:\n%s", out)
	}
	if !strings.Contains(out, `"garlic"`) {
		t.Errorf("the whole batch must not be voided by the float servings:\n%s", out)
	}
}

// --- IMPORTANT 3: /shared_state must not leak TOOL_CALL_RESULT on malformed args ---

func TestSharedState_MalformedArgsNoToolEvents(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("c1", "apply_recipe_changes", `{"servings":`)}, // invalid JSON
		{textChunk("Sorry, I mangled that — nothing changed.")},
	}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "serve 4"}},
		State:    seededRecipeState(),
	}
	out := runSharedState(t, m, in)
	for _, banned := range []string{`"type":"TOOL_CALL_START"`, `"type":"TOOL_CALL_ARGS"`, `"type":"TOOL_CALL_END"`, `"type":"TOOL_CALL_RESULT"`} {
		if strings.Contains(out, banned) {
			t.Errorf("malformed args must not leak %s on /shared_state:\n%s", banned, out)
		}
	}
	if !strings.Contains(out, `"type":"RUN_FINISHED"`) {
		t.Errorf("run should still finish cleanly:\n%s", out)
	}
}

// --- I1: a streamed tool call must be terminated (END) even on a mid-stream error ---

// errorMidStreamModel streams a tool OPEN + an arg fragment, then fails — simulating
// a provider error after TOOL_CALL_START has already gone out.
type errorMidStreamModel struct{}

func (errorMidStreamModel) Generate(context.Context, []*schema.Message, ...model.Option) (*schema.Message, error) {
	return nil, fmt.Errorf("unused")
}
func (m errorMidStreamModel) WithTools([]*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	return m, nil
}
func (errorMidStreamModel) Stream(context.Context, []*schema.Message, ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	sr, sw := schema.Pipe[*schema.Message](4)
	go func() {
		defer sw.Close()
		sw.Send(tcOpen(0, "call_1", "confirm_booking"), nil)
		sw.Send(tcArg(0, "call_1", "confirm_booking", `{"flight":`), nil)
		sw.Send(nil, fmt.Errorf("provider exploded mid-call"))
	}()
	return sr, nil
}

func TestStreamingTap_TerminatesToolCallOnMidStreamError(t *testing.T) {
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "book it"}},
		Tools:    []aguitypes.Tool{confirmBookingTool()},
	}
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), in.ThreadID, in.RunID, nil)
	tools, _ := NewReadOnlyToolset(t.TempDir())
	var cm errorMidStreamModel
	deps := &Deps{
		Model: cm, BaseModel: cm, Tools: tools,
		Store: runstore.New(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	Run(context.Background(), emit, in, deps, AgenticChatConfig(), in.ThreadID, in.RunID)
	_ = w.Flush()
	out := buf.String()

	if !strings.Contains(out, `"type":"TOOL_CALL_START"`) {
		t.Fatalf("expected a TOOL_CALL_START before the error:\n%s", out)
	}
	if c := strings.Count(out, `"type":"TOOL_CALL_END"`); c != 1 {
		t.Errorf("a started tool call must be terminated exactly once on mid-stream error, got %d ENDs:\n%s", c, out)
	}
	if !strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("a genuine provider error should surface as RUN_ERROR:\n%s", out)
	}
}

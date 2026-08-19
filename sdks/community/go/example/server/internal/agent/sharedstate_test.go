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

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/config"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
)

func runSharedState(t *testing.T, cm *scriptedModel, in *aguitypes.RunAgentInput) string {
	return runSharedStateWithMaxIterations(t, cm, in, 8)
}

func runSharedStateWithMaxIterations(t *testing.T, cm *scriptedModel, in *aguitypes.RunAgentInput, maxIterations int) string {
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
		Store: runstore.New(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MaxIterations: maxIterations,
	}
	SharedState{Deps: deps}.Run(context.Background(), emit, in, in.ThreadID, in.RunID)
	_ = w.Flush()
	return buf.String()
}

func seededRecipeState() map[string]any {
	return map[string]any{"recipe": map[string]any{
		"title":       "Tomato Pasta",
		"servings":    float64(2),
		"ingredients": []any{map[string]any{"name": "pasta", "amount": "200g"}},
		"steps":       []any{"Boil pasta."},
	}}
}

func TestSharedState_GranularDeltasNoToolEvents(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("c1", "apply_recipe_changes",
			`{"add_ingredients":[{"name":"garlic","amount":"3 cloves"}],"servings":4}`)},
		{textChunk("Added garlic and scaled it to 4 servings.")},
	}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Add garlic and make it serve 4."}},
		State:    seededRecipeState(),
	}
	out := runSharedState(t, m, in)

	// Initial snapshot of the seeded document.
	if !strings.Contains(out, `"type":"STATE_SNAPSHOT"`) || !strings.Contains(out, `"Tomato Pasta"`) {
		t.Errorf("expected an initial STATE_SNAPSHOT of the recipe:\n%s", out)
	}
	// Granular deltas against /recipe/...
	if !strings.Contains(out, `"path":"/recipe/ingredients/-"`) || !strings.Contains(out, `"garlic"`) {
		t.Errorf("expected an add-ingredient delta:\n%s", out)
	}
	if !strings.Contains(out, `"path":"/recipe/servings"`) || !strings.Contains(out, `"value":4`) {
		t.Errorf("expected a servings replace delta:\n%s", out)
	}
	// No tool-call events on the wire (request 04 contract).
	for _, banned := range []string{`"type":"TOOL_CALL_START"`, `"type":"TOOL_CALL_ARGS"`, `"type":"TOOL_CALL_END"`, `"type":"TOOL_CALL_RESULT"`} {
		if strings.Contains(out, banned) {
			t.Errorf("shared_state must not emit %s:\n%s", banned, out)
		}
	}
	// Concludes with text + clean finish.
	if !strings.Contains(out, "Added garlic") || !strings.Contains(out, `"type":"RUN_FINISHED"`) {
		t.Errorf("expected a summary and RUN_FINISHED:\n%s", out)
	}
	if strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Errorf("unexpected RUN_ERROR:\n%s", out)
	}
}

func TestSharedState_AdoptsUserEditedState(t *testing.T) {
	// The user already edited the recipe (servings 6, basil added); the agent must
	// build on that version, not clobber it.
	userEdited := map[string]any{"recipe": map[string]any{
		"title":       "Tomato Pasta",
		"servings":    float64(6),
		"ingredients": []any{map[string]any{"name": "pasta", "amount": "200g"}, map[string]any{"name": "basil"}},
		"steps":       []any{"Boil pasta."},
	}}
	m := &scriptedModel{turns: [][]*schema.Message{{textChunk("It already serves 6 with basil.")}}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r2",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "What's in it now?"}},
		State:    userEdited,
	}
	out := runSharedState(t, m, in)
	if !strings.Contains(out, `"basil"`) || !strings.Contains(out, `"servings":6`) {
		t.Errorf("the snapshot must reflect the user-edited document:\n%s", out)
	}
}

func TestSharedState_RemoveIngredient(t *testing.T) {
	m := &scriptedModel{turns: [][]*schema.Message{
		{toolCallChunk("c1", "apply_recipe_changes", `{"remove_ingredient_indices":[0]}`)},
		{textChunk("Removed the pasta.")},
	}}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Remove the pasta."}},
		State:    seededRecipeState(),
	}
	out := runSharedState(t, m, in)
	if !strings.Contains(out, `"op":"remove"`) || !strings.Contains(out, `"path":"/recipe/ingredients/0"`) {
		t.Errorf("expected a remove delta:\n%s", out)
	}
}

func TestSharedState_MaxIterationsClampedToCeiling(t *testing.T) {
	turns := make([][]*schema.Message, 70)
	for i := range turns {
		turns[i] = []*schema.Message{toolCallChunk("c", "apply_recipe_changes", `{"servings":4}`)}
	}
	m := &scriptedModel{turns: turns}
	in := &aguitypes.RunAgentInput{
		ThreadID: "t", RunID: "r",
		Messages: []aguitypes.Message{{ID: "u1", Role: aguitypes.RoleUser, Content: "Keep editing."}},
		State:    seededRecipeState(),
	}
	out := runSharedStateWithMaxIterations(t, m, in, config.MaxIterationsCeiling+100)
	if !strings.Contains(out, `"type":"RUN_ERROR"`) {
		t.Fatalf("expected non-convergence RUN_ERROR:\n%s", out)
	}
	if !strings.Contains(out, "agent did not converge within 64 iterations") {
		t.Fatalf("expected max-iteration ceiling in error:\n%s", out)
	}
}

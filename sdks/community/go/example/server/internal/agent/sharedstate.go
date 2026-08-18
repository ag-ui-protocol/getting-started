package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/cloudwego/eino/schema"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/config"
)

// SharedState runs the /shared_state flow (request 04): a collaborative recipe
// document both the user and the agent edit. The client seeds the document in
// RunAgentInput.state.recipe; the agent mutates it in response to chat, surfacing
// each change as a granular RFC-6902 STATE_DELTA against /recipe/...; and a later
// run adopts the user-edited document verbatim (last-writer-wins).
//
// The agent edits via an internal tool whose TOOL_CALL_* events are deliberately
// SUPPRESSED and translated into STATE_DELTAs — the wire carries STATE_SNAPSHOT +
// STATE_DELTAs only, no tool-call events (matching request 04's contract). The
// edits are in-memory document state, not filesystem writes, so the read-only
// constraint is untouched.
type SharedState struct {
	Deps *Deps
}

const sharedStateSystemPrompt = "You are a collaborative recipe assistant. You and the user " +
	"edit a shared recipe together. To change the recipe, call the apply_recipe_changes tool " +
	"with only the fields you want to change; do not restate the whole recipe. After applying " +
	"changes, briefly tell the user what you changed. If the user only asks a question, answer " +
	"it without calling the tool."

func (s SharedState) Run(ctx context.Context, emit *Emitter, in *aguitypes.RunAgentInput, threadID, runID string) {
	emit.RunStarted()

	doc := seedRecipe(in.State)
	emit.StateSnapshot(doc.Snapshot())

	cm, err := s.Deps.BaseModel.WithTools([]*schema.ToolInfo{recipeEditTool()})
	if err != nil {
		emit.RunError("failed to bind the recipe-edit tool")
		return
	}

	// Inject the current recipe into the model's context. The recipe is shared STATE,
	// not part of the message history, so without this the model cannot see the title,
	// servings, ingredients, or steps it is supposed to collaborate on (it would answer
	// questions blind and could not compute edits like "double the servings").
	messages := ensureSystemPrompt(toEinoMessages(in.Messages, s.Deps.Provider), sharedStateSystemPrompt+currentRecipeContext(doc))

	maxIter := s.Deps.MaxIterations
	if maxIter <= 0 {
		maxIter = config.DefaultMaxIterations
	}
	if maxIter > config.MaxIterationsCeiling {
		s.Deps.Logger.Warn("clamping MaxIterations to ceiling",
			"requested", maxIter, "ceiling", config.MaxIterationsCeiling)
		maxIter = config.MaxIterationsCeiling
	}
	for iter := 0; iter < maxIter; iter++ {
		if emit.Err() != nil || ctx.Err() != nil {
			return
		}
		emit.StepStarted("llm")
		assistant, err := streamTurn(ctx, emit, cm, messages, false) // tap off: edit-tool calls are suppressed
		emit.StepFinished("llm")
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || emit.Err() != nil {
				return
			}
			s.Deps.Logger.Error("shared_state turn failed", "thread", threadID, "run", runID, "error", err)
			emit.RunError("the agent failed to generate a response")
			return
		}
		messages = append(messages, assistant)

		// Quiet validation: this route's contract is STATE_* only, no tool-call
		// events — so a malformed call must not leak a TOOL_CALL_RESULT.
		actionable := validateToolCallsQuiet(s.Deps.Logger, assistant, &messages)
		if len(assistant.ToolCalls) == 0 {
			// Final text answer.
			emit.MessagesSnapshot(toAGUIMessages(messages))
			emit.RunFinishedSuccess()
			return
		}
		if len(actionable) == 0 {
			continue
		}
		// Translate each edit-tool call into granular STATE_DELTAs (no TOOL_CALL_*),
		// thread a tool result back so the model can continue.
		for _, tc := range actionable {
			result := applyRecipeChanges(emit, doc, tc)
			messages = append(messages, schema.ToolMessage(result, tc.ID))
		}
	}

	emit.MessagesSnapshot(toAGUIMessages(messages))
	emit.RunError(fmt.Sprintf("agent did not converge within %d iterations", maxIter))
}

// currentRecipeContext renders the current recipe as a system-prompt suffix so the
// model can see the shared state. Returns "" if the document can't be marshaled.
func currentRecipeContext(doc *DocState) string {
	b, err := json.Marshal(doc.Snapshot())
	if err != nil {
		return ""
	}
	return "\n\nThe current shared recipe is:\n" + string(b) +
		"\nUse these exact values when answering questions or computing edits " +
		"(e.g. when doubling servings or removing an ingredient by position)."
}

// seedRecipe builds the working document from client-seeded state. It adopts
// state.recipe verbatim (so a user-edited document round-trips), or starts from a
// small default recipe when none is provided. The document is exactly {recipe:...}.
func seedRecipe(state any) *DocState {
	if m, ok := state.(map[string]any); ok {
		if r, has := m["recipe"]; has {
			return NewDocState(map[string]any{"recipe": r})
		}
	}
	return NewDocState(map[string]any{"recipe": map[string]any{
		"title":       "Tomato Pasta",
		"servings":    float64(2),
		"ingredients": []any{map[string]any{"name": "pasta", "amount": "200g"}},
		"steps":       []any{"Boil pasta."},
	}})
}

// recipeEditTool is the internal edit tool. Its call is intercepted (never executed
// as a normal tool, never surfaced as TOOL_CALL_*) and translated to STATE_DELTAs.
func recipeEditTool() *schema.ToolInfo {
	js, _ := toJSONSchema(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"title":    map[string]any{"type": "string", "description": "New recipe title"},
			"servings": map[string]any{"type": "integer", "description": "New servings count"},
			"add_ingredients": map[string]any{"type": "array", "items": map[string]any{
				"type":       "object",
				"properties": map[string]any{"name": map[string]any{"type": "string"}, "amount": map[string]any{"type": "string"}},
				"required":   []any{"name"},
			}},
			"remove_ingredient_indices": map[string]any{"type": "array", "items": map[string]any{"type": "integer"},
				"description": "Zero-based indices of ingredients to remove"},
			"add_steps": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
		},
	})
	info := &schema.ToolInfo{
		Name: "apply_recipe_changes",
		Desc: "Apply edits to the shared recipe. Provide only the fields you want to change.",
	}
	if js != nil {
		info.ParamsOneOf = schema.NewParamsOneOfByJSONSchema(js)
	}
	return info
}

type recipeChanges struct {
	Title          *string      `json:"title"`
	Servings       *json.Number `json:"servings"` // json.Number so 4 and 4.0 both parse (LLMs emit trailing .0)
	AddIngredients []struct {
		Name   string `json:"name"`
		Amount string `json:"amount"`
	} `json:"add_ingredients"`
	RemoveIngredientIndices []int    `json:"remove_ingredient_indices"`
	AddSteps                []string `json:"add_steps"`
}

// applyRecipeChanges parses the edit-tool arguments and emits one granular
// STATE_DELTA per logical change, keeping DocState consistent. Each op is applied
// independently; an op that fails to apply is skipped and reported (never a panic).
// Returns a short JSON result threaded back to the model.
func applyRecipeChanges(emit *Emitter, doc *DocState, tc schema.ToolCall) string {
	var ch recipeChanges
	if err := json.Unmarshal([]byte(tc.Function.Arguments), &ch); err != nil {
		return `{"error":"could not parse recipe changes"}`
	}

	applied, skipped := 0, 0
	apply := func(op events.JSONPatchOperation) {
		if err := doc.Apply([]events.JSONPatchOperation{op}); err != nil {
			skipped++ // an op that doesn't apply (e.g. out-of-range remove) is reported, not fatal
			return
		}
		emit.StateDelta([]events.JSONPatchOperation{op})
		applied++
	}

	if ch.Title != nil {
		apply(events.JSONPatchOperation{Op: "replace", Path: "/recipe/title", Value: *ch.Title})
	}
	if ch.Servings != nil {
		// Accept any JSON number; the document carries servings as a number, and a
		// model may emit 4 or 4.0. A non-numeric value is skipped, not fatal.
		if n, err := ch.Servings.Float64(); err == nil {
			apply(events.JSONPatchOperation{Op: "replace", Path: "/recipe/servings", Value: int(n)})
		} else {
			skipped++
		}
	}
	for _, ing := range ch.AddIngredients {
		v := map[string]any{"name": ing.Name}
		if ing.Amount != "" {
			v["amount"] = ing.Amount
		}
		apply(events.JSONPatchOperation{Op: "add", Path: "/recipe/ingredients/-", Value: v})
	}
	// Remove highest indices first so earlier removals don't shift later ones.
	idxs := append([]int(nil), ch.RemoveIngredientIndices...)
	sort.Sort(sort.Reverse(sort.IntSlice(idxs)))
	for _, i := range idxs {
		apply(events.JSONPatchOperation{Op: "remove", Path: fmt.Sprintf("/recipe/ingredients/%d", i)})
	}
	for _, st := range ch.AddSteps {
		apply(events.JSONPatchOperation{Op: "add", Path: "/recipe/steps/-", Value: st})
	}

	// Report skipped ops so the model can tell the user a change was rejected
	// (e.g. "ingredient index 9 didn't exist") rather than silently swallowing it.
	// Include the updated recipe so a follow-up edit in the same run sees current state.
	if b, err := json.Marshal(doc.Snapshot()); err == nil {
		return fmt.Sprintf(`{"applied":%d,"skipped":%d,"recipe":%s}`, applied, skipped, string(b))
	}
	return fmt.Sprintf(`{"applied":%d,"skipped":%d}`, applied, skipped)
}

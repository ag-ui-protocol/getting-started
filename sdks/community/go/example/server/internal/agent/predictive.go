package agent

import (
	"context"
	"errors"
	"io"
	"regexp"
	"strings"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/cloudwego/eino/schema"
)

// PredictiveState runs the /predictive_state_updates flow (request 05): it shows
// the document filling in optimistically WHILE the agent generates it, then settles
// to the committed value.
//
// Signal convention (documented for the client): every STATE_DELTA whose path is
// under "/_predictive" is a PREDICTION — render it ghosted; every other delta is
// COMMITTED. As the model streams the new recipe steps, the growing draft is
// emitted as predictive deltas at "/_predictive/draft". On completion the final
// value is committed at "/recipe/steps" and the "/_predictive" namespace is
// removed. A client that drops every "/_predictive" delta still ends in the correct
// committed state (predictions are an enhancement, not the source of truth).
type PredictiveState struct {
	Deps *Deps
}

const predictiveSystemPrompt = "You are a recipe assistant. When the user asks you to write or " +
	"revise the recipe's steps, respond with the new steps only — one step per line, no " +
	"numbering or preamble. Each line is one step."

// predictiveDraftPath is the namespace marking a delta as a (ghosted) prediction.
const predictiveDraftPath = "/_predictive"

func (p PredictiveState) Run(ctx context.Context, emit *Emitter, in *aguitypes.RunAgentInput, threadID, runID string) {
	emit.RunStarted()

	doc := seedRecipe(in.State)
	emit.StateSnapshot(doc.Snapshot())

	messages := ensureSystemPrompt(toEinoMessages(in.Messages, p.Deps.Provider), predictiveSystemPrompt)

	emit.StepStarted("llm")
	full, err := p.streamPredictive(ctx, emit, doc, messages)
	emit.StepFinished("llm")
	if err != nil {
		// The actual run context and emitter state determine whether this was a
		// shutdown/disconnect. A provider may return context.Canceled or
		// context.DeadlineExceeded for its own internal operation while the run is
		// still live; that is a genuine model failure and must reach the client.
		if ctx.Err() != nil || emit.Err() != nil {
			return
		}
		emit.RunError("the agent failed to generate a response")
		return
	}

	// Settle: commit the finalized steps to the real path, then clear the ghost.
	// The committed value is computed from the final generation, not "promoted"
	// from the last prediction, so a dropped/garbled prediction can't corrupt it.
	steps := splitSteps(full)
	committed := false
	if len(steps) > 0 {
		// `add` (create-or-replace for an object member) so the commit lands even if
		// the client-seeded recipe had no pre-existing "steps" key (replace would
		// fail there and silently drop the generated steps).
		commit := []events.JSONPatchOperation{{Op: "add", Path: "/recipe/steps", Value: steps}}
		if err := doc.Apply(commit); err == nil {
			emit.StateDelta(commit) // committed (not under /_predictive)
			committed = true
		}
	}
	// Remove the draft namespace (itself a predictive op — clients that ignore
	// predictions never created it and simply ignore this too).
	clear := []events.JSONPatchOperation{{Op: "remove", Path: predictiveDraftPath}}
	if err := doc.Apply(clear); err == nil {
		emit.StateDelta(clear)
	}

	// Narrate the committed state honestly: don't claim an update on an empty
	// generation.
	summary := "Updated the recipe steps."
	if !committed {
		summary = "I couldn't produce any steps to update."
	}
	msgID := events.GenerateMessageID()
	emit.TextStart(msgID)
	emit.TextContent(msgID, summary)
	emit.TextEnd(msgID)

	emit.MessagesSnapshot([]aguitypes.Message{
		{ID: msgID, Role: aguitypes.RoleAssistant, Content: summary},
	})
	emit.RunFinishedSuccess()
}

// streamPredictive streams the model turn, emitting the growing draft as predictive
// STATE_DELTAs under /_predictive/draft. It returns the full generated text on
// success and leaves error classification and terminal-event emission to Run, so
// Run can close the active step before emitting RUN_ERROR.
func (p PredictiveState) streamPredictive(ctx context.Context, emit *Emitter, doc *DocState, messages []*schema.Message) (string, error) {
	sr, err := p.Deps.BaseModel.Stream(ctx, messages)
	if err != nil {
		return "", err
	}
	defer sr.Close()

	var b strings.Builder
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if err := emit.Err(); err != nil {
			return "", err
		}
		chunk, recvErr := sr.Recv()
		if errors.Is(recvErr, io.EOF) {
			break
		}
		if recvErr != nil {
			return "", recvErr
		}
		if chunk.Content == "" {
			continue
		}
		b.WriteString(chunk.Content)
		// Emit the current draft as a prediction. `add` to /_predictive is valid
		// whether or not it exists yet (it replaces the whole object), so each
		// update is a single self-contained op carrying the latest draft text.
		op := []events.JSONPatchOperation{{
			Op: "add", Path: predictiveDraftPath, Value: map[string]any{"draft": b.String()},
		}}
		if err := doc.Apply(op); err == nil {
			emit.StateDelta(op)
		}
	}
	return b.String(), nil
}

// stepListMarker matches a single leading ordered/unordered list marker ("1.",
// "2)", "-", "*") followed by whitespace — and ONLY that. A character-class trim
// would corrupt legitimate steps that begin with a number ("2 eggs, beaten") or a
// hyphen, silently mangling the committed recipe.
var stepListMarker = regexp.MustCompile(`^\s*(?:\d+[.)]|[-*])\s+`)

// splitSteps turns the model's newline-separated step text into a steps array,
// trimming blank lines and a leading list marker (but not legitimate leading text).
func splitSteps(text string) []any {
	var steps []any
	for _, line := range strings.Split(text, "\n") {
		s := strings.TrimSpace(line)
		s = stepListMarker.ReplaceAllString(s, "")
		s = strings.TrimSpace(s)
		if s != "" {
			steps = append(steps, s)
		}
	}
	return steps
}

package agent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

// AgenticGenerativeUI runs the /agentic_generative_ui flow (request 06): a
// simulated long-running task reported as a live "steps" checklist the UI renders
// and advances in place. The work is simulated; the point is the streamed progress.
//
// It emits an initial STATE_SNAPSHOT carrying a steps array (all "pending"), then
// per-step STATE_DELTAs flipping "/steps/{i}/status" pending→in_progress→completed,
// paced so the progression is visible, bracketed by STEP_STARTED/FINISHED and a
// concluding text summary. The state shape ({"steps":[{description,status}]}) and
// the "/steps/{i}/status" delta path match what the demo already renders.
type AgenticGenerativeUI struct {
	// Pace is the delay between status transitions. 0 means no delay (tests);
	// the server wires a visible delay so the checklist animates.
	Pace time.Duration
}

// Run executes the flow. It is self-contained — it does not use the model
// tool-loop. ctx cancellation (client disconnect / shutdown) aborts promptly.
func (a AgenticGenerativeUI) Run(ctx context.Context, emit *Emitter, in *aguitypes.RunAgentInput, threadID, runID string) {
	emit.RunStarted()

	descrs := planSteps(in)
	doc := NewDocState(map[string]any{"steps": stepsToState(descrs)})

	// Plan: publish the steps checklist, all pending.
	emit.StepStarted("plan")
	emit.StateSnapshot(doc.Snapshot())
	emit.StepFinished("plan")

	// Execute: advance each step, paced so the UI animates.
	emit.StepStarted("execute")
	for i := range descrs {
		if ctx.Err() != nil || emit.Err() != nil {
			return // client gone / shutting down — stop emitting
		}
		if !a.advance(ctx, emit, doc, i, "in_progress") {
			return
		}
		a.sleep(ctx)
		if ctx.Err() != nil || emit.Err() != nil {
			return
		}
		if !a.advance(ctx, emit, doc, i, "completed") {
			return
		}
		a.sleep(ctx)
	}
	emit.StepFinished("execute")

	// Concluding summary.
	msgID := events.GenerateMessageID()
	emit.TextStart(msgID)
	emit.TextContent(msgID, "All steps complete.")
	emit.TextEnd(msgID)

	emit.MessagesSnapshot([]aguitypes.Message{
		{ID: msgID, Role: aguitypes.RoleAssistant, Content: "All steps complete."},
	})
	emit.RunFinishedSuccess()
}

// advance flips one step's status, keeping DocState consistent and emitting the
// STATE_DELTA. Returns false (after a RUN_ERROR) if the patch fails to apply.
func (a AgenticGenerativeUI) advance(ctx context.Context, emit *Emitter, doc *DocState, i int, status string) bool {
	ops := []events.JSONPatchOperation{
		{Op: "replace", Path: fmt.Sprintf("/steps/%d/status", i), Value: status},
	}
	if err := doc.Apply(ops); err != nil {
		emit.RunError("failed to advance step state")
		return false
	}
	emit.StateDelta(ops)
	return true
}

func (a AgenticGenerativeUI) sleep(ctx context.Context) {
	if a.Pace <= 0 {
		return
	}
	t := time.NewTimer(a.Pace)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// planSteps derives the task plan. The request allows canned content; we keep a
// small, generic, demoable plan and fold the user's ask into the opening step so
// the checklist feels responsive to the prompt.
func planSteps(in *aguitypes.RunAgentInput) []string {
	steps := []string{
		"Gather requirements",
		"Research the approach",
		"Draft the solution",
		"Review and refine",
		"Finalize and summarize",
	}
	if task := lastUserText(in); task != "" {
		steps[0] = "Understand the request: " + truncate(task, 60)
	}
	return steps
}

func stepsToState(descrs []string) []any {
	steps := make([]any, len(descrs))
	for i, d := range descrs {
		steps[i] = map[string]any{"description": d, "status": "pending"}
	}
	return steps
}

// lastUserText returns the text of the most recent user message, if any.
func lastUserText(in *aguitypes.RunAgentInput) string {
	if in == nil {
		return ""
	}
	for i := len(in.Messages) - 1; i >= 0; i-- {
		if in.Messages[i].Role == aguitypes.RoleUser {
			return strings.TrimSpace(messageText(in.Messages[i]))
		}
	}
	return ""
}

// truncate caps a string to n runes (not bytes), so a multibyte character is never
// split into invalid UTF-8 in the step description.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n])) + "…"
}

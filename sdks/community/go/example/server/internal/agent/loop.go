package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/config"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/runstore"
)

// defaultSystemPrompt is used when the request carries no system/developer
// message and steers the model toward the read-only file_read tool.
const defaultSystemPrompt = "You are a helpful assistant operating in a read-only file workspace. " +
	"Use the file_read tool (with a workspace-relative path) to read file contents when the user asks about files. " +
	"You cannot create, modify, or delete files. Be concise."

// ensureSystemPrompt guarantees a leading system message. prompt is the route's
// posture; an empty prompt falls back to the default (which steers toward the
// read-only file_read tool).
// Feature routes pass their own prompt so they never advertise file_read.
func ensureSystemPrompt(messages []*schema.Message, prompt string) []*schema.Message {
	for _, m := range messages {
		if m.Role == schema.System {
			return messages
		}
	}
	if prompt == "" {
		prompt = defaultSystemPrompt
	}
	return append([]*schema.Message{schema.SystemMessage(prompt)}, messages...)
}

// Deps are the shared dependencies for running an agent turn.
//
// Deps is shared across all concurrent requests; never mutate it per request.
// Per-request tool binding derives a new model from BaseModel via WithTools inside
// Run (WithTools returns a fresh instance), so concurrent requests with different
// client tools never clobber each other.
type Deps struct {
	Model         model.ToolCallingChatModel // file_read-bound; used by /agentic and the ServerOnly path
	BaseModel     model.ToolCallingChatModel // unbound; WithTools is applied per request on the ClientTools path
	Tools         *Toolset
	Store         *runstore.Store
	AutoApprove   bool
	MaxIterations int // <= 0 falls back to config.DefaultMaxIterations
	Logger        *slog.Logger
	// Provider is the model-backend name (e.g. "openai"). It gates multimodal
	// content forwarding: only "openai" sends image parts to the model; other
	// backends receive text-only messages.
	Provider string
}

// Run executes one AG-UI run: it streams the full event surface for either a
// fresh request or a resume of a previously interrupted run.
//
// Each call emits a self-contained event sequence (RUN_STARTED … RUN_FINISHED).
// A resume reuses the original threadID/runID (that is how the paused run is keyed),
// so the same runID legitimately appears in two responses. A consumer that
// concatenates the events of multiple /agentic responses for one runID and runs the
// SDK's ValidateSequence over the merged log will see a second RUN_STARTED and reject
// it — treat each response as its own sequence, not one continuous log.
func Run(ctx context.Context, emit *Emitter, in *aguitypes.RunAgentInput, deps *Deps, cfg RunConfig, threadID, runID string) {
	emit.RunStarted()

	// Per-request model. On the ClientTools track, bind the client-defined tools
	// (and optionally file_read) to a fresh instance derived from BaseModel —
	// WithTools returns a new instance, so concurrent requests never clobber each
	// other and the shared deps.Model/BaseModel are never mutated.
	cm := deps.Model
	clientNames := make(map[string]bool, len(in.Tools))
	if cfg.ToolPolicy == ClientTools {
		clientInfos, err := clientToolInfos(in.Tools)
		if err != nil {
			emit.RunError(err.Error())
			return
		}
		for _, t := range in.Tools {
			clientNames[t.Name] = true
		}
		infos := clientInfos
		if cfg.ExposeFileRead {
			infos = append(append([]*schema.ToolInfo{}, deps.Tools.Infos()...), clientInfos...)
		}
		bound, err := deps.BaseModel.WithTools(infos)
		if err != nil {
			emit.RunError("failed to bind client tools")
			return
		}
		cm = bound
	}

	key := runstore.Key(threadID, runID)
	var (
		st       *State
		messages []*schema.Message
	)

	// Resume path: rehydrate a paused run and settle the pending tool calls.
	if len(in.Resume) > 0 {
		// Peek with a non-destructive Load so a malformed/partial resume can be
		// retried. Claiming (LoadAndDelete) before validation would destroy the
		// paused run on an ordinary user error — a typo'd InterruptID or a resume
		// that addresses only some pending calls — with no way for the client to
		// re-submit a corrected resume.
		saved, ok := deps.Store.Load(key)
		if !ok {
			emit.RunError("cannot resume: no paused run found for this thread/run " +
				"(it may have expired, already been resumed, or the server restarted)")
			return
		}

		approvals := approvalsFromResume(in.Resume)
		// Every pending tool call needs an explicit decision; otherwise the
		// zero-value map lookup would silently deny an un-addressed call. Validate
		// before claiming so a failed validation leaves the paused run intact.
		undecided := 0
		for _, tc := range saved.Pending {
			if _, decided := approvals[tc.ID]; !decided {
				undecided++
			}
		}
		if undecided == len(saved.Pending) && len(saved.Pending) > 0 {
			emit.RunError("resume entries do not match any pending tool call for this run")
			return
		}
		if undecided > 0 {
			for _, tc := range saved.Pending {
				if _, decided := approvals[tc.ID]; !decided {
					emit.RunError(fmt.Sprintf("resume did not address pending tool call %q", tc.ID))
					return
				}
			}
		}

		// Validation passed — now claim the run atomically so two concurrent
		// resumes cannot both execute the pending tool calls. The loser of a race
		// gets a clean RUN_ERROR rather than a double-execution. Commit to the
		// `saved` snapshot read above; the claim is only for exclusivity.
		if _, claimed := deps.Store.LoadAndDelete(key); !claimed {
			emit.RunError("cannot resume: the paused run was claimed by a concurrent resume")
			return
		}
		st = StateFromSnapshot(saved.State)
		messages = saved.Messages
		emit.StateSnapshot(st.Snapshot())

		emit.StepStarted("tools")
		// Re-surface the proposal (START/ARGS/END) in this new stream so a client
		// rendering tool cards has the call to attach the result to — the original
		// proposal was emitted in the prior (interrupted) response, not this one.
		for _, tc := range saved.Pending {
			emitToolProposal(emit, tc)
		}
		settlePendingToolCalls(ctx, emit, deps, saved.Pending, &messages, st, approvals)
		emit.StepFinished("tools")
	}

	// Fresh path.
	if st == nil {
		st = NewState()
		st.Seed(in.State)
		messages = ensureSystemPrompt(toEinoMessages(in.Messages, deps.Provider), cfg.SystemPrompt)
		emit.StateSnapshot(st.Snapshot())
	}

	maxIter := deps.MaxIterations
	if maxIter <= 0 {
		maxIter = config.DefaultMaxIterations
	}
	if maxIter > config.MaxIterationsCeiling {
		deps.Logger.Warn("clamping MaxIterations to ceiling",
			"requested", maxIter, "ceiling", config.MaxIterationsCeiling)
		maxIter = config.MaxIterationsCeiling
	}

	converged := false
	for iter := 0; iter < maxIter; iter++ {
		if emit.Err() != nil || ctx.Err() != nil {
			return // client disconnected
		}

		emit.StepStarted("llm")
		assistant, err := streamTurn(ctx, emit, cm, messages, cfg.StreamToolCalls)
		emit.StepFinished("llm")
		if err != nil {
			// A canceled context or an already-gated emitter means the client
			// disconnected or the server is shutting down — both normal for an SSE
			// server. Don't log at ERROR, and skip RUN_ERROR: the emitter is either
			// already gated, or the SDK's encoder drops the write on the canceled
			// context anyway (it checks ctx.Err() before encoding), so the terminal
			// event could not reach the client.
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || emit.Err() != nil {
				deps.Logger.Info("run aborted (client gone or shutting down)", "thread", threadID, "run", runID)
				return
			}
			deps.Logger.Error("model turn failed", "thread", threadID, "run", runID, "error", err)
			emit.RunError("the agent failed to generate a response")
			return
		}
		messages = append(messages, assistant)

		// Validate model-emitted tool calls before proposing or executing them.
		// actionable is the subset worth running; assistant.ToolCalls is narrowed to
		// the calls kept on the message (each retaining a matching tool response).
		actionable := validateToolCalls(emit, deps.Logger, assistant, &messages)

		if len(assistant.ToolCalls) == 0 {
			converged = true
			break // final answer (no usable tool calls)
		}
		if len(actionable) == 0 {
			continue // only malformed calls this turn; let the model retry with the corrections
		}

		// Streaming tools-track (01/02/03): the TOOL_CALL_* already streamed during
		// the {llm} step via streamTurn's tap, so do NOT re-emit (that would double
		// every call). Route the finalized calls instead — never interrupt.
		if cfg.StreamToolCalls {
			serverCalls, clientCalls := classifyToolCalls(actionable, clientNames)
			if len(clientCalls) > 0 {
				// Hand-back: the server can't execute client-defined tools. Finish
				// with a plain RUN_FINISHED so the client fulfills and starts Run B.
				// (Mixed server+client: also hand back; don't run the server tool —
				// avoids the "who echoes the server result in Run B" ambiguity.)
				//
				// Any server call in this turn won't be executed, so answer it with a
				// synthetic tool result; otherwise the MESSAGES_SNAPSHOT would carry an
				// assistant tool call with no matching tool response, which some SDK
				// sequence validators reject. (Only reachable if the model hallucinates
				// an unknown tool alongside a real client call — a narrow case.)
				for _, sc := range serverCalls {
					messages = append(messages, schema.ToolMessage(
						`{"error":"not executed: a client tool in this turn took priority"}`, sc.ID))
				}
				emit.MessagesSnapshot(toAGUIMessages(messages))
				emit.RunFinishedSuccess()
				return
			}
			// Server-only this turn: execute (emits TOOL_CALL_RESULT only; START/ARGS/END
			// already streamed) and continue the loop. No interrupt on this track.
			settlePendingToolCalls(ctx, emit, deps, serverCalls, &messages, st, nil)
			continue
		}

		emit.StepStarted("tools")
		for _, tc := range actionable {
			emitToolProposal(emit, tc)
		}

		if !deps.AutoApprove && !cfg.NeverInterrupt {
			// Human-in-the-loop: pause for approval and finish with an interrupt.
			// cfg.NeverInterrupt forces the auto-execute path below even when
			// AutoApprove is off — feature routes the Dart client can't resume set
			// it so a stray non-streaming config can never deadlock on an interrupt.
			interrupts := make([]aguitypes.Interrupt, 0, len(actionable))
			for _, tc := range actionable {
				emit.ActivitySnapshot(aguievents.GenerateMessageID(), "approval_request",
					map[string]any{"text": fmt.Sprintf("Agent wants to call %s with %s — approve?", tc.Function.Name, tc.Function.Arguments)})
				interrupts = append(interrupts, aguitypes.Interrupt{
					ID:         tc.ID,
					Reason:     "tool_call",
					Message:    fmt.Sprintf("Approve %s(%s)?", tc.Function.Name, tc.Function.Arguments),
					ToolCallID: tc.ID,
					ResponseSchema: map[string]any{
						"type":       "object",
						"properties": map[string]any{"approved": map[string]any{"type": "boolean"}},
						"required":   []any{"approved"},
					},
				})
			}
			// Flip the status before snapshotting so the persisted state matches the
			// STATE_DELTA the client just saw; otherwise a resume's STATE_SNAPSHOT
			// would regress the client back to the pre-pause status.
			emit.StateDelta(st.SetStatus("awaiting_approval"))
			deps.Store.Save(key, &runstore.Saved{
				Messages: messages,
				Pending:  actionable,
				State:    st.Snapshot(),
			})
			emit.StepFinished("tools")
			emit.MessagesSnapshot(toAGUIMessages(messages))
			emit.RunFinishedInterrupt(interrupts)
			return
		}

		// Auto-approve: execute immediately and continue the loop.
		settlePendingToolCalls(ctx, emit, deps, actionable, &messages, st, nil)
		emit.StepFinished("tools")
	}

	if !converged {
		// Hit the iteration cap with tool calls still pending — the model never
		// produced a final answer, so this is an error, not a successful run.
		deps.Logger.Warn("agent did not converge within iteration budget",
			"thread", threadID, "run", runID, "maxIterations", maxIter)
		emit.MessagesSnapshot(toAGUIMessages(messages))
		emit.RunError(fmt.Sprintf("agent did not converge within %d iterations", maxIter))
		return
	}

	emit.StateDelta(st.SetStatus("done"))
	// agent_complete is emitted only on the converged (success) path; the error and
	// interrupt terminal paths intentionally omit it.
	emit.Custom("agent_complete", map[string]any{"toolCalls": st.ToolCalls, "filesRead": st.FilesRead})
	emit.MessagesSnapshot(toAGUIMessages(messages))
	emit.RunFinishedSuccess()
}

// streamTurn streams one model turn, emitting reasoning and text events as
// chunks arrive, and returns the merged assistant message (Extra preserved so
// the codex model's reasoning items thread across turns).
//
// When streamToolCalls is true, it also surfaces tool calls live: as the model
// streams a call (OPEN chunk with id+name → arg-fragment chunks → empty CLOSE
// chunk), it emits TOOL_CALL_START (lazily, once a non-empty id AND name are
// known — buffering arg fragments until then, since the SDK rejects an empty
// toolCallId), TOOL_CALL_ARGS per non-empty fragment, and TOOL_CALL_END for every
// opened call at stream EOF. Callers that stream MUST NOT also emitToolProposal
// for the same calls (that double-emits). When false, tool calls are left for the
// caller to surface post-turn.
func streamTurn(ctx context.Context, emit *Emitter, cm model.ToolCallingChatModel, messages []*schema.Message, streamToolCalls bool) (*schema.Message, error) {
	sr, err := cm.Stream(ctx, messages)
	if err != nil {
		return nil, err
	}
	defer sr.Close()

	var chunks []*schema.Message
	var textID string      // assigned a fresh id each time a text block opens
	var reasoningID string // assigned a fresh id each time a reasoning block opens
	textOpen, reasoningOpen := false, false

	// Streaming tool-call tap state, keyed by tool-call identity (Index, stable per
	// call across OPEN/delta/CLOSE chunks).
	type tcStream struct {
		started  bool
		id, name string
		buffered []string // arg fragments held until id+name are known
	}
	tcs := map[string]*tcStream{}
	var tcOrder []string

	closeReasoning := func() {
		if reasoningOpen {
			emit.ReasoningMessageEnd(reasoningID)
			emit.ReasoningEnd(reasoningID)
			reasoningOpen = false
		}
	}
	closeText := func() {
		if textOpen {
			emit.TextEnd(textID)
			textOpen = false
		}
	}
	// streamToolCallChunk surfaces one chunk's tool-call fragments live.
	streamToolCallChunk := func(chunk *schema.Message) {
		if len(chunk.ToolCalls) == 0 {
			return
		}
		// A tool call ends any open text/reasoning block so blocks never overlap.
		closeReasoning()
		closeText()
		for _, tc := range chunk.ToolCalls {
			key := toolCallKey(tc)
			st := tcs[key]
			if st == nil {
				st = &tcStream{}
				tcs[key] = st
				tcOrder = append(tcOrder, key)
			}
			if tc.Function.Name != "" {
				st.name = tc.Function.Name
			}
			if tc.ID != "" {
				st.id = tc.ID
			}
			frag := tc.Function.Arguments
			switch {
			case st.started:
				emit.ToolArgs(st.id, frag) // emitter skips empty
			case st.id != "" && st.name != "":
				emit.ToolStart(st.id, st.name)
				st.started = true
				for _, b := range st.buffered {
					emit.ToolArgs(st.id, b)
				}
				st.buffered = nil
				emit.ToolArgs(st.id, frag)
			case frag != "":
				st.buffered = append(st.buffered, frag) // hold until id+name known
			}
		}
	}
	// endStreamedToolCalls closes every opened call. Text/reasoning are closed first
	// so an open TEXT block (a model that streamed text after the tool call) is
	// terminated before the tool-call END, keeping blocks non-overlapping.
	endStreamedToolCalls := func() {
		closeReasoning()
		closeText()
		for _, key := range tcOrder {
			if st := tcs[key]; st.started {
				emit.ToolEnd(st.id)
				st.started = false // idempotent: never emit END twice for the same call
			}
		}
	}
	// closeOpenBlocks balances any started message block. Deferred so that EVERY
	// exit path — EOF, a mid-stream Recv error, or ctx cancel — closes open
	// TEXT/REASONING blocks AND opened tool calls on the wire, rather than leaving a
	// client hanging on a dangling TOOL_CALL_START or open message.
	closeOpenBlocks := func() {
		if streamToolCalls {
			endStreamedToolCalls()
			return // endStreamedToolCalls already closed reasoning+text
		}
		closeReasoning()
		closeText()
	}
	defer closeOpenBlocks()

	for {
		if err := ctx.Err(); err != nil {
			return nil, err // client gone; stop draining the model stream
		}
		if emit.Err() != nil {
			return nil, emit.Err()
		}
		chunk, recvErr := sr.Recv()
		if errors.Is(recvErr, io.EOF) {
			break
		}
		if recvErr != nil {
			return nil, recvErr // deferred closeOpenBlocks balances the stream
		}
		if chunk.ReasoningContent != "" {
			// Reasoning after text has started (a future provider may interleave):
			// close the open TEXT block first so blocks never overlap on the wire.
			if textOpen {
				emit.TextEnd(textID)
				textOpen = false
			}
			if !reasoningOpen {
				// Fresh id per block so a reasoning span that reopens after text is
				// never a re-opened same-id block.
				reasoningID = aguievents.GenerateMessageID()
				emit.ReasoningStart(reasoningID)
				emit.ReasoningMessageStart(reasoningID)
				reasoningOpen = true
			}
			emit.ReasoningContent(reasoningID, chunk.ReasoningContent)
		}
		if chunk.Content != "" {
			closeReasoning() // reasoning precedes the visible answer
			if !textOpen {
				// Fresh id per block so a text span that reopens after reasoning is
				// never a re-opened same-id block.
				textID = aguievents.GenerateMessageID()
				emit.TextStart(textID)
				textOpen = true
			}
			emit.TextContent(textID, chunk.Content)
		}
		if streamToolCalls {
			streamToolCallChunk(chunk)
		}
		chunks = append(chunks, chunk)
	}
	// TOOL_CALL_END for every opened call is emitted by the deferred closeOpenBlocks,
	// so it fires on the EOF path AND on a mid-stream error (no dangling START).
	if len(chunks) == 0 {
		return nil, fmt.Errorf("empty model stream")
	}
	return schema.ConcatMessages(chunks)
}

// toolCallKey identifies a streaming tool call stably across its OPEN/delta/CLOSE
// chunks. Index is non-nil on every chunk from both providers; the fallbacks keep
// a malformed stream from collapsing distinct calls onto one key.
func toolCallKey(tc schema.ToolCall) string {
	if tc.Index != nil {
		return "i" + strconv.Itoa(*tc.Index)
	}
	if tc.ID != "" {
		return "d" + tc.ID
	}
	return "p0"
}

// validateToolCalls partitions model-emitted tool calls into the calls kept on the
// assistant message (every kept call retains a matching tool response, which the
// provider requires) and the actionable subset worth proposing/executing.
//
// A call with an empty name or non-JSON arguments is malformed: it is kept on the
// message and answered with a corrective tool-role message so the model can recover
// in-turn, but it is NOT proposed or executed. A call with an empty ID is
// uncorrelatable (no tool response can be keyed to it) so it is dropped from the
// assistant message entirely. This stops an empty toolCallName from reaching the SDK
// encoder, which rejects it — a rejection the emitter would otherwise misread as a
// client disconnect, silently killing the run with no RUN_ERROR.
func validateToolCalls(emit *Emitter, logger *slog.Logger, assistant *schema.Message, messages *[]*schema.Message) []schema.ToolCall {
	return validateToolCallsOpt(emit, logger, assistant, messages, true)
}

// validateToolCallsQuiet behaves like validateToolCalls but does NOT emit a
// TOOL_CALL_RESULT event for a malformed call — it only threads the corrective
// tool-role message back into the conversation. Routes whose contract forbids
// tool-call events on the wire (e.g. /shared_state, /predictive_state_updates) use
// this so a malformed model call can't leak a TOOL_CALL_RESULT.
func validateToolCallsQuiet(logger *slog.Logger, assistant *schema.Message, messages *[]*schema.Message) []schema.ToolCall {
	return validateToolCallsOpt(nil, logger, assistant, messages, false)
}

func validateToolCallsOpt(emit *Emitter, logger *slog.Logger, assistant *schema.Message, messages *[]*schema.Message, emitResults bool) []schema.ToolCall {
	kept := make([]schema.ToolCall, 0, len(assistant.ToolCalls))
	actionable := make([]schema.ToolCall, 0, len(assistant.ToolCalls))
	corrective := func(tc schema.ToolCall, result string) {
		if emitResults {
			emit.ToolResult(aguievents.GenerateMessageID(), tc.ID, result)
		}
		*messages = append(*messages, schema.ToolMessage(result, tc.ID))
		kept = append(kept, tc)
	}
	for _, tc := range assistant.ToolCalls {
		switch {
		case tc.ID == "":
			logger.Warn("dropping tool call with empty id", "name", tc.Function.Name)
		case tc.Function.Name == "":
			corrective(tc, `{"error":"tool call had an empty function name"}`)
		case !json.Valid([]byte(tc.Function.Arguments)):
			corrective(tc, fmt.Sprintf(`{"error":"tool arguments for %q were not valid JSON"}`, tc.Function.Name))
		default:
			kept = append(kept, tc)
			actionable = append(actionable, tc)
		}
	}
	assistant.ToolCalls = kept
	return actionable
}

// emitToolProposal surfaces a proposed tool call (start/args/end), independent of
// whether it will be executed now or after an approval interrupt.
func emitToolProposal(emit *Emitter, tc schema.ToolCall) {
	emit.ToolStart(tc.ID, tc.Function.Name)
	emit.ToolArgs(tc.ID, tc.Function.Arguments)
	emit.ToolEnd(tc.ID)
}

// settlePendingToolCalls executes (or, when denied, records a denial for) each
// tool call, emitting the result and threading a role=tool message back into the
// conversation. A nil approvals map means "approve all" (auto-approve path).
func settlePendingToolCalls(ctx context.Context, emit *Emitter, deps *Deps, calls []schema.ToolCall, messages *[]*schema.Message, st *State, approvals map[string]bool) {
	for _, tc := range calls {
		approved := approvals == nil || approvals[tc.ID]
		var result string
		if approved {
			emit.ActivitySnapshot(aguievents.GenerateMessageID(), "tool_use",
				map[string]any{"text": fmt.Sprintf("Running %s(%s)", tc.Function.Name, tc.Function.Arguments)})
			out, err := deps.Tools.Run(ctx, tc.Function.Name, tc.Function.Arguments)
			if err != nil {
				// A failed read must not be recorded as a file successfully read.
				// TODO(prod): the raw error can carry filesystem-shape detail. Feed the
				// verbatim diagnostic to the model but sanitize what reaches the client.
				out = fmt.Sprintf(`{"error":%q}`, err.Error())
				emit.StateDelta(st.SetStatus("read_error"))
			} else {
				emit.StateDelta(st.RecordFileRead(extractPath(tc.Function.Arguments)))
			}
			result = out
		} else {
			result = `{"denied":true,"reason":"user did not approve this tool call"}`
		}
		emit.ToolResult(aguievents.GenerateMessageID(), tc.ID, result)
		*messages = append(*messages, schema.ToolMessage(result, tc.ID))
	}
}

// approvalsFromResume maps resume entries to per-tool-call approval. An entry is
// approved when status is "resolved" and its payload does not carry approved:false.
func approvalsFromResume(entries []aguitypes.ResumeEntry) map[string]bool {
	approvals := make(map[string]bool, len(entries))
	for _, e := range entries {
		approved := e.Status == aguitypes.ResumeStatusResolved
		if approved {
			if m, ok := e.Payload.(map[string]any); ok {
				if v, ok := m["approved"].(bool); ok {
					approved = v
				}
			}
		}
		approvals[e.InterruptID] = approved
	}
	return approvals
}

// extractPath pulls the path out of file_read arguments for a human-readable
// state/activity label only. It is best-effort: malformed args or a missing path
// both yield "(unknown)". The tool itself validates the real arguments.
func extractPath(argsJSON string) string {
	var a struct {
		Path string `json:"path"`
	}
	_ = json.Unmarshal([]byte(argsJSON), &a)
	if a.Path == "" {
		return "(unknown)"
	}
	return a.Path
}

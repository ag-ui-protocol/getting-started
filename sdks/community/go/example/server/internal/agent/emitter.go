package agent

import (
	"bufio"
	"context"
	"strings"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
)

// Emitter serializes AG-UI events to an SSE stream. It records the first write
// error and becomes a no-op afterward, so loop code can stay terse and check
// Err() at convenient points (a write error means the client disconnected).
//
// On the first write failure it invokes cancel (if set), which cancels the run
// context so an in-flight model stream aborts promptly instead of generating
// against a gone client. This is how client disconnect is detected: fasthttp's
// RequestCtx does not signal disconnect, only a failed SSE write does.
type Emitter struct {
	ctx      context.Context
	w        *bufio.Writer
	sse      *sse.SSEWriter
	threadID string
	runID    string
	cancel   context.CancelFunc
	err      error // first transport (disconnect) error; once set, all writes are no-ops
	encErr   error // first encoding/validation error; the event was dropped but the stream stays live
}

// NewEmitter builds an Emitter bound to a request's SSE writer. cancel may be
// nil; when non-nil it is called once, on the first write error.
func NewEmitter(ctx context.Context, w *bufio.Writer, sw *sse.SSEWriter, threadID, runID string, cancel context.CancelFunc) *Emitter {
	return &Emitter{ctx: ctx, w: w, sse: sw, threadID: threadID, runID: runID, cancel: cancel}
}

// Err returns the first transport (client-disconnect) error, if any.
func (e *Emitter) Err() error { return e.err }

// EncErr returns the first encoding/validation error, if any. Unlike Err it does
// not gate subsequent writes: a malformed event is dropped (and logged by the SDK)
// but the stream stays alive so the run can still reach a terminal event.
func (e *Emitter) EncErr() error { return e.encErr }

func (e *Emitter) write(ev events.Event) {
	if e.err != nil {
		return
	}
	if err := e.sse.WriteEvent(e.ctx, e.w, ev); err != nil {
		if isTransportError(err) {
			// The client is gone. Stop emitting and cancel the run context so an
			// in-flight model stream aborts promptly.
			e.err = err
			if e.cancel != nil {
				e.cancel()
			}
			return
		}
		// An encoding/validation failure is a content bug, not a disconnect. Record
		// it for visibility and drop just this event; keep the stream open so a
		// terminal RUN_ERROR/RUN_FINISHED can still be written.
		if e.encErr == nil {
			e.encErr = err
		}
	}
}

// isTransportError reports whether a WriteEvent error came from the socket write or
// flush (client gone) rather than event encoding/frame creation (a content bug).
// The SDK does not export typed errors, so this matches its wrapper prefixes
// (pkg/encoding/sse/writer.go); keep it in sync if those strings change.
func isTransportError(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "SSE write failed") || strings.Contains(msg, "SSE flush failed")
}

// --- run lifecycle ---

func (e *Emitter) RunStarted() { e.write(events.NewRunStartedEvent(e.threadID, e.runID)) }

func (e *Emitter) RunFinishedSuccess() {
	e.write(events.NewRunFinishedEventWithOptions(e.threadID, e.runID, events.WithSuccessOutcome()))
}

func (e *Emitter) RunFinishedInterrupt(interrupts []types.Interrupt) {
	e.write(events.NewRunFinishedEventWithOptions(e.threadID, e.runID, events.WithInterruptOutcome(interrupts)))
}

func (e *Emitter) RunError(msg string) {
	e.write(events.NewRunErrorEvent(msg, events.WithRunID(e.runID)))
}

// --- steps ---

func (e *Emitter) StepStarted(name string)  { e.write(events.NewStepStartedEvent(name)) }
func (e *Emitter) StepFinished(name string) { e.write(events.NewStepFinishedEvent(name)) }

// --- text messages ---

func (e *Emitter) TextStart(id string) {
	e.write(events.NewTextMessageStartEvent(id, events.WithRole("assistant")))
}

func (e *Emitter) TextContent(id, delta string) {
	if delta == "" {
		return // SDK rejects empty deltas
	}
	e.write(events.NewTextMessageContentEvent(id, delta))
}

func (e *Emitter) TextEnd(id string) { e.write(events.NewTextMessageEndEvent(id)) }

// --- reasoning ---

func (e *Emitter) ReasoningStart(id string) { e.write(events.NewReasoningStartEvent(id)) }

func (e *Emitter) ReasoningMessageStart(id string) {
	e.write(events.NewReasoningMessageStartEvent(id, "assistant"))
}

func (e *Emitter) ReasoningContent(id, delta string) {
	if delta == "" {
		return
	}
	e.write(events.NewReasoningMessageContentEvent(id, delta))
}

func (e *Emitter) ReasoningMessageEnd(id string) { e.write(events.NewReasoningMessageEndEvent(id)) }
func (e *Emitter) ReasoningEnd(id string)        { e.write(events.NewReasoningEndEvent(id)) }

// --- tool calls ---

func (e *Emitter) ToolStart(toolCallID, name string) {
	e.write(events.NewToolCallStartEvent(toolCallID, name))
}

func (e *Emitter) ToolArgs(toolCallID, delta string) {
	if delta == "" {
		return
	}
	e.write(events.NewToolCallArgsEvent(toolCallID, delta))
}

func (e *Emitter) ToolEnd(toolCallID string) { e.write(events.NewToolCallEndEvent(toolCallID)) }

func (e *Emitter) ToolResult(messageID, toolCallID, content string) {
	if content == "" {
		content = "(empty)"
	}
	e.write(events.NewToolCallResultEvent(messageID, toolCallID, content))
}

// --- state ---

func (e *Emitter) StateSnapshot(snapshot any) {
	e.write(events.NewStateSnapshotEvent(snapshot))
}

func (e *Emitter) StateDelta(ops []events.JSONPatchOperation) {
	if len(ops) == 0 {
		return
	}
	e.write(events.NewStateDeltaEvent(ops))
}

func (e *Emitter) MessagesSnapshot(msgs []types.Message) {
	e.write(events.NewMessagesSnapshotEvent(scrubEncryptedValues(msgs)))
}

// scrubEncryptedValues returns the slice with EncryptedValue/EncryptedContent
// zeroed on every message. This prevents encrypted reasoning blobs from leaking
// to clients via MESSAGES_SNAPSHOT payloads. It is a no-op (returns the original
// slice unchanged) when no message carries either field, keeping the common path
// allocation-free.
func scrubEncryptedValues(msgs []types.Message) []types.Message {
	needsScrub := false
	for i := range msgs {
		if msgs[i].EncryptedValue != "" || msgs[i].EncryptedContent != "" {
			needsScrub = true
			break
		}
	}
	if !needsScrub {
		return msgs
	}
	out := make([]types.Message, len(msgs))
	copy(out, msgs)
	for i := range out {
		out[i].EncryptedValue = ""
		out[i].EncryptedContent = ""
	}
	return out
}

// --- activity / custom ---

func (e *Emitter) ActivitySnapshot(messageID, activityType string, content any) {
	e.write(events.NewActivitySnapshotEvent(messageID, activityType, content))
}

func (e *Emitter) ActivityDelta(messageID, activityType string, patch []events.JSONPatchOperation) {
	if len(patch) == 0 {
		return
	}
	e.write(events.NewActivityDeltaEvent(messageID, activityType, patch))
}

func (e *Emitter) ReasoningEncryptedValue(subtype events.ReasoningEncryptedValueSubtype, entityID, encryptedValue string) {
	e.write(events.NewReasoningEncryptedValueEvent(subtype, entityID, encryptedValue))
}

func (e *Emitter) Custom(name string, value any) {
	e.write(events.NewCustomEvent(name, events.WithValue(value)))
}

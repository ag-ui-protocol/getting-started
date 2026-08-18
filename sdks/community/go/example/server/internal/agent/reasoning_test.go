package agent

import (
	"bufio"
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

// fakeModel yields a fixed set of streamed chunks. It exists to exercise the
// REASONING_* emit path, which the live codex proof does not trigger (gpt-5.5
// returns encrypted reasoning, not plaintext ReasoningContent).
type fakeModel struct{ chunks []*schema.Message }

func (f *fakeModel) Generate(_ context.Context, _ []*schema.Message, _ ...model.Option) (*schema.Message, error) {
	return schema.ConcatMessages(f.chunks)
}

func (f *fakeModel) Stream(_ context.Context, _ []*schema.Message, _ ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	sr, sw := schema.Pipe[*schema.Message](len(f.chunks) + 1)
	go func() {
		defer sw.Close()
		for _, c := range f.chunks {
			sw.Send(c, nil)
		}
	}()
	return sr, nil
}

func (f *fakeModel) WithTools(_ []*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	return f, nil
}

func TestStreamTurnEmitsReasoningThenText(t *testing.T) {
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), "t", "r", nil)

	fm := &fakeModel{chunks: []*schema.Message{
		{Role: schema.Assistant, ReasoningContent: "let me think"},
		{Role: schema.Assistant, Content: "Hello"},
		{Role: schema.Assistant, Content: " world"},
	}}

	msg, err := streamTurn(context.Background(), emit, fm, nil, false)
	if err != nil {
		t.Fatalf("streamTurn: %v", err)
	}
	_ = w.Flush()
	out := buf.String()

	for _, want := range []string{
		`"type":"REASONING_START"`,
		`"type":"REASONING_MESSAGE_START"`,
		`"type":"REASONING_MESSAGE_CONTENT"`,
		`"type":"REASONING_MESSAGE_END"`,
		`"type":"REASONING_END"`,
		`"type":"TEXT_MESSAGE_START"`,
		`"type":"TEXT_MESSAGE_CONTENT"`,
		`"type":"TEXT_MESSAGE_END"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing event %s", want)
		}
	}
	if strings.Index(out, `"type":"REASONING_END"`) > strings.Index(out, `"type":"TEXT_MESSAGE_START"`) {
		t.Errorf("reasoning block must close before text starts")
	}
	if msg.Content != "Hello world" {
		t.Errorf("merged content = %q, want %q", msg.Content, "Hello world")
	}
}

// TestStreamTurnClosesTextBeforeInterleavedReasoning guards the symmetric block
// close: if a provider emits reasoning AFTER text has started, the open TEXT block
// must close before the REASONING block opens, so the two never overlap on the
// wire. Latent today (the live provider sends reasoning-before-text) but activates
// silently on a provider change.
func TestStreamTurnClosesTextBeforeInterleavedReasoning(t *testing.T) {
	var buf bytes.Buffer
	w := bufio.NewWriter(&buf)
	emit := NewEmitter(context.Background(), w, sse.NewSSEWriter(), "t", "r", nil)

	fm := &fakeModel{chunks: []*schema.Message{
		{Role: schema.Assistant, Content: "first"},
		{Role: schema.Assistant, ReasoningContent: "rethink"},
		{Role: schema.Assistant, Content: "second"},
	}}

	if _, err := streamTurn(context.Background(), emit, fm, nil, false); err != nil {
		t.Fatalf("streamTurn: %v", err)
	}
	_ = w.Flush()
	out := buf.String()

	// The first TEXT block must close before the interleaved REASONING opens.
	firstTextEnd := strings.Index(out, `"type":"TEXT_MESSAGE_END"`)
	reasoningStart := strings.Index(out, `"type":"REASONING_START"`)
	if firstTextEnd == -1 || reasoningStart == -1 {
		t.Fatalf("expected both a TEXT_MESSAGE_END and a REASONING_START:\n%s", out)
	}
	if firstTextEnd > reasoningStart {
		t.Errorf("the TEXT block must close before the interleaved REASONING opens:\n%s", out)
	}

	// And REASONING must close before the second TEXT block opens.
	reasoningEnd := strings.Index(out, `"type":"REASONING_END"`)
	secondTextStart := strings.LastIndex(out, `"type":"TEXT_MESSAGE_START"`)
	if reasoningEnd == -1 || secondTextStart == -1 {
		t.Fatalf("expected a REASONING_END and a second TEXT_MESSAGE_START:\n%s", out)
	}
	if reasoningEnd > secondTextStart {
		t.Errorf("REASONING must close before the second TEXT block opens:\n%s", out)
	}
}

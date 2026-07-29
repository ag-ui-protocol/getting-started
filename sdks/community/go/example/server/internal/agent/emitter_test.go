package agent

import (
	"bufio"
	"context"
	"errors"
	"testing"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
)

// failWriter always fails, forcing the SDK writer's write/flush error path.
type failWriter struct{}

func (failWriter) Write([]byte) (int, error) { return 0, errors.New("socket gone") }

// TestScrubEncryptedValues verifies that scrubEncryptedValues zeroes cipher
// fields on messages that carry them while leaving other fields intact, and
// returns the original slice unchanged (no allocation) when there is nothing to scrub.
func TestScrubEncryptedValues(t *testing.T) {
	plain := types.Message{ID: "1", Role: types.RoleUser, Content: "hello"}
	withCipher := types.Message{
		ID:               "2",
		Role:             types.RoleAssistant,
		Content:          "thinking…",
		EncryptedValue:   "secret-ev",
		EncryptedContent: "secret-ec",
	}

	// No cipher → original slice returned (pointer equality).
	noCipher := []types.Message{plain}
	if got := scrubEncryptedValues(noCipher); &got[0] != &noCipher[0] {
		t.Error("expected original slice back when no scrubbing needed")
	}

	// Cipher present → new slice with fields zeroed, other fields preserved.
	msgs := []types.Message{plain, withCipher}
	got := scrubEncryptedValues(msgs)
	if got[1].EncryptedValue != "" {
		t.Errorf("EncryptedValue not scrubbed: %q", got[1].EncryptedValue)
	}
	if got[1].EncryptedContent != "" {
		t.Errorf("EncryptedContent not scrubbed: %q", got[1].EncryptedContent)
	}
	if got[1].Content != withCipher.Content {
		t.Errorf("Content modified unexpectedly: %q", got[1].Content)
	}
	// Original slice must be unmodified (copy, not in-place).
	if msgs[1].EncryptedValue != "secret-ev" {
		t.Error("original slice was mutated")
	}
}

// TestActivityDeltaAndReasoningEncryptedValue confirm the new emitter wrappers
// produce events with the correct type fields. We use a success writer (NopWriter)
// so we are testing serialization, not transport.
func TestActivityDeltaAndReasoningEncryptedValue(t *testing.T) {
	sw := sse.NewSSEWriter()
	w := bufio.NewWriter(&nopWriter{})
	em := NewEmitter(context.Background(), w, sw, "t1", "r1", nil)

	// ActivityDelta — verify it does not error (validates correctly).
	patch := []events.JSONPatchOperation{{Op: "replace", Path: "/content", Value: "updated"}}
	em.ActivityDelta("msg-1", "tool_use", patch)
	if em.EncErr() != nil {
		t.Errorf("ActivityDelta encoding error: %v", em.EncErr())
	}

	// ReasoningEncryptedValue — verify typed subtype constant is accepted.
	em.ReasoningEncryptedValue(events.ReasoningEncryptedValueSubtypeMessage, "msg-2", "cipher-blob")
	if em.EncErr() != nil {
		t.Errorf("ReasoningEncryptedValue encoding error: %v", em.EncErr())
	}
}

// nopWriter discards all bytes (stands in for a connected SSE client).
type nopWriter struct{}

func (*nopWriter) Write(p []byte) (int, error) { return len(p), nil }

// TestIsTransportErrorMatchesSDKWrappers pins the SDK's write/flush error wrapper
// strings that isTransportError matches. Disconnect detection (and the run
// cancellation it drives) depends on those exact substrings; if a future SDK bump
// rewords them, this fails loudly instead of silently reclassifying a client
// disconnect as an encoding error — which would leave a gone-client run generating
// (and billing) tokens until it finishes on its own.
func TestIsTransportErrorMatchesSDKWrappers(t *testing.T) {
	sw := sse.NewSSEWriter()
	w := bufio.NewWriter(failWriter{})

	// A valid event encodes fine; the failure happens at the socket write/flush.
	err := sw.WriteEvent(context.Background(), w, events.NewRunStartedEvent("t", "r"))
	if err == nil {
		t.Fatal("expected a write/flush error from the failing writer")
	}
	if !isTransportError(err) {
		t.Fatalf("isTransportError must classify an SDK write/flush failure as a transport error; "+
			"the SDK wrapper strings may have changed: %v", err)
	}
}

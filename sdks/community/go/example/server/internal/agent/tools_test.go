package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestToolsetReadOnly is the guard for the core safety property of this server:
// the agent may read files but must never have a tool that mutates the
// filesystem. If someone registers a write/edit/shell tool, this fails.
func TestToolsetReadOnly(t *testing.T) {
	ts, err := NewReadOnlyToolset(t.TempDir())
	if err != nil {
		t.Fatalf("NewReadOnlyToolset: %v", err)
	}

	infos := ts.Infos()
	if len(infos) != 1 {
		t.Fatalf("expected exactly 1 tool, got %d", len(infos))
	}
	if infos[0].Name != "file_read" {
		t.Fatalf("expected only %q, got %q", "file_read", infos[0].Name)
	}

	// Any non-read tool must be rejected by the dispatcher.
	for _, name := range []string{"file_write", "file_edit", "shell", "tracker_write"} {
		if _, err := ts.Run(context.Background(), name, `{}`); err == nil {
			t.Fatalf("tool %q should not be runnable on a read-only agent", name)
		} else if !strings.Contains(err.Error(), "only allows file_read") {
			t.Fatalf("unexpected error for %q: %v", name, err)
		}
	}
}

func TestFileReadToolReadsOnlyInsideWorkspace(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "note.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	ts, err := NewReadOnlyToolset(root)
	if err != nil {
		t.Fatalf("NewReadOnlyToolset: %v", err)
	}
	out, err := ts.Run(context.Background(), "file_read", `{"path":"note.txt"}`)
	if err != nil {
		t.Fatalf("file_read: %v", err)
	}
	if out != "hello" {
		t.Fatalf("file_read output = %q, want hello", out)
	}
	if _, err := ts.Run(context.Background(), "file_read", `{"path":"../outside.txt"}`); err == nil {
		t.Fatal("expected path traversal to be rejected")
	}
}

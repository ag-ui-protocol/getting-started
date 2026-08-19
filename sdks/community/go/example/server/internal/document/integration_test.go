//go:build integration

package document

// Run with: go test -tags integration -run TestAnalyzeIntegration ./internal/document/
// Requires OPENAI_API_KEY in the environment.
//
// Test fixture: testdata/test_document.pdf
// A minimal hand-built PDF (588 bytes, PDF 1.4) containing the sentence:
// "This is a test document. The answer is forty-two."
// Generated for this project; no third-party copyright.

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"
)

func TestAnalyzeIntegration(t *testing.T) {
	if os.Getenv("OPENAI_API_KEY") == "" {
		t.Skip("OPENAI_API_KEY not set")
	}

	raw, err := os.ReadFile("testdata/test_document.pdf")
	if err != nil {
		t.Fatalf("reading testdata/test_document.pdf: %v", err)
	}

	result, err := Analyze(context.Background(), AnalyzeRequest{
		PDFBase64: base64.StdEncoding.EncodeToString(raw),
		MimeType:  "application/pdf",
		Prompt:    "What is the answer mentioned in this document? Reply in one sentence.",
	})
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if result.Text == "" {
		t.Fatal("expected non-empty response")
	}
	t.Logf("response: %q", result.Text)

	// The PDF contains "forty-two" — the model should mention it
	lower := strings.ToLower(result.Text)
	if !strings.Contains(lower, "forty-two") && !strings.Contains(lower, "42") {
		t.Errorf("expected response to reference forty-two/42, got %q", result.Text)
	}
}

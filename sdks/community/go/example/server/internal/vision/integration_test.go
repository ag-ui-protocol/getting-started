//go:build integration

package vision

// Run with: go test -tags integration -run TestAnalyzeIntegration ./internal/vision/
// Requires OPENAI_API_KEY in the environment.

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"
)

func TestAnalyzeIntegration(t *testing.T) {
	if os.Getenv("OPENAI_API_KEY") == "" {
		t.Skip("OPENAI_API_KEY not set")
	}

	result, err := Analyze(context.Background(), AnalyzeRequest{
		ImageBase64: redPNG(t),
		MimeType:    "image/png",
		Prompt:      "What color is this image? Reply with exactly one word.",
	})
	if err != nil {
		t.Fatalf("Analyze: %v", err)
	}
	if result.Text == "" {
		t.Fatal("expected non-empty response")
	}
	t.Logf("response: %q", result.Text)

	if !strings.Contains(strings.ToLower(result.Text), "red") {
		t.Errorf("expected response to mention red, got %q", result.Text)
	}
}

// redPNG returns a base64-encoded 10x10 red PNG.
func redPNG(t *testing.T) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	red := color.RGBA{R: 255, G: 0, B: 0, A: 255}
	for y := range 10 {
		for x := range 10 {
			img.Set(x, y, red)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode test PNG: %v", err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

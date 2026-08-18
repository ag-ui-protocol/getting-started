package vision

import (
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

func makeUserMsg(parts []aguitypes.InputContent) aguitypes.Message {
	return aguitypes.Message{Role: aguitypes.RoleUser, Content: parts}
}

func imagePart(b64, mime string) aguitypes.InputContent {
	return aguitypes.InputContent{
		Type: aguitypes.InputContentTypeImage,
		Source: &aguitypes.InputContentSource{
			Type:     aguitypes.InputContentSourceTypeData,
			Value:    b64,
			MimeType: mime,
		},
	}
}

func textPart(text string) aguitypes.InputContent {
	return aguitypes.InputContent{Type: aguitypes.InputContentTypeText, Text: text}
}

func TestExtractImagePart(t *testing.T) {
	tests := []struct {
		name       string
		messages   []aguitypes.Message
		wantB64    string
		wantMime   string
		wantPrompt string
		wantOK     bool
	}{
		{
			name:   "no messages",
			wantOK: false,
		},
		{
			name: "text-only message",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{textPart("hello")}),
			},
			wantOK: false,
		},
		{
			name: "image part found",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{
					imagePart("abc123", "image/png"),
					textPart("What is this?"),
				}),
			},
			wantB64:    "abc123",
			wantMime:   "image/png",
			wantPrompt: "What is this?",
			wantOK:     true,
		},
		{
			name: "image with empty mimeType defaults to image/png",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{
					imagePart("xyz", ""),
				}),
			},
			wantB64:  "xyz",
			wantMime: "image/png",
			wantOK:   true,
		},
		{
			name: "uses last user message",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{imagePart("first", "image/jpeg")}),
				makeUserMsg([]aguitypes.InputContent{imagePart("second", "image/png")}),
			},
			wantB64:  "second",
			wantMime: "image/png",
			wantOK:   true,
		},
		{
			name: "URL-source image is skipped",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{
					{
						Type: aguitypes.InputContentTypeImage,
						Source: &aguitypes.InputContentSource{
							Type:  aguitypes.InputContentSourceTypeURL,
							Value: "https://example.com/img.png",
						},
					},
				}),
			},
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b64, mime, prompt, ok := extractImagePart(tc.messages)
			if ok != tc.wantOK {
				t.Fatalf("ok=%v want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if b64 != tc.wantB64 {
				t.Errorf("base64=%q want %q", b64, tc.wantB64)
			}
			if mime != tc.wantMime {
				t.Errorf("mimeType=%q want %q", mime, tc.wantMime)
			}
			if prompt != tc.wantPrompt {
				t.Errorf("prompt=%q want %q", prompt, tc.wantPrompt)
			}
		})
	}
}

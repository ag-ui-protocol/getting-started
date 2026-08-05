package document

import (
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

func makeUserMsg(parts []aguitypes.InputContent) aguitypes.Message {
	return aguitypes.Message{Role: aguitypes.RoleUser, Content: parts}
}

func docPart(b64, mime string) aguitypes.InputContent {
	return aguitypes.InputContent{
		Type: aguitypes.InputContentTypeDocument,
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

func TestExtractDocumentPart(t *testing.T) {
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
			name: "document part found with question",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{
					docPart("JVBERi0xLjQK", "application/pdf"),
					textPart("What is this about?"),
				}),
			},
			wantB64:    "JVBERi0xLjQK",
			wantMime:   "application/pdf",
			wantPrompt: "What is this about?",
			wantOK:     true,
		},
		{
			name: "empty mimeType defaults to application/pdf",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{
					docPart("abc123", ""),
				}),
			},
			wantB64:  "abc123",
			wantMime: "application/pdf",
			wantOK:   true,
		},
		{
			name: "uses last user message",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{docPart("first", "application/pdf")}),
				makeUserMsg([]aguitypes.InputContent{docPart("second", "application/pdf")}),
			},
			wantB64:  "second",
			wantMime: "application/pdf",
			wantOK:   true,
		},
		{
			name: "URL-source document is skipped",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{
					{
						Type: aguitypes.InputContentTypeDocument,
						Source: &aguitypes.InputContentSource{
							Type:  aguitypes.InputContentSourceTypeURL,
							Value: "https://example.com/doc.pdf",
						},
					},
				}),
			},
			wantOK: false,
		},
		{
			name: "non-user message is skipped",
			messages: []aguitypes.Message{
				{
					Role:    aguitypes.RoleAssistant,
					Content: []aguitypes.InputContent{docPart("abc", "application/pdf")},
				},
			},
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b64, mime, prompt, ok := extractDocumentPart(tc.messages)
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

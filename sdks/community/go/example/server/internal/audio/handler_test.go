package audio

import (
	"testing"

	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
)

func TestMimeToExt(t *testing.T) {
	tests := []struct {
		mime string
		want string
	}{
		{"audio/wav", ".wav"},
		{"audio/x-wav", ".wav"},
		{"audio/mpeg", ".mp3"},
		{"audio/mp4", ".m4a"},
		{"audio/ogg", ".ogg"},
		{"audio/webm", ".webm"},
		{"AUDIO/WAV", ".wav"},
		{"audio/flac", ".wav"}, // unknown → fallback
		{"", ".wav"},           // empty → fallback
	}
	for _, tc := range tests {
		got := mimeToExt(tc.mime)
		if got != tc.want {
			t.Errorf("mimeToExt(%q)=%q want %q", tc.mime, got, tc.want)
		}
	}
}

func makeUserMsg(parts []aguitypes.InputContent) aguitypes.Message {
	return aguitypes.Message{Role: aguitypes.RoleUser, Content: parts}
}

func TestExtractAudioPart(t *testing.T) {
	audioPart := func(b64, mime string) aguitypes.InputContent {
		return aguitypes.InputContent{
			Type: aguitypes.InputContentTypeAudio,
			Source: &aguitypes.InputContentSource{
				Type:     aguitypes.InputContentSourceTypeData,
				Value:    b64,
				MimeType: mime,
			},
		}
	}
	textPart := func(t string) aguitypes.InputContent {
		return aguitypes.InputContent{Type: aguitypes.InputContentTypeText, Text: t}
	}

	tests := []struct {
		name     string
		messages []aguitypes.Message
		wantB64  string
		wantMime string
		wantOK   bool
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
			name: "audio part found",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{
					audioPart("wavdata==", "audio/wav"),
				}),
			},
			wantB64:  "wavdata==",
			wantMime: "audio/wav",
			wantOK:   true,
		},
		{
			name: "uses last user message",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{audioPart("first", "audio/mp3")}),
				makeUserMsg([]aguitypes.InputContent{audioPart("second", "audio/wav")}),
			},
			wantB64:  "second",
			wantMime: "audio/wav",
			wantOK:   true,
		},
		{
			name: "URL-source audio is skipped",
			messages: []aguitypes.Message{
				makeUserMsg([]aguitypes.InputContent{
					{
						Type: aguitypes.InputContentTypeAudio,
						Source: &aguitypes.InputContentSource{
							Type:  aguitypes.InputContentSourceTypeURL,
							Value: "https://example.com/clip.wav",
						},
					},
				}),
			},
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b64, mime, ok := extractAudioPart(tc.messages)
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
		})
	}
}

package audio

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"strings"
	"time"
)

const defaultModel = "whisper-1"

type TranscribeRequest struct {
	AudioBase64 string // bare base64, no data-URL prefix
	MimeType    string // e.g. "audio/wav"
	Model       string // overrides env default
}

type TranscribeResult struct {
	Text string
}

func Transcribe(ctx context.Context, req TranscribeRequest) (*TranscribeResult, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY is not set")
	}
	model := req.Model
	if model == "" {
		model = os.Getenv("AUDIO_MODEL")
	}
	if model == "" {
		model = defaultModel
	}

	audioBytes, err := base64.StdEncoding.DecodeString(req.AudioBase64)
	if err != nil {
		return nil, fmt.Errorf("base64 decode failed: %w", err)
	}

	ext := mimeToExt(req.MimeType)
	filename := "audio" + ext
	contentType := req.MimeType
	if contentType == "" {
		contentType = "audio/wav"
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	if err := mw.WriteField("model", model); err != nil {
		return nil, fmt.Errorf("building multipart body: %w", err)
	}

	// "file" part — Content-Disposition must include a filename; Whisper infers format from it.
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	h.Set("Content-Type", contentType)
	pw, err := mw.CreatePart(h)
	if err != nil {
		return nil, fmt.Errorf("creating file part: %w", err)
	}
	if _, err := io.Copy(pw, bytes.NewReader(audioBytes)); err != nil {
		return nil, fmt.Errorf("writing audio bytes: %w", err)
	}
	mw.Close()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.openai.com/v1/audio/transcriptions",
		&buf)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", mw.FormDataContentType())
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("Whisper request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		var errPayload struct {
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&errPayload)
		if errPayload.Error != nil {
			return nil, fmt.Errorf("Whisper error (HTTP %d): %s", resp.StatusCode, errPayload.Error.Message)
		}
		return nil, fmt.Errorf("Whisper request failed with HTTP %d", resp.StatusCode)
	}

	var payload struct {
		Text  string `json:"text"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decoding Whisper response: %w", err)
	}
	if payload.Error != nil {
		return nil, fmt.Errorf("Whisper error: %s", payload.Error.Message)
	}
	if payload.Text == "" {
		return nil, fmt.Errorf("Whisper returned an empty transcription")
	}

	return &TranscribeResult{Text: payload.Text}, nil
}

// mimeToExt maps an audio MIME type to a file extension Whisper will accept.
// Whisper infers audio format partly from the filename, so a correct extension matters.
func mimeToExt(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "audio/wav", "audio/x-wav":
		return ".wav"
	case "audio/mpeg":
		return ".mp3"
	case "audio/mp4":
		return ".m4a"
	case "audio/ogg":
		return ".ogg"
	case "audio/webm":
		return ".webm"
	default:
		return ".wav"
	}
}

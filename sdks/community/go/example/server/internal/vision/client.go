package vision

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

const defaultModel = "gpt-4o"
const defaultSystemPrompt = "You are an expert image analyst. Describe the image clearly and answer any questions about it."

type AnalyzeRequest struct {
	ImageBase64 string // bare base64, no data-URL prefix
	MimeType    string // e.g. "image/png"
	Prompt      string // user's text question (may be empty)
	Model       string // overrides env default
}

type AnalyzeResult struct {
	Text string
}

func Analyze(ctx context.Context, req AnalyzeRequest) (*AnalyzeResult, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY is not set")
	}
	model := req.Model
	if model == "" {
		model = os.Getenv("VISION_MODEL")
	}
	if model == "" {
		model = defaultModel
	}
	prompt := req.Prompt
	if prompt == "" {
		prompt = "Describe this image in detail."
	}
	mimeType := req.MimeType
	if mimeType == "" {
		mimeType = "image/png"
	}

	// gpt-4o expects {"type":"image_url","image_url":{"url":"data:<mime>;base64,<b64>"}}
	dataURL := "data:" + mimeType + ";base64," + req.ImageBase64

	userContent := []map[string]any{
		{
			"type":      "image_url",
			"image_url": map[string]string{"url": dataURL},
		},
		{
			"type": "text",
			"text": prompt,
		},
	}

	body, err := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]any{
			{"role": "system", "content": defaultSystemPrompt},
			{"role": "user", "content": userContent},
		},
	})
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.openai.com/v1/chat/completions",
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("OpenAI request failed: %w", err)
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
			return nil, fmt.Errorf("OpenAI error (HTTP %d): %s", resp.StatusCode, errPayload.Error.Message)
		}
		return nil, fmt.Errorf("OpenAI request failed with HTTP %d", resp.StatusCode)
	}

	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decoding OpenAI response: %w", err)
	}
	if payload.Error != nil {
		return nil, fmt.Errorf("OpenAI error: %s", payload.Error.Message)
	}
	if len(payload.Choices) == 0 || payload.Choices[0].Message.Content == "" {
		return nil, fmt.Errorf("OpenAI returned no content")
	}

	return &AnalyzeResult{Text: payload.Choices[0].Message.Content}, nil
}

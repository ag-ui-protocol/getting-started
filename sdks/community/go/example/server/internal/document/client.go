package document

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
const defaultSystemPrompt = "You are a helpful document analyst. Answer questions about the provided document clearly and concisely."

type AnalyzeRequest struct {
	PDFBase64 string // bare base64, no data-URL prefix
	MimeType  string // e.g. "application/pdf"
	Prompt    string // user's text question (may be empty)
	Model     string // overrides env default
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
		model = os.Getenv("DOCUMENT_MODEL")
	}
	if model == "" {
		model = defaultModel
	}
	prompt := req.Prompt
	if prompt == "" {
		prompt = "Summarize this document."
	}
	mimeType := req.MimeType
	if mimeType == "" {
		mimeType = "application/pdf"
	}

	// The Responses API expects a data-URL prefix on the inline file bytes.
	fileData := "data:" + mimeType + ";base64," + req.PDFBase64

	body, err := json.Marshal(map[string]any{
		"model": model,
		"input": []map[string]any{
			{
				"role": "system",
				"content": []map[string]any{
					{"type": "input_text", "text": defaultSystemPrompt},
				},
			},
			{
				"role": "user",
				"content": []map[string]any{
					{
						"type":      "input_file",
						"filename":  "document.pdf",
						"file_data": fileData,
					},
					{
						"type": "input_text",
						"text": prompt,
					},
				},
			},
		},
	})
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.openai.com/v1/responses",
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("Responses API request failed: %w", err)
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
			return nil, fmt.Errorf("Responses API error (HTTP %d): %s", resp.StatusCode, errPayload.Error.Message)
		}
		return nil, fmt.Errorf("Responses API request failed with HTTP %d", resp.StatusCode)
	}

	// Responses API output: output[].content[].text where type == "output_text"
	var payload struct {
		Output []struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decoding Responses API response: %w", err)
	}
	if payload.Error != nil {
		return nil, fmt.Errorf("Responses API error: %s", payload.Error.Message)
	}

	for _, item := range payload.Output {
		for _, block := range item.Content {
			if block.Type == "output_text" && block.Text != "" {
				return &AnalyzeResult{Text: block.Text}, nil
			}
		}
	}

	return nil, fmt.Errorf("Responses API returned no text output")
}

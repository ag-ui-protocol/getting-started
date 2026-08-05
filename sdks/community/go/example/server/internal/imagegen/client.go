package imagegen

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

const defaultModel = "gpt-image-1"
const defaultSize = "1024x1024"

type GenerateRequest struct {
	Prompt string
	Model  string // defaults to defaultModel
	Size   string // defaults to defaultSize
}

type GenerateResult struct {
	B64JSON string // raw base64 PNG (no data-URL prefix)
	Prompt  string
}

func Generate(ctx context.Context, req GenerateRequest) (*GenerateResult, error) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY is not set")
	}
	model := req.Model
	if model == "" {
		model = os.Getenv("IMAGE_MODEL")
	}
	if model == "" {
		model = defaultModel
	}
	size := req.Size
	if size == "" {
		size = os.Getenv("IMAGE_SIZE")
	}
	if size == "" {
		size = defaultSize
	}

	// gpt-image-1 returns base64 by default; response_format is for dall-e-2/3 only
	// and may be rejected with a 400. Omitted here; the decode logic reads b64_json
	// which gpt-image-1 always populates.
	body, err := json.Marshal(map[string]any{
		"model":  model,
		"prompt": req.Prompt,
		"n":      1,
		"size":   size,
	})
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.openai.com/v1/images/generations",
		bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("OpenAI request failed: %w", err)
	}
	defer resp.Body.Close()

	// Check HTTP status before decoding — a non-JSON body (gateway HTML, etc.)
	// on a 429/500 would otherwise produce an opaque "decoding" error.
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
		Data []struct {
			B64JSON string `json:"b64_json"`
		} `json:"data"`
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
	if len(payload.Data) == 0 || payload.Data[0].B64JSON == "" {
		return nil, fmt.Errorf("OpenAI returned no image data")
	}

	return &GenerateResult{
		B64JSON: payload.Data[0].B64JSON,
		Prompt:  req.Prompt,
	}, nil
}

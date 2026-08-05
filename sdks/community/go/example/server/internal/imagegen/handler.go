package imagegen

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/gofiber/fiber/v3"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/agent"
)

// Handler returns a Fiber handler for POST /image-gen.
// shutdownCtx must be the server-level signal context so that SIGTERM cancels
// in-flight image generation requests (same pattern as agenticHandler).
func Handler(shutdownCtx context.Context, logger *slog.Logger) fiber.Handler {
	sw := sse.NewSSEWriter().WithLogger(logger)
	return func(c fiber.Ctx) error {
		var in aguitypes.RunAgentInput
		if err := json.Unmarshal(c.Body(), &in); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		threadID := in.ThreadID
		if threadID == "" {
			threadID = aguievents.GenerateThreadID()
		}
		runID := in.RunID
		if runID == "" {
			runID = aguievents.GenerateRunID()
		}

		prompt := extractUserPrompt(in.Messages)
		if prompt == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "no user prompt provided"})
		}

		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")

		return c.SendStreamWriter(func(w *bufio.Writer) {
			// Parent on shutdownCtx, not c.Context(): the stream-writer runs after
			// the handler returns (RequestCtx is recycled by fasthttp at that point).
			runCtx, cancel := context.WithCancel(shutdownCtx)
			defer cancel()
			emit := agent.NewEmitter(runCtx, w, sw, threadID, runID, cancel)

			// Turn panics into RUN_ERROR rather than truncating the stream silently.
			defer func() {
				if r := recover(); r != nil {
					logger.Error("image-gen panicked", "thread", threadID, "run", runID, "panic", r)
					emit.RunError("the image-gen handler crashed")
				}
			}()

			emit.RunStarted()
			emit.StateSnapshot(map[string]any{
				"status": "generating",
				"prompt": prompt,
			})

			result, err := Generate(runCtx, GenerateRequest{Prompt: prompt})
			if err != nil {
				logger.Error("image generation failed", "error", err)
				emit.RunError("image generation failed: " + err.Error())
				return
			}

			dataURL := "data:image/png;base64," + result.B64JSON
			emit.Custom("image_generated", map[string]any{
				"prompt": prompt,
				"url":    dataURL,
			})
			emit.StateDelta([]aguievents.JSONPatchOperation{
				{Op: "replace", Path: "/status", Value: "done"},
			})
			emit.MessagesSnapshot([]aguitypes.Message{})
			emit.RunFinishedSuccess()
		})
	}
}

// extractUserPrompt returns the text of the last user message, or "".
// Handles both plain string content and multimodal messages (joins text parts).
func extractUserPrompt(messages []aguitypes.Message) string {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != aguitypes.RoleUser {
			continue
		}
		if s, ok := m.ContentString(); ok {
			if s = strings.TrimSpace(s); s != "" {
				return s
			}
		}
		if parts, ok := m.ContentInputContents(); ok {
			var b strings.Builder
			for _, p := range parts {
				if p.Type == aguitypes.InputContentTypeText && p.Text != "" {
					if b.Len() > 0 {
						b.WriteByte('\n')
					}
					b.WriteString(p.Text)
				}
			}
			if s := strings.TrimSpace(b.String()); s != "" {
				return s
			}
		}
	}
	return ""
}

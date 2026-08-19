package audio

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/encoding/sse"
	"github.com/gofiber/fiber/v3"

	"github.com/ag-ui-protocol/ag-ui/sdks/community/go/example/server/internal/agent"
)

// Handler returns a Fiber handler for POST /audio.
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

		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")

		return c.SendStreamWriter(func(w *bufio.Writer) {
			runCtx, cancel := context.WithCancel(shutdownCtx)
			defer cancel()
			emit := agent.NewEmitter(runCtx, w, sw, threadID, runID, cancel)

			defer func() {
				if r := recover(); r != nil {
					logger.Error("audio handler panicked", "thread", threadID, "run", runID, "panic", r)
					emit.RunError("the audio handler crashed")
				}
			}()

			emit.RunStarted()

			audioBase64, mimeType, ok := extractAudioPart(in.Messages)
			if !ok {
				emit.RunError("audio: no audio part found in the last user message")
				return
			}

			result, err := Transcribe(runCtx, TranscribeRequest{
				AudioBase64: audioBase64,
				MimeType:    mimeType,
			})
			if err != nil {
				logger.Error("audio transcription failed", "error", err)
				emit.RunError("audio transcription failed: " + err.Error())
				return
			}

			msgID := aguievents.GenerateMessageID()
			emit.TextStart(msgID)
			emit.TextContent(msgID, result.Text)
			emit.TextEnd(msgID)
			emit.MessagesSnapshot([]aguitypes.Message{})
			emit.RunFinishedSuccess()
		})
	}
}

// extractAudioPart scans the last user message for an audio InputContent with a
// DataSource. Returns ok=false if no audio part is found or source is not inline
// base64 (URL-source is not supported).
func extractAudioPart(messages []aguitypes.Message) (base64Data, mimeType string, ok bool) {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != aguitypes.RoleUser {
			continue
		}
		parts, hasParts := m.ContentInputContents()
		if !hasParts {
			continue
		}
		for _, p := range parts {
			if p.Type == aguitypes.InputContentTypeAudio &&
				p.Source != nil &&
				p.Source.Type == aguitypes.InputContentSourceTypeData &&
				p.Source.Value != "" {
				return p.Source.Value, p.Source.MimeType, true
			}
		}
	}
	return "", "", false
}

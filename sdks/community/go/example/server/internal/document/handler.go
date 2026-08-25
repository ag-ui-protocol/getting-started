package document

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

// Handler returns a Fiber handler for POST /document.
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
					logger.Error("document handler panicked", "thread", threadID, "run", runID, "panic", r)
					emit.RunError("the document handler crashed")
				}
			}()

			emit.RunStarted()

			pdfBase64, mimeType, prompt, ok := extractDocumentPart(in.Messages)
			if !ok {
				emit.RunError("document: no document part found in the last user message")
				return
			}

			result, err := Analyze(runCtx, AnalyzeRequest{
				PDFBase64: pdfBase64,
				MimeType:  mimeType,
				Prompt:    prompt,
			})
			if err != nil {
				logger.Error("document analysis failed", "error", err)
				emit.RunError("document analysis failed: " + err.Error())
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

// extractDocumentPart scans the last user message for a document InputContent with a
// DataSource. Also collects any text parts as the prompt. Returns ok=false if no
// document part is found or source is not inline base64 (URL-source is not supported).
func extractDocumentPart(messages []aguitypes.Message) (base64Data, mimeType, prompt string, ok bool) {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role != aguitypes.RoleUser {
			continue
		}
		parts, hasParts := m.ContentInputContents()
		if !hasParts {
			continue
		}
		var textBuf strings.Builder
		for _, p := range parts {
			switch p.Type {
			case aguitypes.InputContentTypeDocument:
				if p.Source != nil && p.Source.Type == aguitypes.InputContentSourceTypeData && p.Source.Value != "" {
					base64Data = p.Source.Value
					mimeType = p.Source.MimeType
					if mimeType == "" {
						mimeType = "application/pdf"
					}
					ok = true
				}
			case aguitypes.InputContentTypeText:
				if p.Text != "" {
					if textBuf.Len() > 0 {
						textBuf.WriteByte('\n')
					}
					textBuf.WriteString(p.Text)
				}
			}
		}
		prompt = textBuf.String()
		return
	}
	return
}

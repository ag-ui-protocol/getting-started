package agent

import (
	"log/slog"
	"strings"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	aguitypes "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/types"
	"github.com/cloudwego/eino/schema"
)

// supportsVision reports whether the named provider forwards multimodal
// (image) content to the model. The OpenAI path honours UserInputMultiContent.
func supportsVision(provider string) bool {
	return provider == "openai"
}

// toEinoMessages maps the AG-UI request message history into eino messages.
// Roles eino has no use for here (reasoning/activity) are skipped.
// provider is used to gate multimodal forwarding: only the "openai" backend
// handles UserInputMultiContent; for others, non-text parts are dropped and
// only text fragments are forwarded.
func toEinoMessages(in []aguitypes.Message, provider string) []*schema.Message {
	vision := supportsVision(provider)
	out := make([]*schema.Message, 0, len(in))
	for _, m := range in {
		switch m.Role {
		case aguitypes.RoleUser:
			if vision {
				if msg := toEinoUserMessage(m); msg != nil {
					out = append(out, msg)
				}
			} else if text := messageText(m); text != "" {
				out = append(out, schema.UserMessage(text))
			}
		case aguitypes.RoleSystem, aguitypes.RoleDeveloper:
			if text := messageText(m); text != "" {
				out = append(out, schema.SystemMessage(text))
			}
		case aguitypes.RoleAssistant:
			content, _ := m.ContentString()
			out = append(out, &schema.Message{
				Role:      schema.Assistant,
				Content:   content,
				ToolCalls: toEinoToolCalls(m.ToolCalls),
			})
		case aguitypes.RoleTool:
			content, _ := m.ContentString()
			out = append(out, schema.ToolMessage(content, m.ToolCallID))
		}
	}
	return out
}

// messageText returns the message's text. ContentString applies to plain string
// content; for multimodal/structured content ([]InputContent) it returns ok=false,
// in which case we join the text fragments. Non-text fragments (image/audio/binary)
// are dropped — this agent has no vision/audio path — but the user's typed text is
// preserved instead of the whole turn being silently discarded. An empty result
// means the turn has no usable text; the caller skips it rather than inject a blank
// turn that would erase the user's actual input.
func messageText(m aguitypes.Message) string {
	if s, ok := m.ContentString(); ok {
		return s
	}
	parts, ok := m.ContentInputContents()
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if p.Type == aguitypes.InputContentTypeText && p.Text != "" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// toEinoUserMessage converts a user message to an eino message, preserving
// image parts for vision-capable providers. Non-image, non-text parts
// (audio, video, document, binary) are logged and dropped. Returns nil when
// there is no usable content after filtering.
func toEinoUserMessage(m aguitypes.Message) *schema.Message {
	parts, hasParts := m.ContentInputContents()
	if !hasParts {
		text, _ := m.ContentString()
		if text == "" {
			return nil
		}
		return schema.UserMessage(text)
	}

	var textBuf strings.Builder
	var multiParts []schema.MessageInputPart
	hasNonText := false

	for _, p := range parts {
		switch p.Type {
		case aguitypes.InputContentTypeText:
			if p.Text != "" {
				if textBuf.Len() > 0 {
					textBuf.WriteByte('\n')
				}
				textBuf.WriteString(p.Text)
				multiParts = append(multiParts, schema.MessageInputPart{
					Type: schema.ChatMessagePartTypeText,
					Text: p.Text,
				})
			}
		case aguitypes.InputContentTypeImage:
			if part, ok := toEinoImagePart(p); ok {
				multiParts = append(multiParts, part)
				hasNonText = true
			}
		default:
			slog.Warn("unsupported multimodal content type, dropping", "type", p.Type)
		}
	}

	if len(multiParts) == 0 {
		return nil
	}
	if !hasNonText {
		// All parts were text — use plain Content for cleanliness.
		return schema.UserMessage(textBuf.String())
	}
	return &schema.Message{
		Role:                  schema.User,
		UserInputMultiContent: multiParts,
	}
}

// toEinoImagePart maps an AG-UI InputContent image fragment to an eino
// MessageInputPart. It reads Source first (the structured path from
// UserMessage.multimodal()), then falls back to the flat URL/Data fields.
func toEinoImagePart(p aguitypes.InputContent) (schema.MessageInputPart, bool) {
	img := &schema.MessageInputImage{}
	if p.Source != nil {
		switch p.Source.Type {
		case aguitypes.InputContentSourceTypeURL:
			img.URL = &p.Source.Value
		case aguitypes.InputContentSourceTypeData:
			img.Base64Data = &p.Source.Value
			img.MIMEType = p.Source.MimeType
		default:
			slog.Warn("unknown image source type, dropping", "source_type", p.Source.Type)
			return schema.MessageInputPart{}, false
		}
	} else if p.URL != "" {
		img.URL = &p.URL
	} else if p.Data != "" {
		img.Base64Data = &p.Data
		img.MIMEType = p.MimeType
	} else {
		slog.Warn("image part has no source URL or data, dropping")
		return schema.MessageInputPart{}, false
	}
	return schema.MessageInputPart{
		Type:  schema.ChatMessagePartTypeImageURL,
		Image: img,
	}, true
}

func toEinoToolCalls(tcs []aguitypes.ToolCall) []schema.ToolCall {
	if len(tcs) == 0 {
		return nil
	}
	out := make([]schema.ToolCall, 0, len(tcs))
	for _, tc := range tcs {
		out = append(out, schema.ToolCall{
			ID:       tc.ID,
			Type:     "function",
			Function: schema.FunctionCall{Name: tc.Function.Name, Arguments: tc.Function.Arguments},
		})
	}
	return out
}

// toAGUIMessages converts the eino conversation into AG-UI messages for a
// MESSAGES_SNAPSHOT event, assigning fresh ids and conforming to the SDK's
// per-role validation rules.
func toAGUIMessages(msgs []*schema.Message) []aguitypes.Message {
	out := make([]aguitypes.Message, 0, len(msgs))
	for _, m := range msgs {
		am := aguitypes.Message{ID: aguievents.GenerateMessageID(), Content: m.Content}
		switch m.Role {
		case schema.System:
			am.Role = aguitypes.RoleSystem
		case schema.User:
			am.Role = aguitypes.RoleUser
		case schema.Assistant:
			am.Role = aguitypes.RoleAssistant
			am.ToolCalls = toAGUIToolCalls(m.ToolCalls)
		case schema.Tool:
			am.Role = aguitypes.RoleTool
			am.ToolCallID = m.ToolCallID
		default:
			continue
		}
		out = append(out, am)
	}
	return out
}

func toAGUIToolCalls(tcs []schema.ToolCall) []aguitypes.ToolCall {
	if len(tcs) == 0 {
		return nil
	}
	out := make([]aguitypes.ToolCall, 0, len(tcs))
	for _, tc := range tcs {
		out = append(out, aguitypes.ToolCall{
			ID:       tc.ID,
			Type:     aguitypes.ToolCallTypeFunction,
			Function: aguitypes.FunctionCall{Name: tc.Function.Name, Arguments: tc.Function.Arguments},
		})
	}
	return out
}

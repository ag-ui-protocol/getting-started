package predictivestateupdates

import (
	"context"
	"encoding/json"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	agentevent "trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	"trpc.group/trpc-go/trpc-agent-go/server/agui/translator"
)

type predictiveStateUpdatesTranslator struct {
	inner      translator.Translator
	toolCallID string
	arguments  string
}

func newPredictiveStateUpdatesTranslator(
	ctx context.Context,
	input *adapter.RunAgentInput,
	opts ...translator.Option,
) (translator.Translator, error) {
	inner, err := translator.New(ctx, input.ThreadID, input.RunID, opts...)
	if err != nil {
		return nil, err
	}
	return &predictiveStateUpdatesTranslator{inner: inner}, nil
}

func (t *predictiveStateUpdatesTranslator) Translate(
	ctx context.Context,
	event *agentevent.Event,
) ([]aguievents.Event, error) {
	events, err := t.inner.Translate(ctx, event)
	if err != nil {
		return nil, err
	}
	translated := make([]aguievents.Event, 0, len(events)+2)
	for _, translatedEvent := range events {
		switch item := translatedEvent.(type) {
		case *aguievents.ToolCallStartEvent:
			if item.ToolCallName == writeDocumentToolName {
				t.toolCallID = item.ToolCallID
				t.arguments = ""
				translated = append(translated, aguievents.NewCustomEvent(
					"PredictState",
					aguievents.WithValue([]map[string]string{{
						"state_key":     "document",
						"tool":          writeDocumentToolName,
						"tool_argument": "document",
					}}),
				))
			}
			translated = append(translated, item)
		case *aguievents.ToolCallArgsEvent:
			translated = append(translated, item)
			if item.ToolCallID != t.toolCallID {
				continue
			}
			t.arguments += item.Delta
		case *aguievents.ToolCallEndEvent:
			translated = append(translated, item)
			if item.ToolCallID != t.toolCallID {
				continue
			}
			var input struct {
				Document string `json:"document"`
			}
			if json.Unmarshal([]byte(t.arguments), &input) == nil {
				translated = append(translated, aguievents.NewStateDeltaEvent(
					[]aguievents.JSONPatchOperation{{
						Op: "add", Path: "/document", Value: input.Document,
					}},
				))
			}
			t.toolCallID = ""
			t.arguments = ""
		default:
			translated = append(translated, translatedEvent)
		}
	}
	return translated, nil
}

func (t *predictiveStateUpdatesTranslator) PostRunFinalizationEvents(
	ctx context.Context,
) ([]aguievents.Event, error) {
	finalizer, ok := t.inner.(translator.PostRunFinalizingTranslator)
	if !ok {
		return nil, nil
	}
	return finalizer.PostRunFinalizationEvents(ctx)
}

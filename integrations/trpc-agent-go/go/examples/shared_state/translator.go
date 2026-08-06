package sharedstate

import (
	"context"
	"encoding/json"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	agentevent "trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	"trpc.group/trpc-go/trpc-agent-go/server/agui/translator"
)

type sharedStateTranslator struct {
	inner      translator.Translator
	toolCallID string
	arguments  string
}

func newSharedStateTranslator(
	ctx context.Context,
	input *adapter.RunAgentInput,
	opts ...translator.Option,
) (translator.Translator, error) {
	inner, err := translator.New(ctx, input.ThreadID, input.RunID, opts...)
	if err != nil {
		return nil, err
	}
	return &sharedStateTranslator{inner: inner}, nil
}

func (t *sharedStateTranslator) Translate(
	ctx context.Context,
	event *agentevent.Event,
) ([]aguievents.Event, error) {
	events, err := t.inner.Translate(ctx, event)
	if err != nil {
		return nil, err
	}
	translated := make([]aguievents.Event, 0, len(events)+1)
	for _, translatedEvent := range events {
		translated = append(translated, translatedEvent)
		switch item := translatedEvent.(type) {
		case *aguievents.ToolCallStartEvent:
			if item.ToolCallName == generateRecipeToolName {
				t.toolCallID = item.ToolCallID
				t.arguments = ""
			}
		case *aguievents.ToolCallArgsEvent:
			if item.ToolCallID != t.toolCallID {
				continue
			}
			t.arguments += item.Delta
			snapshot, ok := recipeStateFromArguments(t.arguments)
			if !ok {
				continue
			}
			translated = append(translated, aguievents.NewStateSnapshotEvent(snapshot))
		}
	}
	return translated, nil
}

func recipeStateFromArguments(arguments string) (map[string]any, bool) {
	var input struct {
		Recipe map[string]any `json:"recipe"`
	}
	if json.Unmarshal([]byte(arguments), &input) != nil || input.Recipe == nil {
		return nil, false
	}
	return map[string]any{"recipe": input.Recipe}, true
}

func (t *sharedStateTranslator) PostRunFinalizationEvents(
	ctx context.Context,
) ([]aguievents.Event, error) {
	finalizer, ok := t.inner.(translator.PostRunFinalizingTranslator)
	if !ok {
		return nil, nil
	}
	return finalizer.PostRunFinalizationEvents(ctx)
}

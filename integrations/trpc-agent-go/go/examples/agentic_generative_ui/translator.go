package agenticgenerativeui

import (
	"context"
	"encoding/json"
	"fmt"

	aguievents "github.com/ag-ui-protocol/ag-ui/sdks/community/go/pkg/core/events"
	agentevent "trpc.group/trpc-go/trpc-agent-go/event"
	"trpc.group/trpc-go/trpc-agent-go/server/agui/adapter"
	"trpc.group/trpc-go/trpc-agent-go/server/agui/translator"
)

type agenticGenerativeUITranslator struct {
	inner               translator.Translator
	taskStepsToolCallID string
}

func newAgenticGenerativeUITranslator(
	ctx context.Context,
	input *adapter.RunAgentInput,
	opts ...translator.Option,
) (translator.Translator, error) {
	inner, err := translator.New(ctx, input.ThreadID, input.RunID, opts...)
	if err != nil {
		return nil, err
	}
	return &agenticGenerativeUITranslator{inner: inner}, nil
}

func (t *agenticGenerativeUITranslator) Translate(
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
			translated = append(translated, item)
			if item.ToolCallName == taskStepsToolName {
				t.taskStepsToolCallID = item.ToolCallID
				translated = append(translated, aguievents.NewStateSnapshotEvent(
					map[string]any{taskStepsStateKey: []taskStep{}},
				))
			}
		case *aguievents.ToolCallArgsEvent:
			translated = append(translated, item)
			if item.ToolCallID != t.taskStepsToolCallID {
				continue
			}
			steps := taskStepsFromArguments(item.Delta)
			if steps == nil {
				continue
			}
			translated = append(translated, aguievents.NewStateDeltaEvent(
				[]aguievents.JSONPatchOperation{{
					Op: "replace", Path: "/steps", Value: steps,
				}},
			))
		case *aguievents.ToolCallResultEvent:
			if item.ToolCallID != t.taskStepsToolCallID {
				translated = append(translated, item)
				continue
			}
			delta := taskStepCompletionDelta(item.Content)
			if delta == nil {
				translated = append(translated, item)
				continue
			}
			translated = append(translated, aguievents.NewStateDeltaEvent(delta))
		default:
			translated = append(translated, translatedEvent)
		}
	}
	return translated, nil
}

func taskStepsFromArguments(arguments string) []taskStep {
	var input taskStepsInput
	if json.Unmarshal([]byte(arguments), &input) != nil || len(input.Steps) == 0 {
		return nil
	}
	for index := range input.Steps {
		input.Steps[index].Status = "pending"
	}
	return input.Steps
}

func taskStepCompletionDelta(content string) []aguievents.JSONPatchOperation {
	var progress taskStepProgress
	if json.Unmarshal([]byte(content), &progress) != nil {
		return nil
	}
	if progress.CompletedStep == nil || *progress.CompletedStep < 0 {
		return nil
	}
	return []aguievents.JSONPatchOperation{{
		Op:    "replace",
		Path:  fmt.Sprintf("/steps/%d/status", *progress.CompletedStep),
		Value: "completed",
	}}
}

func (t *agenticGenerativeUITranslator) PostRunFinalizationEvents(
	ctx context.Context,
) ([]aguievents.Event, error) {
	finalizer, ok := t.inner.(translator.PostRunFinalizingTranslator)
	if !ok {
		return nil, nil
	}
	return finalizer.PostRunFinalizationEvents(ctx)
}

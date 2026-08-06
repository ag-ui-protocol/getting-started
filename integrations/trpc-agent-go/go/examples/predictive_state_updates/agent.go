package predictivestateupdates

import (
	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/server/agui"
	aguirunner "trpc.group/trpc-go/trpc-agent-go/server/agui/runner"
)

const writeDocumentToolName = "write_document"

func New() example.Spec {
	const instruction = `You are a helpful assistant for writing documents.
To write the document, you MUST use the write_document tool.
You MUST write the full document, even when changing only a few words.
Use markdown formatting to make the document easy to read.
Do not use italic or strike-through formatting because they are reserved for showing changes.
When editing, make minimal changes instead of rewriting every word.
Keep stories short.
After the user accepts or rejects the document, DO NOT repeat it as a message.
Briefly summarize the outcome in at most 2 sentences.
This is the current state of the document: ----
{runtime:document?}
-----`
	return example.Spec{
		Name: "predictive_state_updates",
		Agent: llmagent.New(
			"trpc-agent-go-predictive-state-updates",
			llmagent.WithModel(openai.New("gpt-4o", openai.WithShowToolCallDelta(true))),
			llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
			llmagent.WithInstruction(instruction),
		),
		ServerOptions: []agui.Option{
			agui.WithToolCallDeltaStreamingEnabled(true),
			agui.WithAGUIRunnerOptions(
				aguirunner.WithTranslatorFactory(newPredictiveStateUpdatesTranslator),
			),
		},
	}
}

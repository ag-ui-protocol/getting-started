package toolbasedgenerativeui

import (
	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
)

func New() example.Spec {
	const instruction = `Help the user with writing Haikus. If the user asks for a haiku, use the generate_haiku tool to display the haiku to the user.`
	return example.Spec{
		Name: "tool_based_generative_ui",
		Agent: llmagent.New(
			"trpc-agent-go-tool-based-generative-ui",
			llmagent.WithModel(openai.New("gpt-4o")),
			llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
			llmagent.WithInstruction(instruction),
		),
	}
}

package agenticchat

import (
	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
)

func New() example.Spec {
	const instruction = "You are a helpful assistant."
	return example.Spec{
		Name: "agentic_chat",
		Agent: llmagent.New(
			"trpc-agent-go-agentic-chat",
			llmagent.WithModel(openai.New("gpt-4o")),
			llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
			llmagent.WithInstruction(instruction),
		),
	}
}

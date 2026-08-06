package agenticchatmultimodal

import (
	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
)

func New() example.Spec {
	const instruction = `You are a helpful assistant that can analyze images, audio, video, and documents.

- Analyze any media the user sends and answer their questions about it.
- Be descriptive when analyzing visual content.
- If the user sends multiple files, analyze each one.`
	return example.Spec{
		Name: "agentic_chat_multimodal",
		Agent: llmagent.New(
			"trpc-agent-go-agentic-chat-multimodal",
			llmagent.WithModel(openai.New("gpt-4o")),
			llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
			llmagent.WithInstruction(instruction),
		),
	}
}

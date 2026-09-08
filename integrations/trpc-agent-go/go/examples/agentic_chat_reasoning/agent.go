package agenticchatreasoning

import (
	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/server/agui"
)

func New() example.Spec {
	reasoningEffort := "high"
	thinkingEnabled := true
	const instruction = `You are a helpful AI assistant with deep reasoning capabilities.

Think step by step through complex problems.
Explain your reasoning clearly.`
	return example.Spec{
		Name: "agentic_chat_reasoning",
		Agent: llmagent.New(
			"trpc-agent-go-agentic-chat-reasoning",
			llmagent.WithModel(openai.New("deepseek-v4-pro")),
			llmagent.WithGenerationConfig(model.GenerationConfig{
				Stream:          true,
				ThinkingEnabled: &thinkingEnabled,
				ReasoningEffort: &reasoningEffort,
			}),
			llmagent.WithInstruction(instruction),
		),
		ServerOptions: []agui.Option{
			agui.WithReasoningContentEnabled(true),
		},
	}
}

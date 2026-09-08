package agenticgenerativeui

import (
	"context"
	"time"

	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/server/agui"
	aguirunner "trpc.group/trpc-go/trpc-agent-go/server/agui/runner"
	"trpc.group/trpc-go/trpc-agent-go/tool"
	"trpc.group/trpc-go/trpc-agent-go/tool/function"
)

type taskStep struct {
	Description string `json:"description" jsonschema:"description=The text of the step in gerund form"`
	Status      string `json:"status" jsonschema:"description=The status of the step,enum=pending,default=pending"`
}

type taskStepsInput struct {
	Steps []taskStep `json:"steps" jsonschema:"description=Exactly 10 task steps"`
}

type taskStepProgress struct {
	CompletedStep *int `json:"completedStep"`
}

const (
	taskStepsStateKey = "steps"
	taskStepsToolName = "generate_task_steps_generative_ui"
)

func generateTaskStepsGenerativeUI(
	ctx context.Context,
	input taskStepsInput,
) (*tool.StreamReader, error) {
	stream := tool.NewStream(len(input.Steps) + 1)
	go func() {
		defer stream.Writer.Close()
		for index := range input.Steps {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
			}
			completedStep := index
			if stream.Writer.Send(tool.StreamChunk{
				Content: taskStepProgress{CompletedStep: &completedStep},
			}, nil) {
				return
			}
		}
		stream.Writer.Send(tool.StreamChunk{
			Content: tool.FinalResultChunk{
				Result: "Executed all task steps for the interface",
			},
		}, nil)
	}()

	return stream.Reader, nil
}

func New() example.Spec {
	stepsTool := function.NewStreamableFunctionTool[taskStepsInput, string](
		generateTaskStepsGenerativeUI,
		function.WithName(taskStepsToolName),
		function.WithDescription(
			"Generate exactly 10 task steps in gerund form for display in the interface.",
		),
	)
	const instruction = `You are a helpful assistant that breaks down tasks into steps.

- When asked to do something, you MUST call the generate_task_steps_generative_ui function.
- Generate exactly 10 steps for the task.
- Each step should be in gerund form (e.g., "Analyzing requirements", "Setting up environment").
- After calling the function, give a brief one-sentence summary with some emojis.
- Do NOT repeat the steps in your response.`
	return example.Spec{
		Name: "agentic_generative_ui",
		Agent: llmagent.New(
			"trpc-agent-go-agentic-generative-ui",
			llmagent.WithModel(openai.New("gpt-4o")),
			llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
			llmagent.WithInstruction(instruction),
			llmagent.WithTools([]tool.Tool{stepsTool}),
		),
		ServerOptions: []agui.Option{
			agui.WithAGUIRunnerOptions(
				aguirunner.WithTranslatorFactory(newAgenticGenerativeUITranslator),
			),
		},
	}
}

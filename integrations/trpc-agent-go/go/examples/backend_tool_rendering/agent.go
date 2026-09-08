package backendtoolrendering

import (
	"context"

	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/tool"
	"trpc.group/trpc-go/trpc-agent-go/tool/function"
)

type weatherInput struct {
	Location string `json:"location" jsonschema:"description=City name"`
}

type weatherOutput struct {
	Temperature float64 `json:"temperature"`
	FeelsLike   float64 `json:"feels_like"`
	Humidity    float64 `json:"humidity"`
	WindSpeed   float64 `json:"wind_speed"`
	WindGust    float64 `json:"windGust"`
	Conditions  string  `json:"conditions"`
	Location    string  `json:"location"`
}

func getWeather(_ context.Context, input weatherInput) (weatherOutput, error) {
	return weatherOutput{
		Temperature: 21,
		FeelsLike:   20,
		Humidity:    65,
		WindSpeed:   12,
		WindGust:    18,
		Conditions:  "Mainly clear",
		Location:    input.Location,
	}, nil
}

func New() example.Spec {
	weatherTool := function.NewFunctionTool(
		getWeather,
		function.WithName("get_weather"),
		function.WithDescription("Get current weather for a city."),
	)
	const instruction = `You are a helpful weather assistant that provides accurate weather information.

Your primary function is to help users get weather details for specific locations. When responding:
- Always ask for a location if none is provided
- If the location name isn't in English, please translate it
- If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
- Include relevant details like humidity, wind conditions, and precipitation
- Keep responses concise but informative

Use the get_weather tool to fetch current weather data.`
	return example.Spec{
		Name: "backend_tool_rendering",
		Agent: llmagent.New(
			"trpc-agent-go-backend-tool-rendering",
			llmagent.WithModel(openai.New("gpt-4o")),
			llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
			llmagent.WithInstruction(instruction),
			llmagent.WithTools([]tool.Tool{weatherTool}),
		),
	}
}

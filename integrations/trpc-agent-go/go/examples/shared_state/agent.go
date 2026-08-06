package sharedstate

import (
	"context"

	"github.com/ag-ui-protocol/ag-ui/integrations/trpc-agent-go/go/examples/internal/example"

	"trpc.group/trpc-go/trpc-agent-go/agent/llmagent"
	"trpc.group/trpc-go/trpc-agent-go/model"
	"trpc.group/trpc-go/trpc-agent-go/model/openai"
	"trpc.group/trpc-go/trpc-agent-go/server/agui"
	aguirunner "trpc.group/trpc-go/trpc-agent-go/server/agui/runner"
	"trpc.group/trpc-go/trpc-agent-go/tool"
	"trpc.group/trpc-go/trpc-agent-go/tool/function"
)

type recipeIngredient struct {
	Icon   string `json:"icon" jsonschema:"description=The actual emoji for the ingredient,required"`
	Name   string `json:"name" jsonschema:"description=The ingredient name,required"`
	Amount string `json:"amount" jsonschema:"description=The ingredient amount,required"`
}

type recipeState struct {
	Title              string             `json:"title" jsonschema:"description=The recipe title,required"`
	SkillLevel         string             `json:"skill_level" jsonschema:"description=The skill level required for the recipe,enum=Beginner,enum=Intermediate,enum=Advanced,required"`
	CookingTime        string             `json:"cooking_time" jsonschema:"description=The cooking time,enum=5 min,enum=15 min,enum=30 min,enum=45 min,enum=60+ min,required"`
	SpecialPreferences []string           `json:"special_preferences" jsonschema:"description=The complete list of dietary and cooking preferences,required"`
	Ingredients        []recipeIngredient `json:"ingredients" jsonschema:"description=The complete ingredient list,required"`
	Instructions       []string           `json:"instructions" jsonschema:"description=The complete cooking instruction list,required"`
}

type generateRecipeInput struct {
	Recipe recipeState `json:"recipe" jsonschema:"description=The complete updated recipe,required"`
}

const generateRecipeToolName = "generate_recipe"

func generateRecipe(_ context.Context, _ generateRecipeInput) (string, error) {
	return "Recipe updated", nil
}

func New() example.Spec {
	generateRecipeTool := function.NewFunctionTool(
		generateRecipe,
		function.WithName(generateRecipeToolName),
		function.WithDescription(
			"Using the existing (if any) ingredients and instructions, proceed with the recipe to finish it. Make sure the recipe is complete. ALWAYS provide the entire recipe, not just the changes.",
		),
	)
	const instruction = `You are a helpful assistant for creating recipes.

This is the current state of the recipe: {runtime:recipe?}.
You can improve the recipe by calling the generate_recipe tool.

IMPORTANT:
1. Create a recipe using the existing ingredients and instructions. Make sure the recipe is complete.
2. For ingredients, append new ingredients to the existing ones.
3. For instructions, append new steps to the existing ones.
4. 'ingredients' is always an array of objects with 'icon', 'name', and 'amount' fields
5. 'instructions' is always an array of strings
6. For the 'icon' field in ingredients, ALWAYS use actual Unicode emoji characters (like 🥕 🍅 🧅 🥖 🧈 🥛 🧂 etc.), NEVER use text, ANSI codes, or placeholders

If you have just created or modified the recipe, just answer in one sentence what you did. dont describe the recipe, just say what you did.`
	return example.Spec{
		Name: "shared_state",
		Agent: llmagent.New(
			"trpc-agent-go-shared-state",
			llmagent.WithModel(openai.New("gpt-4o", openai.WithShowToolCallDelta(true))),
			llmagent.WithGenerationConfig(model.GenerationConfig{Stream: true}),
			llmagent.WithInstruction(instruction),
			llmagent.WithTools([]tool.Tool{generateRecipeTool}),
		),
		ServerOptions: []agui.Option{
			agui.WithToolCallDeltaStreamingEnabled(true),
			agui.WithAGUIRunnerOptions(
				aguirunner.WithTranslatorFactory(newSharedStateTranslator),
			),
		},
	}
}

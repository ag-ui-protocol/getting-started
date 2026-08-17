using System.Text.Json.Nodes;

namespace AGUI.A2UI;

/// <summary>
/// Canonical tool definitions and descriptions shared by all A2UI adapters.
/// </summary>
public static class A2UIToolDefinitions
{
    /// <summary>
    /// Gets the planner-facing description of the <c>generate_a2ui</c> tool.
    /// </summary>
    public const string GenerateA2UIToolDescription =
        "Generate or update a dynamic A2UI surface based on the conversation. " +
        "A secondary LLM designs the UI components and data. " +
        "Use intent='create' (default) when the user requests new visual content " +
        "(cards, forms, lists, dashboards, comparisons, etc.). " +
        "Use intent='update' with target_surface_id to modify a surface you " +
        "previously rendered (e.g. 'change the second card's price', " +
        "'add a Buy button', 'use red instead of blue').";

    /// <summary>
    /// Gets the planner-facing description of the <c>generate_a2ui</c> tool's <c>intent</c> argument.
    /// </summary>
    public const string IntentArgumentDescription =
        "'create' to render a new surface; 'update' to modify a surface " +
        "previously rendered in this conversation. Defaults to 'create'.";

    /// <summary>
    /// Gets the planner-facing description of the <c>generate_a2ui</c> tool's
    /// <c>target_surface_id</c> argument.
    /// </summary>
    public const string TargetSurfaceIdArgumentDescription =
        "Required when intent='update'. The surface id of the prior render to modify.";

    /// <summary>
    /// Gets the planner-facing description of the <c>generate_a2ui</c> tool's <c>changes</c> argument.
    /// </summary>
    public const string ChangesArgumentDescription =
        "Optional natural-language description of the changes to apply when intent='update'.";

    /// <summary>
    /// Creates the OpenAI-style function definition of the inner <c>render_a2ui</c>
    /// structured-output tool (<c>surfaceId</c>, <c>components</c>, <c>data</c>;
    /// <c>surfaceId</c> and <c>components</c> required).
    /// </summary>
    /// <returns>A fresh, caller-owned <see cref="JsonObject"/> with the tool definition.</returns>
    public static JsonObject CreateRenderA2UIToolDefinition() => new()
    {
        ["type"] = "function",
        ["function"] = new JsonObject
        {
            ["name"] = A2UIConstants.RenderA2UIToolName,
            ["description"] =
                "Render a dynamic A2UI v0.9 surface. The root component must have " +
                "id 'root'. Use components from the available catalog only.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject
                {
                    ["surfaceId"] = new JsonObject
                    {
                        ["type"] = "string",
                        ["description"] = "Unique surface identifier.",
                    },
                    ["components"] = new JsonObject
                    {
                        ["type"] = "array",
                        ["description"] =
                            "A2UI v0.9 component array (flat format). The root " +
                            "component must have id 'root'.",
                        ["items"] = new JsonObject { ["type"] = "object" },
                    },
                    ["data"] = new JsonObject
                    {
                        ["type"] = "object",
                        ["description"] =
                            "Optional initial data model for the surface (form " +
                            "values, list items for data-bound components, etc.).",
                    },
                },
                ["required"] = new JsonArray("surfaceId", "components"),
            },
        },
    };

    /// <summary>
    /// Fills canonical defaults for every unset or empty-string field of
    /// <paramref name="parameters"/>. Empty strings fall back to defaults rather than
    /// propagating into tool advertisements or emitted operations.
    /// </summary>
    /// <param name="parameters">The raw parameters, or <see langword="null"/> for all defaults.</param>
    /// <returns>The resolved parameters.</returns>
    public static A2UIResolvedToolParams ResolveA2UIToolParams(A2UIToolParams? parameters) => new(
        Guidelines: parameters?.Guidelines,
        DefaultSurfaceId: DefaultOr(parameters?.DefaultSurfaceId, A2UIConstants.DefaultSurfaceId),
        DefaultCatalogId: DefaultOr(parameters?.DefaultCatalogId, A2UIConstants.BasicCatalogId),
        ToolName: DefaultOr(parameters?.ToolName, A2UIConstants.GenerateA2UIToolName),
        ToolDescription: DefaultOr(parameters?.ToolDescription, GenerateA2UIToolDescription),
        Catalog: parameters?.Catalog,
        Recovery: parameters?.Recovery,
        OnAttempt: parameters?.OnAttempt);

    private static string DefaultOr(string? value, string fallback)
        => string.IsNullOrEmpty(value) ? fallback : value!;
}

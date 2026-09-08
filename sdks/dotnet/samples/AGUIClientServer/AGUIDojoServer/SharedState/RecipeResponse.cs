using System.Text.Json.Serialization;

namespace AGUIDojoServer.SharedState;

#pragma warning disable CA1812 // Used for the JsonSchema response format
internal sealed class RecipeResponse
#pragma warning restore CA1812
{
    [JsonPropertyName("recipe")]
    public Recipe Recipe { get; set; } = new();
}
